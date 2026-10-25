/** Maps the APEX World 9 contract-attorney invoice layout from native PDF words. Never reads ledger answers. */
import type { TextPage, TextWord } from "./text-layer";

export type MappedField = { fieldPath: string; rawValue: string; normalizedValue: string | number; words: TextWord[] };
export type MappedInvoice = {
  supplierName: string; invoiceNumber: string; invoiceDate: string; dueDate: string | null; terms: string | null;
  matterReference: string; currency: "USD"; subtotalCents: number; totalCents: number;
  lines: { lineId: string; serviceDate: string; description: string; hours: string; rateCents: number; amountCents: number }[];
  fields: MappedField[]; warnings: string[];
};
export type MapResult = { ok: true; invoice: MappedInvoice } | { ok: false; reason: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;
const join = (words: TextWord[]) => words.map(w => w.text).join(" ");
const byPosition = (a: TextWord, b: TextWord) => a.yMin - b.yMin || a.xMin - b.xMin;
const sameLine = (a: TextWord, b: TextWord) => near(a.yMin, b.yMin, 1.5);
export function moneyCents(text: string): number | null {
  const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text);
  return m ? Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]) : null;
}
function longDate(text: string): string | null {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text);
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) + 1 : 0;
  if (!m || !month) return null;
  const iso = `${m[3]}-${String(month).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
function slashDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}
/** Normalizes "15.0" to "15" and "17.50" to "17.5" without floating point. */
export function decimalString(text: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return `${Number(m[1])}${frac ? "." + frac : ""}`;
}
/** Words that follow a label ("Invoice Date:") on the same line, up to the next column gap. */
function labelValue(words: TextWord[], label: string[], maxGap = 24): { label: TextWord[]; value: TextWord[] } | null {
  for (let i = 0; i + label.length <= words.length; i++) {
    const head = words.slice(i, i + label.length);
    if (head.every((w, j) => w.text === label[j]) && head.every(w => sameLine(w, head[0]!))) {
      const last = head.at(-1)!;
      const value: TextWord[] = [];
      for (const w of words.slice(i + label.length)) {
        if (!sameLine(w, last) || w.xMin < last.xMax) break;
        const prev = value.at(-1) ?? last;
        if (w.xMin - prev.xMax > maxGap) break;
        value.push(w);
      }
      return value.length ? { label: head, value } : null;
    }
  }
  return null;
}

export function mapContractAttorneyInvoice(page: TextPage): MapResult {
  const words = [...page.words].sort(byPosition);
  if (!words.length) return { ok: false, reason: "no_text_layer" };
  const fields: MappedField[] = [];
  const warnings: string[] = [];
  const add = (fieldPath: string, rawWords: TextWord[], normalizedValue: string | number) =>
    fields.push({ fieldPath, rawValue: join(rawWords), normalizedValue, words: rawWords });

  // Supplier: the first printed line before the right-aligned INVOICE title.
  // Legal names can cross the page midpoint (for example Westfield's LLC).
  const first = words[0]!;
  const title = words.find(w => w.text === "INVOICE" && sameLine(w, first) && w.xMin > page.width / 2);
  const supplierWords = words.filter(w => sameLine(w, first) && w.xMax < (title?.xMin ?? page.width / 2));
  const supplierName = join(supplierWords);
  add("extractedSupplierName", supplierWords, supplierName);

  // Invoice number: the right-aligned line directly below "Invoice No.".
  const labelIndex = words.findIndex((w, i) => w.text === "Invoice" && words[i + 1]?.text === "No." && sameLine(w, words[i + 1]!));
  if (labelIndex < 0) return { ok: false, reason: "invoice_number_label_missing" };
  const label = words[labelIndex + 1]!;
  const numberWords = words.filter(w => w.yMin > label.yMax - 1 && w.yMin < label.yMax + 8 && w.xMin > page.width / 2);
  if (numberWords.length !== 1) return { ok: false, reason: "invoice_number_ambiguous" };
  const invoiceNumber = numberWords[0]!.text;
  add("invoiceNumber", numberWords, invoiceNumber);

  const dated = (labelWords: string[], fieldPath: string, required: boolean) => {
    const found = labelValue(words, labelWords);
    const iso = found ? longDate(join(found.value)) : null;
    if (found && iso) add(fieldPath, found.value, iso);
    else if (required) return undefined;
    return iso;
  };
  const invoiceDate = dated(["Invoice", "Date:"], "invoiceDate", true);
  if (!invoiceDate) return { ok: false, reason: "invoice_date_unresolved" };
  const dueDate = dated(["Due", "Date:"], "dueDate", false) ?? null;
  const termsFound = labelValue(words, ["Payment", "Terms:"]);
  const terms = termsFound ? join(termsFound.value) : null;
  if (termsFound) add("terms", termsFound.value, terms!);
  const matter = labelValue(words, ["Matter", "Reference:"]);
  if (!matter || matter.value.length !== 1) return { ok: false, reason: "matter_reference_unresolved" };
  const matterReference = matter.value[0]!.text;

  // Service table: columns are located by their header words; numbers are right-aligned to them.
  const header = (text: string) => words.find(w => w.text === text && words.some(x => x.text === "Description" && sameLine(x, w)));
  const [dateH, descH, hoursH, rateH, amountH] = ["Date", "Description", "Hours", "Rate", "Amount"].map(header);
  if (!dateH || !descH || !hoursH || !rateH || !amountH) return { ok: false, reason: "service_table_header_missing" };
  const subtotal = labelValue(words, ["Subtotal:"], 160);
  const total = labelValue(words, ["Total", "Due:"], 160);
  if (!subtotal || !total || subtotal.value.length !== 1 || total.value.length !== 1) return { ok: false, reason: "totals_unresolved" };
  const subtotalCents = moneyCents(subtotal.value[0]!.text), totalCents = moneyCents(total.value[0]!.text);
  if (subtotalCents === null || totalCents === null) return { ok: false, reason: "totals_unresolved" };
  if (!subtotal.value[0]!.text.startsWith("$") || !total.value[0]!.text.startsWith("$")) return { ok: false, reason: "currency_unresolved" };
  const body = words.filter(w => w.yMin > dateH.yMax && w.yMax < subtotal.label[0]!.yMin);
  const rowStarts = body.filter(w => near(w.xMin, dateH.xMin) && slashDate(w.text));
  if (!rowStarts.length) return { ok: false, reason: "no_service_rows" };
  const lines: MappedInvoice["lines"] = [];
  for (const [index, start] of rowStarts.entries()) {
    const next = rowStarts[index + 1];
    const row = body.filter(w => w !== start && w.yMin >= start.yMin - 1 && (!next || w.yMin < next.yMin - 1));
    const pick = (column: TextWord, accept: (t: string) => boolean) => row.filter(w => near(w.xMax, column.xMax) && accept(w.text));
    const hours = pick(hoursH, t => decimalString(t) !== null), rate = pick(rateH, t => moneyCents(t) !== null), amount = pick(amountH, t => moneyCents(t) !== null);
    if (hours.length !== 1 || rate.length !== 1 || amount.length !== 1) return { ok: false, reason: "service_row_columns_ambiguous" };
    const description = row.filter(w => !hours.includes(w) && !rate.includes(w) && !amount.includes(w) && w.xMin >= descH.xMin - 1).sort(byPosition);
    if (!description.length) return { ok: false, reason: "service_row_description_missing" };
    if (description.some(w => w.xMax > hoursH.xMin)) warnings.push(`Row ${index + 1} description overlaps the Hours/Rate/Amount columns in the original; numbers were taken by right-edge column alignment.`);
    const lineId = `L${index + 1}`;
    const line = { lineId, serviceDate: slashDate(start.text)!, description: join(description), hours: decimalString(hours[0]!.text)!, rateCents: moneyCents(rate[0]!.text)!, amountCents: moneyCents(amount[0]!.text)! };
    lines.push(line);
    add(`lines.${lineId}.sku`, matter.value, matterReference);
    add(`lines.${lineId}.description`, description, line.description);
    add(`lines.${lineId}.quantity`, hours, line.hours);
    add(`lines.${lineId}.unitPriceCents`, rate, line.rateCents);
    add(`lines.${lineId}.amountCents`, amount, line.amountCents);
  }
  add("subtotalCents", subtotal.value, subtotalCents);
  add("totalCents", total.value, totalCents);
  warnings.push("The invoice prints no SKU column; each service line uses the printed Matter Reference as its service item identifier.");
  warnings.push("Currency is read from the printed $ symbol; the invoice states no ISO currency code.");
  return { ok: true, invoice: { supplierName, invoiceNumber, invoiceDate, dueDate, terms, matterReference, currency: "USD", subtotalCents, totalCents, lines, fields, warnings } };
}

/** "Key: value" pairs from a single-column document, such as the replay's labeled simulated documents. */
export function keyValues(page: TextPage): Map<string, { value: string; words: TextWord[] }> {
  const out = new Map<string, { value: string; words: TextWord[] }>();
  const words = [...page.words].sort(byPosition);
  const lines: TextWord[][] = [];
  for (const w of words) {
    const line = lines.at(-1);
    if (line && sameLine(line[0]!, w)) line.push(w);
    else lines.push([w]);
  }
  for (const line of lines) {
    const k = line.findIndex(w => w.text.endsWith(":"));
    if (k < 0 || k === line.length - 1) continue;
    const key = join(line.slice(0, k + 1)).slice(0, -1);
    if (!out.has(key)) out.set(key, { value: join(line.slice(k + 1)), words: line.slice(k + 1) });
  }
  return out;
}
