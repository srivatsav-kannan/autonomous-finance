import { assertPaymentRelease } from "../apSystem/paymentRelease";
import { assertFrozenPaymentAccounting, assertPaymentAccountingBinding } from "../apSystem/paymentAccountingBinding";
import { assertGovernedCredits } from "../apSystem/governedCredits";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { PaymentExecutionConfig } from "../../../src/payments/contracts";
import { assertCommandMatchesSnapshot, assertSnapshotCurrent } from "../../../src/payments/domain/rules";
import { assertFrozenBankCommand } from "../../../src/payments/domain/validation";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { resolveAPBusinessPaymentAuthority } from "../apSystem/businessAuthority";

/** The request already owns its reservations; approval and first dispatch retain them. */
export async function assertReservedObligations(ctx: MutationCtx, version: Doc<"demoVersions">, config: PaymentExecutionConfig) {
  if (version.reservations !== "reserved") throw new Error("Payment must own reserved obligations");
  for (const item of version.snapshot.bills) {
    const bill = await ctx.db.get(item.billId); assertRowScope(bill, version.scope);
    const linkedCase = await ctx.db.query("apCaseRecords").withIndex("by_bill", q => q.eq("scope.runId", version.scope.runId).eq("billId", item.billId)).unique();
    if (linkedCase && (linkedCase.businessStatus !== "approved" || linkedCase.documentStatus !== "reviewed" || !linkedCase.fieldReviewId)) throw new Error("AP case authority changed; review required before first submission");
    if (!bill || bill.reservedVersionId !== version._id || bill.version !== item.version || bill.flags.length ||
        bill.status !== "approved" || bill.vendor !== config.beneficiary.vendor || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0 || !Number.isSafeInteger(bill.approvedCents) || !Number.isSafeInteger(bill.paidCents) || bill.paidCents < 0 || bill.approvedCents! - bill.paidCents < item.amountCents) {
      throw new Error("Stale bill or conflicting reservation");
    }
  }
  await assertGovernedCredits(ctx, version.scope, version.snapshot.credits, config.beneficiary.vendor);
  for (const item of version.snapshot.credits) {
    const credit = await ctx.db.get(item.creditId); assertRowScope(credit, version.scope);
    if (!credit || credit.vendor !== config.beneficiary.vendor || !Number.isSafeInteger(credit.reservedCents) ||
        !Number.isSafeInteger(credit.consumedCents) || credit.consumedCents < 0 || credit.reservedCents < item.amountCents ||
        credit.amountCents - credit.consumedCents < credit.reservedCents) throw new Error("Concurrent credit allocation conflict");
  }
}

/** Runs in the same mutation that persists the attempt, before any provider I/O. */
export async function assertDispatchAuthority(ctx: MutationCtx, config: PaymentExecutionConfig & { humanSubjects: { seatId: string; subject: string }[] }, row: Doc<"demoCommands">, firstDispatch: boolean) {
  assertRowScope(row, config.scope);
  const version = await ctx.db.get(row.versionId); assertRowScope(version, config.scope);
  if (!version || version.status !== "queued" || version.reservations !== "reserved" ||
      await sha256Hex(canonical(version.snapshot)) !== version.snapshotHash ||
      !version.approvals.some(a => a.kind === "human" && a.snapshotHash === version.snapshotHash && a.seatId !== version.requestedBy)) {
    throw new Error("Authorized immutable command invariant failed");
  }
  assertCommandMatchesSnapshot(row.command, version.snapshot, version._id);
  await assertFrozenBankCommand(row.command);
  await assertFrozenPaymentAccounting(ctx, config.scope, version, row);
  if (row.command.idempotencyKey !== `demo:${version._id}`) throw new Error("Original payment operation key mismatch");
  if (!firstDispatch) return { notBefore: 0 }; // Changed authority cannot authorize new money, or rewrite a possible old send.
  await assertPaymentAccountingBinding(ctx, config.scope, version.snapshot);
  const authority = await resolveAPBusinessPaymentAuthority(ctx, config.scope, version.snapshot.bills.map(b => b.billId as Id<"demoBills">));
  const currentConfig = authority ? { ...config, ...authority } : config;
  assertSnapshotCurrent(currentConfig, version.snapshot);
  await assertReservedObligations(ctx, version, currentConfig);
  for (const approval of version.approvals.filter(a => a.kind === "human" && a.snapshotHash === version.snapshotHash)) {
    if (!config.humanSubjects.some(binding => binding.seatId === approval.seatId && binding.subject === approval.subject)) continue;
    const seat = await ctx.db.query("seats").withIndex("by_run_seat", q => q.eq("runId", config.scope.runId).eq("seatId", approval.seatId)).unique();
    if (seat?.kind === "human" && seat.role === "human_cfo" && seat.status === "active" && seat.seatId !== version.requestedBy) {
      await assertPaymentRelease(ctx, config.scope, version.snapshot, approval.subject);
      return { notBefore: version.snapshot.schedule ? Math.max(0, Date.parse(`${version.snapshot.schedule.executionDate}T00:00:00.000Z`)) : 0 };
    }
  }
  throw new Error("Active authenticated human approval required before first dispatch");
}
