import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { account } from "../../src/core/accounts";
import { fail, type Result } from "./kernel";

// Evidence checks: money facts must point at something the company actually received or saw
// at the bank, not at a label the caller chose.

const BILL_DOCUMENTS = new Set(["invoice", "lease_invoice"]);

/** A bill must cite a received vendor document from this run. */
export async function billDocument(ctx: QueryCtx, runId: string, documentEventId: string): Promise<Result<{ event: Doc<"events"> }>> {
  const id = ctx.db.normalizeId("events", documentEventId);
  const event = id ? await ctx.db.get(id) : null;
  if (!event || event.runId !== runId) return fail("no_document", `document ${documentEventId} was never received`);
  if (event.type !== "document.received") return fail("no_document", `${documentEventId} is a ${event.type}, not a document`);
  const kind = (event.payload as { kind?: string } | null)?.kind;
  if (!kind || !BILL_DOCUMENTS.has(kind)) return fail("not_a_bill", `document ${documentEventId} is a ${kind ?? "document"}, not an invoice`);
  return { ok: true, event };
}

/**
 * A cash entry must cite a real bank transaction whose amount equals the entry's net cash
 * movement, and each bank transaction can back only one live entry.
 */
export async function bankEvidence(
  ctx: QueryCtx,
  runId: string,
  ref: string | undefined,
  lines: { account: string; debit: number; credit: number }[],
): Promise<Result<{ event: Doc<"events"> }>> {
  if (!ref) return fail("no_bank_evidence", "cash entries must cite a bank transaction");
  const event = await ctx.db
    .query("events")
    .withIndex("by_run_external", (q) => q.eq("runId", runId).eq("externalId", ref))
    .unique();
  if (!event || event.type !== "bank.transaction") return fail("no_bank_evidence", `no bank transaction ${ref}`);
  const amount = (event.payload as { amountCents?: number }).amountCents;
  const cashNet = lines.filter((l) => account(l.account).cash).reduce((s, l) => s + l.debit - l.credit, 0);
  if (amount !== cashNet) return fail("evidence_mismatch", `bank transaction ${ref} is ${amount} cents but the entry moves ${cashNet}`);
  const prior = await ctx.db
    .query("journalEntries")
    .withIndex("by_run_source", (q) => q.eq("runId", runId).eq("source.kind", "bank_match").eq("source.ref", ref))
    .collect();
  if (prior.some((e) => e.status === "posted")) return fail("already_matched", `bank transaction ${ref} is already booked`);
  return { ok: true, event };
}
