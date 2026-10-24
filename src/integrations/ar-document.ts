import { z } from "zod";

// Customer-facing billing documents (invoices, credit memos, statements) as printed.
// Signs are kept as printed: a credit memo's amounts are usually negative.

export const ParsedArLine = z.object({
  sku: z.string().nullable(),
  description: z.string(),
  quantity: z.number(),
  unitCents: z.number().int(),
  amountCents: z.number().int(),
});

export const ParsedArDocument = z.object({
  issuerName: z.string(),
  documentTitle: z.string(),
  documentNumber: z.string(),
  customerName: z.string(),
  customerId: z.string().nullable(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  printedStatus: z.string().nullable(),
  lines: z.array(ParsedArLine),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  notes: z.string().nullable(),
});
export type ParsedArDocument = z.infer<typeof ParsedArDocument>;

/** A parse is trusted only if the printed header adds up. Line-level problems are a finding, not a parse failure. */
export function checkArHeader(d: ParsedArDocument): string | null {
  if (d.subtotalCents - d.discountCents + d.taxCents !== d.totalCents) {
    return `subtotal ${d.subtotalCents} - discount ${d.discountCents} + tax ${d.taxCents} != total ${d.totalCents}`;
  }
  return null;
}

/**
 * Layout signature for documents from one issuer: the issuer stem of the first header line
 * (text before the first "|" or ":"), ignoring page markers that PDF extraction adds.
 */
export function arLayoutSignature(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l && !/^=+ Page \d+ of \d+ =+$/.test(l)) ?? "";
  const stem = first.split(/[|:]/)[0]!.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `ar:${stem || "unknown"}`;
}

/** Line problems on a document we issued: they don't change what was billed, but a person should look. */
export function lineIssues(lines: { quantity: number; unitCents: number; amountCents: number }[], subtotalCents: number): string[] {
  const issues: string[] = [];
  for (const [i, l] of lines.entries()) {
    if (Math.round(l.quantity * l.unitCents) !== l.amountCents) issues.push(`line ${i + 1}: ${l.quantity} x ${l.unitCents} != ${l.amountCents}`);
  }
  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  if (lines.length && sum !== subtotalCents) issues.push(`lines sum to ${sum}, subtotal says ${subtotalCents}`);
  return issues;
}
