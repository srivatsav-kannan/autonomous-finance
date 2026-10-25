import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import {
  businessPolicySchema,
  domainRequestSchema,
  supplierProposalSchema,
  delegationSchema,
  type BusinessPolicy,
  type ApprovalStep,
} from "../../../src/ap-system/domain-contracts";
import { assertRowScope, getPaymentConfig } from "../demoAuth";
import { deny } from "./shared";
export type BusinessVote = {
  subject: string;
  principal: string;
  subjectSeatId: string;
  principalSeatId: string;
  groupId: string;
  stage: number;
  at: number;
  delegationId: string | null;
  stageStartedAt: number;
};
export async function activeBusinessPolicy(ctx: QueryCtx, scope: BankScope) {
  const rows = await ctx.db
    .query("apBusinessPolicies")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const active = rows.filter((r) => r.status === "active");
  if (active.length > 1)
    deny(
      "policy_conflict",
      "Multiple active business policies require governance repair",
    );
  if (!active.length) return null;
  assertRowScope(active[0]!, scope);
  return {
    ...active[0]!,
    value: businessPolicySchema.parse(active[0]!.policy),
  };
}
export async function requireBusinessPolicy(ctx: QueryCtx, scope: BankScope) {
  const p = await activeBusinessPolicy(ctx, scope);
  if (!p)
    deny(
      "business_policy_required",
      "Configure and independently approve the business policy first",
    );
  return p;
}
export async function readApprovedSupplierRevision(
  ctx: QueryCtx,
  scope: BankScope,
  supplierId: string,
) {
  const supplier = await ctx.db
    .query("apSuppliers")
    .withIndex("by_supplier", (q) =>
      q.eq("scope.runId", scope.runId).eq("supplierId", supplierId),
    )
    .unique();
  if (!supplier?.activeRevision)
    deny(
      "unverified_supplier",
      "Supplier onboarding and independent destination approval are required",
    );
  assertRowScope(supplier, scope);
  const revision = await ctx.db
    .query("apSupplierRevisions")
    .withIndex("by_supplier", (q) =>
      q
        .eq("scope.runId", scope.runId)
        .eq("supplierId", supplierId)
        .eq("revision", supplier.activeRevision!),
    )
    .unique();
  if (
    !revision ||
    revision.status !== "approved" ||
    !revision.verifiedBy ||
    !revision.approvedBy ||
    revision.verifiedBy === revision.approvedBy
  )
    deny(
      "unverified_supplier",
      "Active supplier revision lacks independent verification and approval",
    );
  return {
    ...revision,
    value: supplierProposalSchema.parse(revision.proposal),
  };
}
/** Recheck retained callback and activation authority at every business/payment gate. */
export async function currentSupplier(ctx: QueryCtx, scope: BankScope, supplierId: string) {
  const revision = await readApprovedSupplierRevision(ctx, scope, supplierId);
  const policy = await requireBusinessPolicy(ctx, scope);
  requireGroup(policy.value, policy.value.supplierVerificationGroup, revision.verifiedBy!);
  requireGroup(policy.value, policy.value.supplierApprovalGroup, revision.approvedBy!);
  const verifier = await assertHumanSubject(ctx,scope,revision.verifiedBy!);
  const approver = await assertHumanSubject(ctx,scope,revision.approvedBy!);
  if (revision.verifiedSeatId !== verifier.seatId || revision.approvedSeatId !== approver.seatId || verifier.seatId === approver.seatId ||
    verifier.seatId === revision.proposedBy || approver.seatId === revision.proposedBy)
    deny("supplier_authority_changed", "Supplier verification/approval must retain distinct active human seats; propose and independently verify a new supplier revision");
  return revision;
}
export async function assertHumanSubject(
  ctx: QueryCtx,
  scope: BankScope,
  subject: string,
) {
  const config = await getPaymentConfig(ctx, scope);
  const binding = config.humanSubjects.find((h) => h.subject === subject);
  if (!binding)
    deny(
      "unknown_approver",
      "Approval policy must bind independently authenticated humans",
    );
  const seat = await ctx.db
    .query("seats")
    .withIndex("by_run_seat", (q) =>
      q.eq("runId", scope.runId).eq("seatId", binding.seatId),
    )
    .unique();
  if (!seat || seat.kind !== "human" || seat.status !== "active")
    deny("inactive_approver", "Approver is not an active configured human");
  return seat;
}
export function requireGroup(
  policy: BusinessPolicy,
  groupId: string,
  subject: string,
) {
  if (
    !policy.groups.find((g) => g.groupId === groupId)?.members.includes(subject)
  )
    deny(
      "approval_group_required",
      `The configured ${groupId} group must authorize this action`,
    );
}
export async function resolveVotePrincipal(
  ctx: QueryCtx,
  scope: BankScope,
  policy: BusinessPolicy,
  proposal: Pick<Doc<"apApprovalProposals">, "route" | "stage" | "stageStartedAt" | "amountCents">,
  subject: string,
  delegationId?: string,
) {
  const route = proposal.route as ApprovalStep[];
  const step = route[proposal.stage];
  if (!step) deny("approval_stage", "No pending approval stage");
  const subjectSeat = await assertHumanSubject(ctx, scope, subject);
  let principal = subject,
    groupId = step.groupId;
  if (delegationId) {
    const id = ctx.db.normalizeId("apDelegations", delegationId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) deny("invalid_delegation", "Delegation not found");
    assertRowScope(row, scope);
    const d = delegationSchema.parse(row.delegation);
    if (
      row.revokedAt ||
      d.toSubject !== subject ||
      d.validFrom > Date.now() ||
      d.validUntil < Date.now() ||
      d.maxCents < proposal.amountCents
    )
      deny(
        "invalid_delegation",
        "Delegation is revoked, expired, not yet active or outside amount authority",
      );
    const grantorSeat = await assertHumanSubject(ctx, scope, row.grantor);
    if (row.grantorSeatId !== grantorSeat.seatId || row.delegateSeatId !== subjectSeat.seatId || grantorSeat.seatId === subjectSeat.seatId)
      deny("invalid_delegation", "Delegation must retain two distinct current human seat bindings");
    principal = row.grantor;
    groupId = d.groupId;
  } else if (
    !policy.groups
      .find((g) => g.groupId === step.groupId)
      ?.members.includes(subject) &&
    step.escalationGroupId
  )
    groupId = step.escalationGroupId;
  if (
    groupId !== step.groupId &&
    (groupId !== step.escalationGroupId ||
      Date.now() < proposal.stageStartedAt + step.escalateAfterMs)
  )
    deny(
      "escalation_not_due",
      "Escalated authority is not available before the configured deadline",
    );
  requireGroup(policy, groupId, principal);
  const principalSeat = await assertHumanSubject(ctx, scope, principal);
  return { principal, groupId, subjectSeatId: subjectSeat.seatId, principalSeatId: principalSeat.seatId };
}
export async function assertApprovalCurrent(
  ctx: QueryCtx,
  scope: BankScope,
  row: Doc<"apCaseRecords">,
  approval: Doc<"apApprovalProposals">,
) {
  if (
    approval.status !== "approved" ||
    row.domainApprovalId !== approval._id ||
    row.documentStatus !== "reviewed" ||
    row.businessStatus !== "approved" ||
    !row.fieldReviewId
  )
    deny(
      "business_approval_required",
      "Current reviewed business approval is required",
    );
  const request = domainRequestSchema.parse(approval.request);
  if (
    request.expectedRevision !== row.currentRevision ||
    request.snapshotHash !== row.snapshotHash
  )
    deny(
      "stale_business_approval",
      "Source/case revision changed after business approval",
    );
  const policy = await requireBusinessPolicy(ctx, scope);
  if (
    policy.hash !== approval.policyHash ||
    policy.version !== request.policyVersion
  )
    deny(
      "stale_policy_approval",
      "Business policy changed; reapprove the obligation under the current policy",
    );
  const candidate = row.intake.candidate;
  if (!candidate?.supplierId)
    deny(
      "unverified_supplier",
      "Recognized case has no verified supplier binding",
    );
  const supplier = await currentSupplier(ctx, scope, candidate.supplierId);
  if (
    supplier.hash !== approval.supplierHash ||
    supplier.revision !== request.supplierRevision
  )
    deny(
      "stale_supplier_approval",
      "Supplier or destination changed; reapprove against the current immutable supplier revision",
    );
  await assertApprovalVotes(ctx, scope, policy.value, approval);
  return { policy, supplier, request };
}
/** Resolve every retained identity again: subject aliases cannot fill two seats,
 * and reconfiguring a subject cannot transfer an earlier human decision. */
