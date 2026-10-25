import type { ProviderOutput } from "./provider";
import { cellNativeRegions, decode, normalize, type NativeRegion } from "./grounding";

export type SourceReading = { path: string; value: string; page: number; hint?: NativeRegion };
const plain = (value: unknown) => decode(String(value ?? "")).replace(/\*\*/g, "").replace(/^#{1,6}\s+/, "").trim();
const headers: [string, RegExp][] = [
  ["supplierName", /^(?:Supplier|Vendor)(?:\s*:\s*|\s+)(.+)$/i],
  ["invoiceNumber", /^Invoice\s*(?:no\.?|number|#)(?:\s*:\s*|\s+)(.+)$/i],
  ["invoiceDate", /^Invoice date(?:\s*:\s*|\s+)(.+)$/i],
  ["dueDate", /^Due date(?:\s*:\s*|\s+)(.+)$/i],
  ["orderReference", /^(?:Order ref\.?|PO reference)(?:\s*:\s*|\s+)(.+)$/i],
  ["subtotal", /^Subtotal(?:\s*:\s*|\s+)(.+)$/i],
  ["tax", /^(?:GST(?: at \d+(?:\.\d+)?%)?|Tax)(?:\s*:\s*|\s+)(.+)$/i],
  ["totalDue", /^Total due(?:\s*:\s*|\s+)(.+)$/i],
  ["currency", /^Currency(?:\s*:\s*|\s+)(.+)$/i],
];
const columns: Record<string, string> = {
  "#": "rowNumber", description: "description", qty: "quantity", quantity: "quantity",
  "unit price": "unitPrice", amount: "amount", sku: "sku", uom: "unit",
};

/** Lossless source readings for review, never a payable, supplier identity or USD conversion.
 * The canonical mapper remains responsible for currency, units, totals and business support.
 */
export function sourceReadings(output: ProviderOutput): SourceReading[] {
  const readings: SourceReading[] = [];
  const occurrences = new Map<string, number>();
  const add = (name: string, value: string, page: number, hint?: NativeRegion) => {
    if (!value) return;
    const count = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, count);
    readings.push({ path: `source.${name}${count > 1 ? `.occurrence-${count}` : ""}`, value, page, hint });
  };
  let tableNumber = 0;
  for (const page of output.result.items?.pages ?? []) {
    const items = page.items ?? [];
    for (const [index, item] of items.entries()) {
      const text = plain(item.md ?? item.value ?? "");
      if (item.type === "heading") {
        // A heading is not sufficient evidence of a verified supplier.
        if (!readings.length && text && !/^(?:tax\s+)?invoice$/i.test(text)) add("documentHeading", text, page.page_number);
        if (/^bill to:?$/i.test(text)) {
          const next = items[index + 1];
          if (next?.type === "text") add("billTo", plain(next.md ?? next.value).split(/\r?\n/)[0]!, page.page_number);
        }
      }
      if (item.type === "text") for (const line of text.split(/\r?\n/)) {
        for (const [field, pattern] of headers) {
          const match = pattern.exec(plain(line));
          if (!match) continue;
          const value = match[1]!.trim();
          // Do not treat "Tax no." or explanatory prose as an amount.
          if (["subtotal", "tax", "totalDue"].includes(field) && !/^(?:[₹$€£]\s*|(?:USD|INR|EUR|GBP)\s*)?\d[\d,.]*$/.test(value)) continue;
          add(field, value, page.page_number);
        }
      }
      if (item.type !== "table" || !Array.isArray(item.rows?.[0])) continue;
      const labels = item.rows[0].map((cell: unknown) => plain(cell).toLowerCase());
      // Preserve invoice-like tables, including layouts without SKU or unit columns.
      if (!labels.includes("description") || !labels.some((label: string) => /^(?:amount|amount usd|line total)$/.test(label))) continue;
      tableNumber++;
      const grounded = output.grounded.find(p => p.page_number === page.page_number)?.items?.[index];
      for (let row = 1; row < item.rows.length; row++) {
        if (!Array.isArray(item.rows[row])) continue;
        for (let column = 0; column < item.rows[row].length; column++) {
          const value = plain(item.rows[row][column]);
          const raw = String(grounded?.rows?.[row]?.[column] ?? "");
          const cell = grounded?.grounding?.rows?.[row]?.[column];
          const regions = cell ? cellNativeRegions(raw, cell) : undefined;
          const hint = regions && normalize(raw) === normalize(value) ? { text: value, page: page.page_number, regions } : undefined;
          const label = columns[labels[column] ?? ""] ?? `column-${column + 1}`;
          add(`table-${tableNumber}.row-${row}.${label}`, value, page.page_number, hint);
        }
      }
    }
  }
  return readings;
}
