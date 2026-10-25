import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { intakeSchema, type APException } from "../../../src/ap-system/contracts";
import { domainRequestSchema, domainCaseProjectionSchema, type DomainCaseProjection } from "../../../src/ap-system/domain-contracts";
import { businessEvidenceProblems, businessException, evaluateBusinessAcceptance } from "../../../src/ap-system/business-policy";
import { activeBusinessPolicy, currentSupplier, assertApprovalCurrent, type BusinessVote } from "./businessAuthority";
/** Derive from recognized ledgers and consumed reservations, never the latest candidate's guessed balance. */
export async function businessProjection(ctx: QueryCtx, row: Doc<"apCaseRecords">, bill: Doc<"demoBills"> | null, versions: Doc<"demoVersions">[]) {
  const policy = await activeBusinessPolicy(ctx, row.scope);
  if (!policy && !row.domainApprovalId) return null;
  const input = intakeSchema.parse(row.intake);
  const approval = row.domainApprovalId ? await ctx.db.get(row.domainApprovalId) : null;
  const request = approval ? domainRequestSchema.parse(approval.request) : null;
  const exceptions: APException[] = [];
  let status: DomainCaseProjection["approvalStatus"] = approval?.status === "approved" ? "approved" : approval?.status === "pending" ? "pending" : approval?.status === "rejected" ? "rejected" : "not_proposed";
  let supplierRevision: number | null = null;
  try {
    if (!policy) throw Error("Current business policy required");
    const supplier = await currentSupplier(ctx, row.scope, input.candidate?.supplierId ?? "");
    supplierRevision = supplier.revision;
    if (approval && request) {
      if (request.snapshotHash !== row.snapshotHash || request.expectedRevision !== row.currentRevision || approval.policyHash !== policy.hash || approval.supplierHash !== supplier.hash) throw Error("Case, policy or supplier changed after the proposed authority");
      if (approval.status === "approved") await assertApprovalCurrent(ctx, row.scope, row, approval);
      else if (request.acceptance) exceptions.push(...evaluateBusinessAcceptance(input, request.acceptance, policy.value, supplier.value, row.documentStatus === "reviewed").exceptions);
      if (status !== "approved") exceptions.push(businessException("business_approval_pending", "The configured sequential approval route must complete before recognition or payment.", "controller"));
    } else {
      exceptions.push(...businessEvidenceProblems(input, row.documentStatus === "reviewed"));
      exceptions.push(businessException("business_plan_required", "Propose explicit accepted quantities, cost allocations and any linked credit before group approval.", "controller"));
    }
  } catch (error) {
    status = approval ? "stale" : "not_proposed";
    exceptions.push(businessException("business_authority_hold", error instanceof Error ? error.message : "Current business authority is unavailable", "controller"));
  }
  let appliedCreditCents = 0;
  for (const version of versions.filter((v) => v.reservations === "consumed")) {
    let credits = version.snapshot.credits.reduce((n, c) => n + c.amountCents, 0);
    for (const item of version.snapshot.bills) {
      const applied = Math.min(item.amountCents, credits); credits -= applied;
      if (item.billId === bill?._id) appliedCreditCents += applied;
    }
  }
  const direct = bill ? await ctx.db.query("apCreditApplications").withIndex("by_bill", (q) => q.eq("scope.runId", row.scope.runId).eq("billId", bill._id)).collect() : [];
  appliedCreditCents += direct.reduce((n, a) => n + a.amountCents, 0);
  const links = bill ? await ctx.db.query("apCreditLinks").withIndex("by_original", (q) => q.eq("scope.runId", row.scope.runId).eq("originalBillId", bill._id)).collect() : await ctx.db.query("apCreditLinks").withIndex("by_case", (q) => q.eq("scope.runId", row.scope.runId).eq("caseId", row._id)).collect();
  const creditLinks = await Promise.all(links.map(async (link) => {const credit = await ctx.db.get(link.creditId); return {caseId: link.caseId, creditId: link.creditId, originalBillId: link.originalBillId, amountCents: link.amountCents, consumedCents: credit?.consumedCents ?? 0, reservedCents: credit?.reservedCents ?? 0, entryId: link.entryId}; }));
  const supplierCredits = (await ctx.db.query("demoCredits").withIndex("by_run", (q) => q.eq("scope.runId", row.scope.runId)).collect()).filter((c) => c.vendor === input.candidate?.supplierId);
  const credit = row.creditId ? await ctx.db.get(row.creditId) : null;
  const domain = domainCaseProjectionSchema.parse({
    policyVersion: policy?.version ?? null, supplierId: input.candidate?.supplierId ?? null, supplierRevision,
    approvalId: approval?._id ?? null, approvalHash: approval?.hash ?? null, approvalStatus: status,
    route: approval?.route ?? [], stage: approval?.stage ?? 0, stageStartedAt: approval?.stageStartedAt ?? null,
    votes: (approval?.votes ?? []) as BusinessVote[], acceptance: request?.acceptance ?? null, credit: request?.credit ?? null, creditLinks,
    recognizedCents: bill?.approvedCents ?? credit?.amountCents ?? 0, appliedCreditCents,
    availableSupplierCreditCents: supplierCredits.reduce((n, c) => n + c.amountCents - c.consumedCents - c.reservedCents, 0),
    cashSettledCents: Math.max(0, (bill?.paidCents ?? 0) - appliedCreditCents),
  });
  return { domain, exceptions, credit, policyVersion: policy?.version ?? "ap-business-v1" };
}