export async function assertIndependentVotes(ctx: QueryCtx, scope: BankScope, votes: BusinessVote[]) {
  const occupied = new Set<string>();
  for (const vote of votes) {
    const subjectSeat = await assertHumanSubject(ctx, scope, vote.subject);
    const principalSeat = await assertHumanSubject(ctx, scope, vote.principal);
    if (vote.subjectSeatId !== subjectSeat.seatId || vote.principalSeatId !== principalSeat.seatId)
      deny("approval_identity_changed", "Approval lacks its original current human seat binding; explicit recertification is required");
    const seats = new Set([subjectSeat.seatId, principalSeat.seatId]);
    if ([...seats].some((seat) => occupied.has(seat)))
      deny("approval_segregation", "Independent approval positions require distinct human seats, including delegated principals");
    for (const seat of seats) occupied.add(seat);
  }
}
export async function assertApprovalVotes(ctx: QueryCtx, scope: BankScope, policy: BusinessPolicy, approval: Pick<Doc<"apApprovalProposals">, "route" | "votes" | "amountCents">) {
  const votes = approval.votes as BusinessVote[];
  const route = approval.route as ApprovalStep[];
  await assertIndependentVotes(ctx, scope, votes);
  if (
    new Set(votes.map((v) => v.subject)).size !== votes.length ||
    new Set(votes.map((v) => v.principal)).size !== votes.length ||
    votes.some((v, i) => votes.some((w, j) => i !== j && (v.subject === w.principal || v.principal === w.subject)))
  )
    deny(
      "approval_segregation",
      "One person or delegated principal cannot fill multiple approval positions",
    );
  for (const [stage, step] of route.entries()) {
    const stageVotes = votes.filter((v) => v.stage === stage);
    if (stageVotes.length < step.quorum)
      deny(
        "approval_incomplete",
        "Required sequential approval quorum is incomplete",
      );
    for (const vote of stageVotes) {
      await assertHumanSubject(ctx, scope, vote.subject);
      await assertHumanSubject(ctx, scope, vote.principal);
      requireGroup(policy, vote.groupId, vote.principal);
      if (
        vote.groupId !== step.groupId &&
        (vote.groupId !== step.escalationGroupId ||
          vote.at < vote.stageStartedAt + step.escalateAfterMs)
      )
        deny(
          "invalid_escalation",
          "Approval escalation does not match its retained deadline",
        );
      if (vote.delegationId) {
        const id = ctx.db.normalizeId("apDelegations", vote.delegationId);
        const d = id ? await ctx.db.get(id) : null;
        if (!d)
          deny("invalid_delegation", "Approved delegation is unavailable");
        assertRowScope(d, scope);
        const grant = delegationSchema.parse(d.delegation);
        if (
          d.revokedAt ||
          grant.validUntil < Date.now() ||
          grant.validFrom > vote.at ||
          grant.toSubject !== vote.subject ||
          d.grantor !== vote.principal ||
          d.grantorSeatId !== vote.principalSeatId ||
          d.delegateSeatId !== vote.subjectSeatId ||
          grant.groupId !== vote.groupId ||
          grant.maxCents < approval.amountCents
        )
          deny(
            "invalid_delegation",
            "Approval delegation expired, changed or was revoked",
          );
      }
    }
  }
}
/** Root payment engine invokes this at request, authorization and first dispatch only.
 * Recovery of an already attempted bank operation keeps its frozen original command. */
