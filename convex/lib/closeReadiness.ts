import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { canonical, sha256Hex } from "./kernel";

export interface CloseSourceBlocker {
  kind: "unprocessed_invoice" | "held_bill" | "missing_accrual" | "multiple_bills";
  documentEventId?: string;
  externalId?: string;
  billId?: string;
  reason: string;
}

/**
 * Intake dates are authoritative before an invoice can be read. Every invoice
 * received through the period end needs a kernel disposition, including prior
 * periods' unresolved sources. A successful task/telemetry message is not one.
 */
export async function readCloseReadiness(ctx: QueryCtx, runId: string, period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("period must be YYYY-MM");
  const through = `${period}-31`;
  const documents = (await ctx.db.query("events")
    .withIndex("by_run_type", (q) => q.eq("runId", runId).eq("type", "document.received"))
    .filter((q) => q.lte(q.field("occurredOn"), through)).collect())
    .filter((e) => e.payload?.kind === "invoice" || e.payload?.kind === "lease_invoice");
  const bills = await ctx.db.query("bills")
    .withIndex("by_run_vendor_invoice", (q) => q.eq("runId", runId)).collect();
  const byId = new Map(bills.map((b) => [String(b._id), b]));
  const byDocument = new Map<string, Doc<"bills">[]>();
  for (const bill of bills) {
    const linked = byDocument.get(bill.documentEventId) ?? [];
    linked.push(bill);
    byDocument.set(bill.documentEventId, linked);
  }
  const violations = await ctx.db.query("violations")
    .withIndex("by_run_at", (q) => q.eq("runId", runId)).collect();
  const duplicateOf = new Map<string, Doc<"bills">>();
  for (const violation of violations) {
    if (violation.operation !== "ap.recordBill" || !violation.reason.startsWith("duplicate_invoice:") ||
      !violation.sourceDocumentId || !violation.relatedBillId) continue;
    const original = byId.get(violation.relatedBillId);
    if (original) duplicateOf.set(violation.sourceDocumentId, original);
  }
  const blockers: CloseSourceBlocker[] = [];
  const reviewed = new Map<string, Doc<"bills">>();
  const entries = new Map<string, Doc<"journalEntries"> | null>();
  const checked = new Set<string>();
  const checkBill = async (bill: Doc<"bills">) => {
    if (checked.has(bill._id)) return;
    checked.add(bill._id);
    reviewed.set(bill._id, bill);
    if (bill.status === "held") {
      blockers.push({ kind: "held_bill", billId: bill._id, documentEventId: bill.documentEventId,
        reason: `${bill.vendor} ${bill.invoiceNumber} is held for review` });
    } else if (bill.status === "approved" || bill.status === "paid") {
      const entry = bill.entryId ? await ctx.db.get(bill.entryId) : null;
      entries.set(bill._id, entry);
      const apCredit = entry?.lines.filter((l) => l.account === "2000")
        .reduce((sum, l) => sum + l.credit - l.debit, 0);
      if (!entry || entry.runId !== runId || entry.status !== "posted" || entry.source.kind !== "bill" ||
        entry.source.ref !== bill._id || entry.date !== bill.invoiceDate || apCredit !== bill.totalCents) {
        blockers.push({ kind: "missing_accrual", billId: bill._id, documentEventId: bill.documentEventId,
          reason: `${bill.vendor} ${bill.invoiceNumber} has no matching live accrual` });
      }
    }
    // A rejected bill is the authenticated kernel's explicit disposition.
  };
  const dispositions: { documentId: string; billIds: string[]; duplicateOf?: string }[] = [];
  for (const document of documents) {
    const linked = byDocument.get(document._id) ?? [];
    const duplicate = linked.length ? undefined : duplicateOf.get(document._id);
    dispositions.push({ documentId: document._id, billIds: linked.map((b) => b._id).sort(), duplicateOf: duplicate?._id });
    if (!linked.length && !duplicate) {
      blockers.push({ kind: "unprocessed_invoice", documentEventId: document._id, externalId: document.externalId,
        reason: `Invoice ${document.externalId} is unreadable or has no recorded disposition` });
    }
    if (linked.filter((b) => b.status !== "rejected").length > 1) {
      blockers.push({ kind: "multiple_bills", documentEventId: document._id, externalId: document.externalId,
        reason: `Invoice ${document.externalId} backs multiple live bills` });
    }
    for (const bill of duplicate ? [duplicate] : linked) await checkBill(bill);
  }
  // Backdated bills and held obligations still matter even if their source was
  // received later, or a historical bill predates source-event enforcement.
  for (const bill of bills.filter((b) => b.invoiceDate <= through)) await checkBill(bill);
  const head = await ctx.db.query("ledgerHeads").withIndex("by_run", (q) => q.eq("runId", runId)).unique();
  const snapshotHash = await sha256Hex(canonical({
    runId, period, ledgerHead: head?.hash ?? "genesis",
    documents: documents.map((d) => ({ id: d._id, occurredOn: d.occurredOn })).sort((a, b) => a.id.localeCompare(b.id)),
    dispositions: dispositions.sort((a, b) => a.documentId.localeCompare(b.documentId)),
    bills: [...reviewed.values()].map((b) => ({ id: b._id, status: b.status, entryId: b.entryId,
      documentEventId: b.documentEventId, invoiceDate: b.invoiceDate, totalCents: b.totalCents,
      decisionPath: b.decisionPath, exceptions: b.exceptions, accrualHash: entries.get(b._id)?.hash,
      accrualStatus: entries.get(b._id)?.status })).sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return { period, ready: blockers.length === 0, sourceInvoiceCount: documents.length,
    blockerCount: blockers.length, blockers: blockers.slice(0, 25), snapshotHash };
}
