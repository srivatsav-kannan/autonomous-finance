// Output contract shared by both systems, plus writers for the files the scorer reads.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const MONEY = /^-?\d+\.\d{2}$/;

export const CustomerRow = z.object({
  customer_id: z.string(),
  customer_name: z.string(),
  valid_invoice_count: z.number().int(),
  gross_invoice_spend_usd: z.string(),
  credit_memo_total_usd: z.string(),
  net_spend_usd: z.string(),
});
export type CustomerRow = z.infer<typeof CustomerRow>;

export const CATEGORIES = [
  "void",
  "superseded_original",
  "duplicate_scan",
  "statement_summary",
  "email_quoted_total",
  "bank_deposit",
  "credit_memo",
  "reference_only",
  "data_quality",
  "other",
] as const;

export const SuspiciousDoc = z.object({
  path: z.string(),
  document_id: z.string().nullable(),
  customer_id: z.string().nullable(),
  category: z.enum(CATEGORIES),
  treatment: z.enum(["excluded_from_spend", "subtracted_as_credit", "counted_with_flag"]),
  reason: z.string(),
});
export type SuspiciousDoc = z.infer<typeof SuspiciousDoc>;

export const Submission = z.object({
  customers: z.array(CustomerRow),
  suspicious_documents: z.array(SuspiciousDoc),
  notes: z.string(),
});
export type Submission = z.infer<typeof Submission>;

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Writes submission.csv (answer-key column layout), suspicious_documents.{json,csv} and submission.json. */
export function writeSubmission(outDir: string, sub: Submission): void {
  fs.mkdirSync(outDir, { recursive: true });
  const header = ["customer_id", "customer_name", "valid_invoice_count", "gross_invoice_spend_usd", "credit_memo_total_usd", "net_spend_usd"];
  const rows = [...sub.customers]
    .sort((a, b) => a.customer_id.localeCompare(b.customer_id))
    .map((c) => [c.customer_id, c.customer_name, c.valid_invoice_count, c.gross_invoice_spend_usd, c.credit_memo_total_usd, c.net_spend_usd].map(csvCell).join(","));
  fs.writeFileSync(path.join(outDir, "submission.csv"), [header.join(","), ...rows].join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "suspicious_documents.json"), JSON.stringify(sub.suspicious_documents, null, 2) + "\n");
  const sHeader = ["path", "document_id", "customer_id", "category", "treatment", "reason"];
  const sRows = sub.suspicious_documents.map((d) => [d.path, d.document_id, d.customer_id, d.category, d.treatment, d.reason].map(csvCell).join(","));
  fs.writeFileSync(path.join(outDir, "suspicious_documents.csv"), [sHeader.join(","), ...sRows].join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "submission.json"), JSON.stringify(sub, null, 2) + "\n");
}
