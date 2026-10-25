import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/payments/contracts";
import { assertRowScope, auditDemo, requirePaymentSeat } from "../demoAuth";
import { requestPaymentCommand } from "../payments/applyCommand";
export async function prepareAPCasePayment(
  ctx: MutationCtx,
  args: {
    scope: BankScope;
    caseId: Id<"apCaseRecords">;
    expectedRevision: number;
    snapshotHash: string;
    seatId: string;
    token: string;
    idempotencyKey: string;
    executionDate?: string;
    amountCents?: number;
    credits?: { creditId: Id<"demoCredits">; amountCents: number }[];
  },
) {
  await requirePaymentSeat(ctx, args, ["payments"]);
  const row = await ctx.db.get(args.caseId);
  assertRowScope(row, args.scope);
  const ap = row as Doc<"apCaseRecords">;
  if (
    ap.currentRevision !== args.expectedRevision ||
    ap.snapshotHash !== args.snapshotHash
  )
    throw Error("Stale AP case payment request");
  if (
    ap.businessStatus !== "approved" ||
    ap.documentStatus !== "reviewed" ||
    !ap.fieldReviewId ||
    !ap.billId
  )
    throw Error(
      "Reviewed and approved AP case required before payment preparation",
    );
  const bill = await ctx.db.get(ap.billId);
  assertRowScope(bill, args.scope);
  if (!(bill as Doc<"demoBills">).entryId)
    throw Error("Recognized payable required before payment preparation");
  const result = await requestPaymentCommand(ctx, {
    scope: args.scope,
    seatId: args.seatId,
    token: args.token,
    requestKey: args.idempotencyKey,
    billIds: [ap.billId],
    credits: args.credits ?? [],
    ...(args.executionDate !== undefined
      ? { executionDate: args.executionDate }
      : {}),
    ...(args.amountCents !== undefined
      ? { billAmounts: [{ billId: ap.billId, amountCents: args.amountCents }] }
      : {}),
  });
  const version = await ctx.db.get(result.versionId);
  // The existing operation is authoritative on retry; never replace its request key.
  if (!version || !version.snapshot.bills.some((b) => b.billId === ap.billId))
    throw Error("Payment does not belong to AP case");
  await auditDemo(ctx, args.scope, args.seatId, "ap_case_payment_prepared", {
    caseId: args.caseId,
    revision: ap.currentRevision,
    caseSnapshot: ap.snapshotHash,
    versionId: result.versionId,
  });
  return result;
}
