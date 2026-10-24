import { z } from "zod";

export const ParsedLine = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.number(),
  unitCents: z.number().int(),
  amountCents: z.number().int(),
});

export const ParsedInvoice = z.object({
  vendorName: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  storeId: z.string(),
  deliveryId: z.string().nullable(),
  lines: z.array(ParsedLine).min(1),
  totalCents: z.number().int(),
  remitBank: z.string().nullable(),
  remitLast4: z.string().nullable(),
  note: z.string().nullable(),
});
export type ParsedInvoice = z.infer<typeof ParsedInvoice>;

/** A parse is only trusted if its arithmetic holds. Wrong numbers are worse than no numbers. */
export function checkInvoiceMath(inv: ParsedInvoice): string | null {
  for (const [i, l] of inv.lines.entries()) {
    if (Math.round(l.quantity * l.unitCents) !== l.amountCents) return `line ${i + 1} (${l.sku}): ${l.quantity} x ${l.unitCents} != ${l.amountCents}`;
  }
  const sum = inv.lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== inv.totalCents) return `lines sum to ${sum}, total says ${inv.totalCents}`;
  return null;
}

/** Shape signature of a document, used to tell "a format we haven't seen" from a one-off. */
export function layoutSignature(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  if (/^H\|/.test(first)) return "pipe";
  if (/^Vendor:/.test(first)) return "keyvalue";
  if (/INVOICE\s+Invoice #:/.test(text)) return "columnar";
  if (/: Invoice \S+$/.test(first)) return "narrative";
  return `unknown:${first.replace(/[^A-Za-z|:]/g, "").slice(0, 12)}`;
}