export async function resolveAPBusinessPaymentAuthority(
  ctx: QueryCtx,
  scope: BankScope,
  billIds: Id<"demoBills">[],
): Promise<null | {
  beneficiary: { vendor: string; externalAccountId: string; version: string };
}> {
  let beneficiary: null | {
    vendor: string;
    externalAccountId: string;
    version: string;
  } = null;
  let legacy = false;
  for (const billId of billIds) {
    const bill = await ctx.db.get(billId);
    assertRowScope(bill, scope);
    const row = await ctx.db
      .query("apCaseRecords")
      .withIndex("by_bill", (q) =>
        q.eq("scope.runId", scope.runId).eq("billId", billId),
      )
      .unique();
    if (!row?.domainApprovalId) {
      legacy = true;
      continue;
    }
    const approval = await ctx.db.get(row.domainApprovalId);
    if (!approval)
      deny(
        "business_approval_missing",
        "B3 approval binding cannot fall back to the legacy supplier",
      );
    const { supplier } = await assertApprovalCurrent(ctx, scope, row, approval);
    if (
      bill!.vendor !== supplier.supplierId ||
      bill!.approvedCents !== approval.amountCents ||
      !bill!.entryId ||
      bill!.flags.length
    )
      deny(
        "business_bill_mismatch",
        "Bill does not match its approved business recognition",
      );
    const next = {
      vendor: supplier.supplierId,
      externalAccountId: supplier.value.externalAccountId,
      version: `${supplier.supplierId}:r${supplier.revision}`,
    };
    if (beneficiary && JSON.stringify(beneficiary) !== JSON.stringify(next))
      deny(
        "mixed_beneficiaries",
        "A payment cannot mix suppliers or destination versions",
      );
    beneficiary = next;
  }
  if (beneficiary && legacy)
    deny(
      "mixed_business_authority",
      "B3 bills cannot use a mixed legacy/default beneficiary request",
    );
  return beneficiary ? { beneficiary } : null;
}
