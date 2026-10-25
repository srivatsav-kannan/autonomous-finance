import { invalidateBusinessPayments } from "./lib/apSystem/businessInvalidation";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import {
  requirePaymentHuman,
  requirePaymentSeat,
  assertRowScope,
  auditDemo,
} from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import {
  businessPolicySchema,
  supplierProposalSchema,
  supplierVerificationSchema,
  delegationSchema,
} from "../src/ap-system/domain-contracts";
import { readAuth, deny, replay, receipt } from "./lib/apSystem/shared";
import {
  requireBusinessPolicy,
  activeBusinessPolicy,
  requireGroup,
  assertHumanSubject,
  currentSupplier,
} from "./lib/apSystem/businessAuthority";
const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
async function evidence(
  ctx: Parameters<typeof readAuth>[0],
  scope: Parameters<typeof readAuth>[1]["scope"],
  bindings: { sourceId: string; revision: number; sha256: string }[],
  independent = false,
) {
  for (const b of bindings) {
    const row = await ctx.db
      .query("apCaseSources")
      .withIndex("by_source", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("sourceId", b.sourceId)
          .eq("revision", b.revision),
      )
      .unique();
    if (!row || row.sha256 !== b.sha256)
      deny(
        "verification_evidence_missing",
        "Retained verification source is unavailable",
      );
    assertRowScope(row, scope);
    if (independent && ["invoice", "credit_note"].includes(row.document.kind))
      deny(
        "independent_contact_required",
        "Invoice/payment-request content cannot establish its own trusted verification contact",
      );
  }
}
export const proposePolicy = mutation({
  args: { ...agent, idempotencyKey: v.string(), policy: v.any() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]);
    const policy = businessPolicySchema.parse(args.policy);
    const op = await replay(ctx, args.scope, `policy:${args.idempotencyKey}`, {
      policy,
      actor: seat.seatId,
    });
    if (op.prior) return op.prior.result;
    for (const member of new Set(policy.groups.flatMap((g) => g.members)))
      await assertHumanSubject(ctx, args.scope, member);
    const same = await ctx.db
      .query("apBusinessPolicies")
      .withIndex("by_version", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("version", policy.version),
      )
      .unique();
    if (same)
      deny(
        "policy_version_used",
        "Business policy versions are immutable and cannot be reused",
      );
    const policyId = await ctx.db.insert("apBusinessPolicies", {
      scope: args.scope,
      version: policy.version,
      hash: await sha256Hex(canonical(policy)),
      policy,
      status: "proposed",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    const result = { policyId };
    await receipt(
      ctx,
      args.scope,
      `policy:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const activatePolicy = mutation({
  args: {
    scope: scopeValidator,
    policyId: v.id("apBusinessPolicies"),
    expectedHash: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const row = await ctx.db.get(args.policyId);
    assertRowScope(row, args.scope);
    if (
      row!.hash !== args.expectedHash ||
      !args.reason.trim() ||
      row!.proposedBy === seat.seatId
    )
      deny(
        "policy_authority",
        "Independent exact policy review with reason is required",
      );
    if (row!.status === "active") return { policyId: row!._id };
    if (row!.status !== "proposed")
      deny("policy_status", "Only a proposed policy can be activated");
    const old = await activeBusinessPolicy(ctx, args.scope);
    if (old) requireGroup(old.value, old.value.supplierApprovalGroup, subject);
    for (const member of new Set(
      businessPolicySchema.parse(row!.policy).groups.flatMap((g) => g.members),
    ))
      await assertHumanSubject(ctx, args.scope, member);
    if (old) await ctx.db.patch(old._id, { status: "superseded" });
    await ctx.db.patch(row!._id, {
      status: "active",
      approvedBy: subject,
      approvedAt: Date.now(),
    });
    await invalidateBusinessPayments(ctx, args.scope);
    await auditDemo(ctx, args.scope, subject, "business_policy_approved", {
      policyId: row!._id,
      hash: row!.hash,
      reason: args.reason,
    });
    return { policyId: row!._id };
  },
});
export const registerTrustedContact = mutation({
  args: {
    scope: scopeValidator,
    idempotencyKey: v.string(),
    supplierId: v.string(),
    phone: v.string(),
    evidence: v.any(),
    mode: v.union(v.literal("simulated"), v.literal("operator_recorded")),
  },
  handler: async (ctx, args) => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const policy = await requireBusinessPolicy(ctx, args.scope);
    requireGroup(policy.value, policy.value.supplierVerificationGroup, subject);
    if (!/^\+[1-9]\d{7,14}$/.test(args.phone) || !args.supplierId.trim())
      deny(
        "trusted_contact_invalid",
        "Record an independently held E.164 phone number and supplier identity",
      );
    if (args.mode === "simulated" && args.scope.environment !== "local")
      deny(
        "simulated_verification_forbidden",
        "Sandbox supplier verification cannot claim a simulated callback",
      );
    const bindings = supplierProposalSchema.shape.evidence.parse(args.evidence);
    await evidence(ctx, args.scope, bindings, true);
    const op = await replay(ctx, args.scope, `contact:${args.idempotencyKey}`, {
      supplierId: args.supplierId,
      phone: args.phone,
      bindings,
      mode: args.mode,
      subject,
    });
    if (op.prior) return op.prior.result;
    const contactId = await ctx.db.insert("apSupplierContacts", {
      scope: args.scope,
      supplierId: args.supplierId,
      phone: args.phone,
      evidence: bindings,
      mode: args.mode,
      recordedBy: subject,
      createdAt: Date.now(),
    });
    const result = { contactId };
    await receipt(
      ctx,
      args.scope,
      `contact:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const proposeSupplier = mutation({
  args: { ...agent, idempotencyKey: v.string(), proposal: v.any() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, [
      "ap_clerk",
      "controller",
    ]);
    await requireBusinessPolicy(ctx, args.scope);
    const proposal = supplierProposalSchema.parse(args.proposal);
    const op = await replay(
      ctx,
      args.scope,
      `supplier:${args.idempotencyKey}`,
      { proposal, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    await evidence(ctx, args.scope, proposal.evidence);
    const contactId = ctx.db.normalizeId(
      "apSupplierContacts",
      proposal.contactId,
    );
    const contact = contactId ? await ctx.db.get(contactId) : null;
    if (!contact || contact.supplierId !== proposal.supplierId)
      deny(
        "trusted_contact_required",
        "Choose a separately recorded trusted supplier contact",
      );
    assertRowScope(contact, args.scope);
    let supplier = await ctx.db
      .query("apSuppliers")
      .withIndex("by_supplier", (q) =>
        q
          .eq("scope.runId", args.scope.runId)
          .eq("supplierId", proposal.supplierId),
      )
      .unique();
    if ((supplier?.activeRevision ?? 0) !== proposal.expectedRevision)
      deny(
        "supplier_revision_conflict",
        "Supplier proposal must bind the current approved revision",
      );
    if (supplier?.activeRevision) {
      const prior = await currentSupplier(ctx, args.scope, proposal.supplierId);
      if (prior.value.contactId !== proposal.contactId)
        deny(
          "trusted_contact_change",
          "Bank-detail changes must use the previously approved contact; separately govern contact replacement before a bank change",
        );
    }
    const revisions = await ctx.db
      .query("apSupplierRevisions")
      .withIndex("by_supplier", (q) =>
        q
          .eq("scope.runId", args.scope.runId)
          .eq("supplierId", proposal.supplierId),
      )
      .collect();
    const revision = Math.max(0, ...revisions.map((r) => r.revision)) + 1;
    if (!supplier) {
      const id = await ctx.db.insert("apSuppliers", {
        scope: args.scope,
        supplierId: proposal.supplierId,
        createdAt: Date.now(),
      });
      supplier = await ctx.db.get(id);
    }
    const revisionId = await ctx.db.insert("apSupplierRevisions", {
      scope: args.scope,
      supplierId: proposal.supplierId,
      revision,
      proposal,
      hash: await sha256Hex(canonical(proposal)),
      status: "proposed",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    const result = { revisionId, revision };
    await receipt(
      ctx,
      args.scope,
      `supplier:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const verifySupplier = mutation({
  args: {
    scope: scopeValidator,
    revisionId: v.id("apSupplierRevisions"),
    verification: v.any(),
  },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const policy = await requireBusinessPolicy(ctx, args.scope);
    requireGroup(policy.value, policy.value.supplierVerificationGroup, subject);
    const row = await ctx.db.get(args.revisionId);
    assertRowScope(row, args.scope);
    const verification = supplierVerificationSchema.parse(args.verification);
    const proposal = supplierProposalSchema.parse(row!.proposal);
    if (
      row!.proposedBy === seat.seatId ||
      verification.contactId !== proposal.contactId ||
      verification.performedAt > Date.now() ||
      verification.performedAt < row!.createdAt
    )
      deny(
        "supplier_verification_invalid",
        "Independent callback must use the pre-held contact and occurred after this proposal",
      );
    if (verification.mode === "simulated" && args.scope.environment !== "local")
      deny(
        "simulated_verification_forbidden",
        "Sandbox verification requires an operator-recorded action and evidence",
      );
    await evidence(ctx, args.scope, verification.evidence, true);
    if (row!.verification) {
      if (
        row!.verifiedBy === subject &&
        canonical(row!.verification) === canonical(verification)
      )
        return { revisionId: row!._id };
      deny(
        "verification_immutable",
        "Verification result is immutable; submit a new supplier proposal",
      );
    }
    if (row!.status !== "proposed")
      deny(
        "supplier_status",
        "Only proposed supplier revisions can be verified",
      );
    await ctx.db.patch(row!._id, {
      verification,
      verifiedBy: subject,
      status: verification.result === "confirmed" ? "verified" : "rejected",
    });
    await auditDemo(ctx, args.scope, subject, "supplier_callback_recorded", {
      revisionId: row!._id,
      method: verification.method,
      mode: verification.mode,
      result: verification.result,
      evidence: verification.evidence,
    });
    return { revisionId: row!._id };
  },
});
export const approveSupplier = mutation({
  args: {
    scope: scopeValidator,
    revisionId: v.id("apSupplierRevisions"),
    expectedHash: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const policy = await requireBusinessPolicy(ctx, args.scope);
    requireGroup(policy.value, policy.value.supplierApprovalGroup, subject);
    const row = await ctx.db.get(args.revisionId);
    assertRowScope(row, args.scope);
    if (
      row!.hash !== args.expectedHash ||
      row!.verifiedBy === subject ||
      row!.proposedBy === seat.seatId ||
      !args.reason.trim()
    )
      deny(
        "supplier_segregation",
        "A different authorized human must approve the verified exact supplier change",
      );
    if (row!.status === "approved") return { revision: row!.revision };
    if (row!.status !== "verified")
      deny(
        "supplier_not_verified",
        "Independent contact verification must succeed before supplier approval",
      );
    const proposal = supplierProposalSchema.parse(row!.proposal);
    const supplier = await ctx.db
      .query("apSuppliers")
      .withIndex("by_supplier", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("supplierId", row!.supplierId),
      )
      .unique();
    if (
      !supplier ||
      (supplier.activeRevision ?? 0) !== proposal.expectedRevision
    )
      deny(
        "supplier_revision_conflict",
        "Supplier active revision changed before approval",
      );
    await ctx.db.patch(row!._id, {
      status: "approved",
      approvedBy: subject,
      approvedAt: Date.now(),
    });
    await ctx.db.patch(supplier._id, { activeRevision: row!.revision });
    await invalidateBusinessPayments(ctx, args.scope, row!.supplierId);
    await auditDemo(ctx, args.scope, subject, "supplier_revision_approved", {
      revisionId: row!._id,
      hash: row!.hash,
      reason: args.reason,
    });
    return { revision: row!.revision };
  },
});
export const delegate = mutation({
  args: {
    scope: scopeValidator,
    idempotencyKey: v.string(),
    delegation: v.any(),
  },
  handler: async (ctx, args) => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const policy = await requireBusinessPolicy(ctx, args.scope);
    const delegation = delegationSchema.parse(args.delegation);
    requireGroup(policy.value, delegation.groupId, subject);
    await assertHumanSubject(ctx, args.scope, delegation.toSubject);
    if (
      delegation.toSubject === subject ||
      delegation.validUntil - delegation.validFrom >
        policy.value.maxDelegationMs ||
      delegation.validUntil <= Date.now()
    )
      deny(
        "invalid_delegation",
        "Delegation must be to another human, bounded and unexpired",
      );
    const op = await replay(
      ctx,
      args.scope,
      `delegate:${args.idempotencyKey}`,
      { subject, delegation },
    );
    if (op.prior) return op.prior.result;
    const delegationId = await ctx.db.insert("apDelegations", {
      scope: args.scope,
      grantor: subject,
      delegation,
      createdAt: Date.now(),
    });
    const result = { delegationId };
    await receipt(
      ctx,
      args.scope,
      `delegate:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const revokeDelegation = mutation({
  args: {
    scope: scopeValidator,
    delegationId: v.id("apDelegations"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    const row = await ctx.db.get(args.delegationId);
    assertRowScope(row, args.scope);
    if (row!.grantor !== subject || !args.reason.trim())
      deny(
        "delegation_authority",
        "Only the original delegator may revoke with a reason",
      );
    await ctx.db.patch(row!._id, { revokedAt: row!.revokedAt ?? Date.now() });
    await invalidateBusinessPayments(ctx, args.scope);
    return { revoked: true };
  },
});
export const view = query({
  args: { scope: scopeValidator },
  handler: async (ctx, args) => {
    await requirePaymentHuman(ctx, args.scope);
    return {
      policies: await ctx.db
        .query("apBusinessPolicies")
        .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      suppliers: await ctx.db
        .query("apSuppliers")
        .withIndex("by_supplier", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      revisions: await ctx.db
        .query("apSupplierRevisions")
        .withIndex("by_supplier", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      delegations: await ctx.db
        .query("apDelegations")
        .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
    };
  },
});
