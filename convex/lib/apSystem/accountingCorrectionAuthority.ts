import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import type {
  AccountingCorrection,
  BankReturnCorrection,
  BankReturnEvidence,
  PaymentAllocationEvidence,
  CreditAllocationEvidence,
} from "../../../src/ap-system/quickbooks/types";
import {
  accountingCorrectionRequestSchema,
  type AccountingCorrectionRequest,
} from "../../../src/ap-system/quickbooks/corrections";
import { assertRowScope } from "../demoAuth";
import { canonical, sha256Hex } from "../kernel";
import { deny, caseRow } from "./shared";
import { creditApplication } from "./accountingCredits";
import { loadRecognizedBusinessExport } from "./businessExport";
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
  const context =
    request.kind === "credit_allocation"
      ? await (async () => {
          const row = await caseRow(ctx, scope, request.caseId);
          if (!row.billId) throw Error("recognized_bill_required");
          const bill = await ctx.db.get(row.billId);
          assertRowScope(bill, scope);
          if (!bill) throw Error("recognized_bill_required");
          const recognized = await loadRecognizedBusinessExport(
            ctx,
            scope,
            row._id,
          );
          if (recognized.kind !== "invoice")
            throw Error("recognized_invoice_required");
          const id = ctx.db.normalizeId(
            "apCreditApplications",
            request.creditApplicationId,
          );
          if (!id) throw Error("credit_application_required");
          const application = await creditApplication(
            ctx,
            scope,
            row._id,
            bill._id,
            id,
          );
          return {
            row,
            bill,
            recognized,
            date: application.date,
            gross: application.amountCents,
            versionId: null,
            application,
            settlement: null,
            returned: null,
          };
        })()
      : await (async () => {
          const bank = await paymentEvidence(
            ctx,
            scope,
            request.caseId,
            request.paymentVersionId,
            request.kind === "bank_return" ? "returned" : "settled",
          );
          return {
            ...bank,
            date: bank.settlement.date,
            gross: bank.settlement.grossAppliedCents!,
            versionId: bank.version._id,
            application: null,
          };
        })();
  const policy = await requireBusinessPolicy(ctx, scope);
  const supplier = await currentSupplier(ctx, scope, context.bill.vendor);
  let payload:
    BankReturnEvidence | PaymentAllocationEvidence | CreditAllocationEvidence;
  if (request.kind === "bank_return") {
    if (
      !context.returned ||
      context.returned.returnTransactionId !== request.returnTransactionId
    )
      deny(
        "return_identity_mismatch",
        "Requested return must be the verified exact transaction",
      );
    payload = context.returned;
  } else {
    await openPeriod(ctx, scope, context.date);
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
        q.eq("scope.runId", scope.runId).eq("caseId", context.row._id),
      )
      .collect();
    const approvedAllocations = rows.filter(
      (r) =>
        r.status === "approved" &&
        r._id !== excludeId &&
        ["payment_allocation", "credit_allocation"].includes(r.payload?.kind),
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
      const binding = (context.settlement ?? context.application)
        ?.accountingBinding;
      const prior =
        correction.kind === "bank_return"
          ? correction.original.accountingBinding
          : undefined;
      if (
        canonical(
          binding
            ? {
                version: binding.version,
                mode: binding.mode,
                department: binding.department,
              }
            : null,
        ) !==
        canonical(
          prior
            ? {
                version: prior.version,
                mode: prior.mode,
                department: prior.department,
              }
            : null,
        )
      )
        deny(
          "restored_payable_department_mismatch",
          "Replacement allocation must retain the restored payable's exact department and scope",
        );
      if (
        correction.kind !== "bank_return" ||
        correction.billId !== context.bill._id ||
        correction.supplierId !== context.bill.vendor ||
        correction.date > context.date ||
        correction.original.paymentVersionId === context.versionId
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
    const gross = context.gross;
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
        v._id !== context.versionId &&
        v.reservations === "consumed" &&
        ["settled", "returned"].includes(v.status) &&
        v.snapshot.bills.some((b) => b.billId === context.bill._id),
    );
    let originalUsed = 0n;
    for (const version of versions) {
      assertRowScope(version, scope);
      const a = approvedAllocations.find(
        (a) =>
          a.payload.kind === "payment_allocation" &&
          a.payload.settlement.paymentVersionId === version._id,
      );
      originalUsed += BigInt(
        a
          ? (a.payload as PaymentAllocationEvidence).originalBillCents
          : version.snapshot.bills.find((b) => b.billId === context.bill._id)!
              .amountCents,
      );
    }
    const direct = await ctx.db
      .query("apCreditApplications")
      .withIndex("by_bill", (q) =>
        q.eq("scope.runId", scope.runId).eq("billId", context.bill._id),
      )
      .collect();
    const seen = new Set<string>();
    for (const a of direct) {
      assertRowScope(a, scope);
      if (
        context.application?.applicationIds.includes(a._id) ||
        seen.has(a.requestKey)
      )
        continue;
      seen.add(a.requestKey);
      const group = direct.filter((g) => g.requestKey === a.requestKey);
      for (const g of group) assertRowScope(g, scope);
      const allocation = approvedAllocations.find(
        (r) =>
          r.payload.kind === "credit_allocation" &&
          r.payload.creditApplication.applicationIds.includes(a._id),
      );
      originalUsed += allocation
        ? BigInt(allocation.payload.originalBillCents)
        : group.reduce((n, g) => n + BigInt(g.amountCents), 0n);
    }
    if (
      originalUsed + BigInt(request.originalBillCents) >
      BigInt(context.recognized.amountCents)
    )
      deny(
        "original_payable_exhausted",
        "Allocation exceeds the original external Bill principal",
      );
    payload = {
      ...(request.kind === "credit_allocation"
        ? {
            kind: "credit_allocation" as const,
            creditApplication: context.application!,
          }
        : {
            kind: "payment_allocation" as const,
            settlement: context.settlement!,
          }),
      caseId: context.row._id,
      billId: context.bill._id,
      supplierId: context.bill.vendor,
      amountCents: gross,
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
      : request.kind === "credit_allocation"
        ? `credit_allocation:${context.application!.applicationId}`
        : `payment_allocation:${request.paymentVersionId}`;
  return {
    row: context.row,
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
