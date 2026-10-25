import type { Conclusion, EvidenceRef, SourceInput } from "./contracts";
import { signedDecimalCents } from "./money";

export type CustomerIdentity = { customerId: string; legalName: string; aliases: readonly string[] };
type Field = "customerId" | "customerName" | "documentNumber" | "currency" | "total" | "amountCents" | "status" | "subtotal" | "discount" | "tax" | "shipping";
type Value = { value: string; quote: string };
const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const labelKey = (s: string) => normalized(s).replace(/[ ._#-]/g, "");
const LABELS: Record<string, Field> = {
  customerid: "customerId", clientid: "customerId", accountid: "customerId",
  customer: "customerName", customername: "customerName", billto: "customerName", billedto: "customerName", soldto: "customerName", client: "customerName",
  documentnumber: "documentNumber", invoicenumber: "documentNumber", invoiceno: "documentNumber", invoice: "documentNumber", invno: "documentNumber",
  creditmemonumber: "documentNumber", creditmemono: "documentNumber", creditnotenumber: "documentNumber", creditnoteno: "documentNumber", creditnumber: "documentNumber",
  currency: "currency", total: "total", grandtotal: "total", invoicetotal: "total", credittotal: "total", totalamount: "total", amountcents: "amountCents",
  status: "status", subtotal: "subtotal", discount: "discount", tax: "tax", salestax: "tax", shipping: "shipping",
};
const moneyFields = new Set<Field>(["total", "subtotal", "discount", "tax", "shipping"]);
const titlePattern = /^(?:(DRAFT|PRO[ -]?FORMA)\s+)?(INVOICE|TAX INVOICE|CREDIT MEMO|CREDIT NOTE)(?:\s+(?:NO\.?\s*|NUMBER\s*|#\s*)?[:#]?\s*([A-Z0-9][A-Z0-9./_-]*))?\s*$/i;
const foreignCurrency = /\b(?:EUR|GBP|CAD|AUD|JPY|CHF|CNY|NZD|SGD|HKD|INR|SEK|NOK|DKK|ZAR|MXN|BRL|KRW|AED|SAR|PLN)\s*-?\s*[\d$]|[€£¥]|(?:CA|AU|NZ|SG|HK)\$/i;

/** Reads explicit labels, including PDF label/value lines. No filename facts or inferred totals. */
export function extractTextDocument(source: SourceInput, ref: EvidenceRef, customers: readonly CustomerIdentity[] = []) {
  const lines = [...source.text.matchAll(/[^\r\n]+/g)].map((m) => ({ raw: m[0], value: m[0].trim(), start: m.index!, end: m.index! + m[0].length })).filter((l) => l.value);
  const fields = new Map<Field, Value[]>();
  const titles: { kind: "invoice" | "credit"; draft: boolean; quote: string }[] = [];
  const add = (field: Field, value: string, quote: string) => fields.set(field, [...fields.get(field) ?? [], { value: value.trim(), quote }]);
  const titleQuotes = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const title = titlePattern.exec(line.value);
    if (title && !/^(?:date|number|no\.?|total|amount|status|currency|due|reference)$/i.test(title[3] ?? "")) {
      titles.push({ kind: /credit/i.test(title[2]!) ? "credit" : "invoice", draft: Boolean(title[1]), quote: line.raw });
      titleQuotes.add(line.raw);
      if (title[3]) add("documentNumber", title[3], line.raw);
      continue;
    }
    const inline = /^([A-Za-z][A-Za-z ._#-]{0,40}?)\s*(?::|\t+| {2,})\s*(\S.*?)\s*$/.exec(line.value);
    const field = LABELS[labelKey(inline?.[1] ?? line.value)];
    if (!field) continue;
    if (inline) add(field, inline[2]!, line.raw);
    else {
      const next = lines[i + 1];
      if (next && !LABELS[labelKey(next.value)] && !/^=== Page|^Page \d+|^\f/.test(next.value)) {
        add(field, next.value, source.text.slice(line.start, next.end)); i++;
      }
    }
  }
  // Email/statement titles are classified before incidental mentions of an invoice.
  const support = /^(?:CUSTOMER STATEMENT|ACCOUNT STATEMENT|STATEMENT OF ACCOUNT|BANK STATEMENT|BANK EXPORT|BANK DEPOSIT|STATEMENT|EMAIL|SUPPORTING DOCUMENT)(?:\s|$)/i;
  const supportLine = lines.slice(0, 15).find((l) => support.test(l.value));
  const mail = /^(?:message\/rfc822|application\/mbox)$/i.test(source.mimeType) || /\.(?:eml|msg|mbox)$/i.test(source.name) || lines.slice(0, 5).some((l) => /^(?:From|Subject):/i.test(l.value));
  const baseEvidence = [{ ...ref, quote: source.text.trim().slice(0, 500) || undefined }];
  if (mail || supportLine) return { supported: true, customers: [], conclusion: {
    treatment: "exclude", reason: "Supporting email, statement or bank evidence is not an issued invoice or credit memo.", evidence: [{ ...ref, quote: supportLine?.raw ?? baseEvidence[0]!.quote }], contradictions: [], missingEvidence: [], category: "supporting_document",
  } satisfies Conclusion };
  if (!titles.length) return undefined;

  const contradictions: string[] = [], missingEvidence: string[] = [];
  const quotes = new Set<string>(titleQuotes);
  const one = (field: Field): string | undefined => {
    const entries = fields.get(field) ?? [];
    entries.forEach((v) => quotes.add(v.quote));
    const values = new Set(entries.map((v) => moneyFields.has(field) ? signedDecimalCents(v.value) ?? `invalid:${v.value}` : normalized(v.value)));
    if (values.size > 1) {
      contradictions.push(`Conflicting ${field} values appear in the source; no value was selected.`);
      missingEvidence.push(`One authoritative ${field}`); return undefined;
    }
    if (entries.length > 1) contradictions.push(`Repeated ${field} fields in source agree; verify that this is one document.`);
    return entries[0]?.value;
  };
  const kinds = new Set(titles.map((t) => t.kind));
  if (kinds.size > 1) missingEvidence.push("Separate invoice and credit memo source documents");
  if (new Set(titles.map((t) => t.draft)).size > 1) missingEvidence.push("One authoritative issued document, separate from the draft");
  const credit = kinds.size === 1 && kinds.has("credit");
  const documentNumber = one("documentNumber");
  let customerId = one("customerId"), customerName = one("customerName");
  if (customers.length) {
    const named = customerName ? customers.filter((c) => [c.legalName, ...c.aliases].some((n) => normalized(n) === normalized(customerName!))) : [];
    const identified = customerId ? customers.filter((c) => normalized(c.customerId) === normalized(customerId!)) : [];
    const candidates = customerId ? identified : named;
    if (candidates.length !== 1 || customerName && (named.length !== 1 || named[0]!.customerId !== candidates[0]?.customerId)) {
      missingEvidence.push("An unambiguous customer ID and name/alias matching the customer registry");
      contradictions.push("Printed customer identity does not uniquely match the registered customer records.");
    } else {
      customerId = candidates[0]!.customerId;
      customerName = candidates[0]!.legalName;
    }
  }
  const total = one("total"), rawCents = one("amountCents"), currency = one("currency"), status = one("status");
  const centsNumber = rawCents && /^\d{1,16}$/.test(rawCents) && BigInt(rawCents) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rawCents) : undefined;
  const signedTotal = total === undefined ? centsNumber : signedDecimalCents(total);
  let amountCents = signedTotal === undefined ? undefined : credit ? Math.abs(signedTotal) : signedTotal;
  if (total !== undefined && rawCents !== undefined && centsNumber !== Math.abs(signedTotal ?? NaN)) {
    contradictions.push("Printed total disagrees with amountCents"); missingEvidence.push("A corrected, consistent final total"); amountCents = undefined;
  }
  // A balance due can differ after partial payment. Never substitute it for a printed total.
  if (!documentNumber) missingEvidence.push("An explicit invoice or credit memo number");
  if (!customerId || !customerName) missingEvidence.push("A customer ID and name, or a unique registered customer alias");
  if (amountCents === undefined || amountCents <= 0) missingEvidence.push("One unambiguous positive final document total (not the remaining balance)");
  if (currency && currency.toUpperCase() !== "USD" || foreignCurrency.test(source.text)) {
    missingEvidence.push("A USD document; foreign or mixed currencies cannot be included in this workspace");
  } else if (!currency && !/\bUSD\b|US\$/i.test(total ?? "")) {
    if (/\$/.test(total ?? "")) contradictions.push("The printed $ symbol does not specify USD. Confirm USD currency before accepting this proposal.");
    else missingEvidence.push("Explicit USD currency");
  }
  const components = Object.fromEntries((["subtotal", "discount", "tax", "shipping"] as const).map((f) => {
    const value = one(f); return [f, value === undefined ? undefined : signedDecimalCents(value)];
  }));
  if (signedTotal !== undefined && ["subtotal", "discount", "tax"].every((f) => fields.has(f as Field))) {
    if (["subtotal", "discount", "tax", ...(fields.has("shipping") ? ["shipping"] : [])].some((f) => components[f] === undefined)) missingEvidence.push("Readable and consistent subtotal, discount, tax and shipping fields");
    else if (BigInt(components.subtotal!) - BigInt(components.discount!) + BigInt(components.tax!) + BigInt(components.shipping ?? 0) !== BigInt(signedTotal)) {
      contradictions.push("Printed subtotal minus discount plus tax and shipping does not equal the printed total; the total was not recomputed.");
    }
  }
  if (/\b(?:supersed(?:e|es|ed)|replaces?|revised|contradict\w*|disputed|unconfirmed)\b/i.test(source.text)) contradictions.push("Source contains a revision or conflict claim requiring a human decision; it does not authorize replacement");
  const voided = /^(?:void|voided|cancelled|canceled)$/i.test(status ?? "");
  const draft = titles.every((t) => t.draft) || /^(?:draft|pro[ -]?forma)$/i.test(status ?? "");
  if (status && !/^(?:issued|final|open|paid|partial|partially paid|credit|void|voided|cancelled|canceled|draft|pro[ -]?forma)$/i.test(status)) contradictions.push(`Document status “${status}” is not a verified issued status`);
  const evidence = [...quotes].slice(0, 20).map((quote) => ({ ...ref, quote }));
  // A clear void/draft is excluded even if financial fields are incomplete. Conflicting identity/status is never guessed.
  if ((voided || draft) && !missingEvidence.some((v) => /authoritative|Separate/.test(v))) return { supported: true, customers: [], conclusion: {
    treatment: "exclude", reason: draft ? "Source explicitly identifies a draft or pro forma, not an issued invoice." : "Source explicitly marks this document void or cancelled.", evidence, contradictions, missingEvidence: [], documentNumber, customerId, customerName,
  } satisfies Conclusion };
  const conclusion: Conclusion = {
    treatment: missingEvidence.length ? "needs_evidence" : credit ? "include_credit" : "include_invoice",
    customerId, customerName, documentNumber, ...(amountCents !== undefined && amountCents > 0 ? { amountCents } : {}),
    reason: missingEvidence.length ? "Explicit fields were extracted, but missing or conflicting evidence prevents inclusion." : `Printed ${credit ? "credit memo" : "invoice"} fields extracted with exact cents and source quotations; non-routine layouts require human review.`,
    evidence, contradictions, missingEvidence: [...new Set(missingEvidence)],
    ...(missingEvidence.length ? { question: `Please supply ${[...new Set(missingEvidence)].join("; ")} for “${source.name}”.` }
      : contradictions.length ? { question: `Review ${documentNumber} for ${customerName}, proposed USD ${(amountCents! / 100).toFixed(2)}: ${contradictions.join(" ")} Confirm this exact treatment, exclude, or request corrected evidence.` } : {}),
  };
  return { supported: !missingEvidence.length, customers: [], conclusion };
}
