import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import type {
  AccountingCorrection,
  BankReturnCorrection,
  BankReturnEvidence,
  PaymentAllocationEvidence,
} from "../../../src/ap-system/quickbooks/types";
import {
  accountingCorrectionRequestSchema,
  type AccountingCorrectionRequest,
} from "../../../src/ap-system/quickbooks/corrections";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { deny } from "./shared";
import {
  requireBusinessPolicy,
  currentSupplier,
  assertApprovalVotes,
} from "./businessAuthority";
import { paymentEvidence, openPeriod } from "./accountingBankEvidence";
export async function correctionRecord(
  ctx: QueryCtx,
  scope: BankScope,
  id: string,
) {
  const normalized = ctx.db.normalizeId("apAccountingCorrections", id);
  const row = normalized ? await ctx.db.get(normalized) : null;
  assertRowScope(row, scope);
  if (!row) throw Error("correction_missing");
  return row;
}
export async function evaluateCorrection(
  ctx: QueryCtx,
  scope: BankScope,
  request: AccountingCorrectionRequest,
  excludeId?: string,
) {
  const bank = await paymentEvidence(
    ctx,
    scope,
    request.caseId,
    request.paymentVersionId,
    request.kind === "bank_return" ? "returned" : "settled",
  );
  const policy = await requireBusinessPolicy(ctx, scope);
  const supplier = await currentSupplier(ctx, scope, bank.bill.vendor);
  let payload: BankReturnEvidence | PaymentAllocationEvidence;
  if (request.kind === "bank_return") {
    if (
      !bank.returned ||
      bank.returned.returnTransactionId !== request.returnTransactionId
    )
      deny(
        "return_identity_mismatch",
        "Requested return must be the verified exact transaction",
      );
    payload = bank.returned;
  } else {
    await openPeriod(ctx, scope, bank.settlement.date);
    if (
      new Set(request.restoredPayables.map((r) => r.correctionId)).size !==
      request.restoredPayables.length
    )
      deny(
        "duplicate_restored_payable",
        "Restored payable IDs must be distinct",
      );
    const rows = await ctx.db
      .query("apAccountingCorrections")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", scope.runId).eq("caseId", bank.row._id),
      )
      .collect();
    const approvedAllocations = rows.filter(
      (r) =>
        r.status === "approved" &&
        r._id !== excludeId &&
        r.payload?.kind === "payment_allocation",
    );
    const restored: PaymentAllocationEvidence["restoredPayables"] = [];
    for (const item of request.restoredPayables) {
      const candidate = await correctionRecord(ctx, scope, item.correctionId);
      if (candidate.payload?.kind !== "bank_return")
        deny(
          "restored_payable_binding",
          "Only bank-return corrections create restored payable",
        );
      const correction = await approvedCorrection(
        ctx,
        scope,
        item.correctionId,
      );
      if (
        correction.kind !== "bank_return" ||
        correction.billId !== bank.bill._id ||
        correction.supplierId !== bank.bill.vendor ||
        correction.date > bank.settlement.date ||
        correction.original.paymentVersionId === bank.version._id
      )
        deny(
          "restored_payable_binding",
          "Allocation must bind an earlier approved return on this bill/vendor",
        );
      const consumed = approvedAllocations
        .flatMap(
          (r) => (r.payload as PaymentAllocationEvidence).restoredPayables,
        )
        .filter((p) => p.correction.correctionId === correction.correctionId)
        .reduce((n, p) => n + BigInt(p.amountCents), 0n);
      if (consumed + BigInt(item.amountCents) > BigInt(correction.amountCents))
        deny(
          "restored_payable_exhausted",
          "Approved allocations exceed returned cash principal",
        );
      restored.push({ correction, amountCents: item.amountCents });
    }
    restored.sort((a, b) =>
      a.correction.correctionId.localeCompare(b.correction.correctionId),
    );
    const gross = bank.settlement.grossAppliedCents!;
    if (
      BigInt(request.originalBillCents) +
        restored.reduce((n, p) => n + BigInt(p.amountCents), 0n) !==
      BigInt(gross)
    )
      deny(
        "allocation_sum",
        "Original and restored payable amounts must equal gross application, before credits",
      );
    const versions = (
      await ctx.db
        .query("demoVersions")
        .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
        .collect()
    ).filter(
      (v) =>
        v._id !== bank.version._id &&
        v.reservations === "consumed" &&
        ["settled", "returned"].includes(v.status) &&
        v.snapshot.bills.some((b) => b.billId === bank.bill._id),
    );
    let originalUsed = 0n;
    for (const version of versions) {
      assertRowScope(version, scope);
      const a = approvedAllocations.find(
        (a) => a.payload.settlement.paymentVersionId === version._id,
      );
      originalUsed += BigInt(
        a
          ? (a.payload as PaymentAllocationEvidence).originalBillCents
          : version.snapshot.bills.find((b) => b.billId === bank.bill._id)!
              .amountCents,
      );
    }
    const direct = await ctx.db
      .query("apCreditApplications")
      .withIndex("by_bill", (q) =>
        q.eq("scope.runId", scope.runId).eq("billId", bank.bill._id),
      )
      .collect();
    for (const a of direct) {
      assertRowScope(a, scope);
      originalUsed += BigInt(a.amountCents);
    }
    if (
      originalUsed + BigInt(request.originalBillCents) >
      BigInt(bank.recognized.amountCents)
    )
      deny(
        "original_payable_exhausted",
        "Allocation exceeds the original external Bill principal",
      );
    payload = {
      kind: "payment_allocation",
      caseId: bank.row._id,
      billId: bank.bill._id,
      supplierId: bank.bill.vendor,
      amountCents: gross,
      settlement: bank.settlement,
      originalBillCents: request.originalBillCents,
      restoredPayables: restored,
    };
  }
  const amountCents = payload.amountCents;
  const route = structuredClone(
    policy.value.bands.find((b) => b.upToCents >= amountCents)!.steps,
  );
  // Every correction also needs the explicitly configured finance/variance authority.
  if (!route.some((s) => s.groupId === policy.value.varianceApprovalGroup))
    route.push({
      groupId: policy.value.varianceApprovalGroup,
      quorum: 1,
      escalateAfterMs: 86400000,
      escalationGroupId: null,
    });
  const hash = await sha256Hex(
    canonical({
      request,
      payload,
      policyHash: policy.hash,
      supplierHash: supplier.hash,
      route,
      amountCents,
    }),
  );
  const identity =
    request.kind === "bank_return"
      ? `bank_return:${request.returnTransactionId}`
      : `payment_allocation:${request.paymentVersionId}`;
  return {
    row: bank.row,
    policy,
    supplier,
    payload,
    amountCents,
    route,
    hash,
    identity,
  };
}
export async function approvedCorrection(
  ctx: QueryCtx,
  scope: BankScope,
  id: string,
): Promise<AccountingCorrection> {
  const row = await correctionRecord(ctx, scope, id);
  if (row.status !== "approved" || !row.completedAt)
    deny(
      "approved_correction_required",
      "Current fully approved correction required",
    );
  const request = accountingCorrectionRequestSchema.parse(row.request);
  const actual = await evaluateCorrection(ctx, scope, request, row._id);
  if (
    row.caseId !== request.caseId ||
    row.hash !== actual.hash ||
    row.policyHash !== actual.policy.hash ||
    row.supplierHash !== actual.supplier.hash ||
    canonical(row.payload) !== canonical(actual.payload)
  )
    deny(
      "stale_correction_authority",
      "Correction evidence or current policy/supplier changed",
    );
  await assertApprovalVotes(ctx, scope, actual.policy.value, row);
  if (
    row.votes.some(
      (v: any) =>
        v.subjectSeatId === row.proposedBy ||
        v.principalSeatId === row.proposedBy ||
        v.subjectSeatId === actual.row.createdBy ||
        v.principalSeatId === actual.row.createdBy,
    )
  )
    deny(
      "correction_self_approval",
      "Independent correction approval required",
    );
  return {
    ...row.payload,
    correctionId: row._id,
    proposalHash: row.hash,
    policyHash: row.policyHash,
    approvedAt: row.completedAt,
  } as AccountingCorrection;
}
export async function approvedReturns(
  ctx: QueryCtx,
  scope: BankScope,
  caseId: string,
): Promise<BankReturnCorrection[]> {
  const caseID = ctx.db.normalizeId("apCaseRecords", caseId);
  if (!caseID) return [];
  const rows = await ctx.db
    .query("apAccountingCorrections")
    .withIndex("by_case", (q) =>
      q.eq("scope.runId", scope.runId).eq("caseId", caseID),
    )
    .collect();
  const result: BankReturnCorrection[] = [];
  for (const r of rows.filter(
    (r) => r.status === "approved" && r.payload?.kind === "bank_return",
  )) {
    const checked = await approvedCorrection(ctx, scope, r._id);
    if (checked.kind === "bank_return") result.push(checked);
  }
  return result.sort((a, b) => a.correctionId.localeCompare(b.correctionId));
}
