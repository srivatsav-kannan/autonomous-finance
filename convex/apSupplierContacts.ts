import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { BankScope } from "../src/integrations/contracts";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import {
  requirePaymentHuman,
  requirePaymentSeat,
  assertRowScope,
  auditDemo,
} from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { deny, replay, receipt } from "./lib/apSystem/shared";
import {
  requireBusinessPolicy,
  requireGroup,
  readApprovedSupplierRevision,
  assertContactChangeParticipants,
} from "./lib/apSystem/businessAuthority";
import { independentContactEvidence } from "./lib/apSystem/supplierContactEvidence";
import { invalidateBusinessPayments } from "./lib/apSystem/businessInvalidation";
import {
  contactChangeProposalSchema,
  contactChangeAttestationSchema,
  contactChangeDecisionSchema,
  type SupplierContactView,
} from "../src/ap-system/supplier-contact-contracts";

async function changeRow(
  ctx: MutationCtx,
  scope: BankScope,
  id: string,
  hash: string,
) {
  const normalized = ctx.db.normalizeId("apSupplierContactChanges", id),
    row = normalized ? await ctx.db.get(normalized) : null;
  assertRowScope(row, scope);
  if (!row || row.hash !== hash)
    deny(
      "contact_change_hash",
      "Review must bind the exact immutable contact proposal",
    );
  return row;
}
async function context(
  ctx: MutationCtx,
  scope: BankScope,
  row: Doc<"apSupplierContactChanges">,
) {
  const policy = await requireBusinessPolicy(ctx, scope),
    p = contactChangeProposalSchema.parse(row.proposal);
  const prior = await readApprovedSupplierRevision(ctx, scope, p.supplierId);
  const supplier = (await ctx.db
    .query("apSuppliers")
    .withIndex("by_supplier", (q) =>
      q.eq("scope.runId", scope.runId).eq("supplierId", p.supplierId),
    )
    .unique())!;
  if (row.status !== "proposed" || supplier.contactReviewId !== row._id)
    deny(
      "contact_change_status",
      "Only the current unresolved proposal can receive a new decision; supersede a rejected or stale proposal",
    );
  if (
    policy.hash !== row.policyHash ||
    prior.hash !== row.supplierHash ||
    prior.revision !== p.expectedRevision
  )
    deny(
      "contact_change_stale",
      "Policy or supplier revision changed; prepare a fresh proposal and independent reviews",
    );
  return { policy, p, supplier };
}
export const propose = mutation({
  args: {
    scope: scopeValidator,
    seatId: v.string(),
    token: v.string(),
    idempotencyKey: v.string(),
    proposal: v.any(),
  },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]);
    const proposal = contactChangeProposalSchema.parse(args.proposal);
    const op = await replay(
      ctx,
      args.scope,
      `contact-change:${args.idempotencyKey}`,
      { proposal, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    const policy = await requireBusinessPolicy(ctx, args.scope),
      prior = await readApprovedSupplierRevision(
        ctx,
        args.scope,
        proposal.supplierId,
      );
    const supplier = (await ctx.db
      .query("apSuppliers")
      .withIndex("by_supplier", (q) =>
        q
          .eq("scope.runId", args.scope.runId)
          .eq("supplierId", proposal.supplierId),
      )
      .unique())!;
    const authorized = supplier.contactAuthorityId
      ? await ctx.db.get(supplier.contactAuthorityId)
      : null;
    const oldContactId = authorized
      ? contactChangeProposalSchema.parse(authorized.proposal).newContactId
      : prior.value.contactId;
    if (
      prior.revision !== proposal.expectedRevision ||
      oldContactId !== proposal.oldContactId
    )
      deny(
        "contact_change_stale",
        "Bind the current immutable supplier revision and governed contact",
      );
    if ((supplier.contactReviewId ?? undefined) !== proposal.supersedesChangeId)
      deny(
        "contact_change_conflict",
        "A current proposal must be explicitly superseded; concurrent proposals cannot silently replace it",
      );
    if (
      proposal.oldChannel.status === "unavailable" &&
      !policy.value.supplierContactEscalationGroup
    )
      deny(
        "contact_escalation_policy_required",
        "Configure an independent escalation group before bypassing an unavailable old channel",
      );
    const contactId = ctx.db.normalizeId(
        "apSupplierContacts",
        proposal.newContactId,
      ),
      contact = contactId ? await ctx.db.get(contactId) : null;
    if (!contact || contact.supplierId !== proposal.supplierId)
      deny(
        "trusted_contact_required",
        "Retain a source-bound contact for this supplier before proposing replacement",
      );
    assertRowScope(contact, args.scope);
    await independentContactEvidence(
      ctx,
      args.scope,
      proposal.oldChannel.evidence,
    );
    const createdAt = Date.now();
    const hash = await sha256Hex(
      canonical({
        proposal,
        policyHash: policy.hash,
        supplierHash: prior.hash,
        proposedBy: seat.seatId,
      }),
    );
    const data = {
      scope: args.scope,
      supplierId: proposal.supplierId,
      proposal,
      hash,
      policyHash: policy.hash,
      supplierHash: prior.hash,
      proposedBy: seat.seatId,
      status: "proposed",
      createdAt,
    };
    const changeId = await ctx.db.insert("apSupplierContactChanges", data);
    await assertContactChangeParticipants(
      ctx,
      args.scope,
      (await ctx.db.get(changeId))!,
      policy.value,
    );
    if (supplier.contactReviewId)
      await ctx.db.patch(supplier.contactReviewId, { status: "superseded" });
    await ctx.db.patch(supplier._id, { contactReviewId: changeId });
    // A controller proposal holds new authority; only a human decision may cancel existing unsent operations.
    const result = { changeId, hash };
    await receipt(
      ctx,
      args.scope,
      `contact-change:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    await auditDemo(
      ctx,
      args.scope,
      seat.seatId,
      "supplier_contact_change_proposed",
      result,
    );
    return result;
  },
});
const reviewArgs = {
  scope: scopeValidator,
  changeId: v.id("apSupplierContactChanges"),
  expectedHash: v.string(),
  attestation: v.any(),
};
async function recordReview(
  ctx: MutationCtx,
  args: {
    scope: BankScope;
    changeId: Id<"apSupplierContactChanges">;
    expectedHash: string;
    attestation: unknown;
  },
  kind: "verification" | "escalation",
) {
  const { subject, seat } = await requirePaymentHuman(ctx, args.scope);
  const row = await changeRow(
    ctx,
    args.scope,
    args.changeId,
    args.expectedHash,
  );
  const attestation = contactChangeAttestationSchema.parse(args.attestation);
  const policy = await requireBusinessPolicy(ctx, args.scope);
  const group =
    kind === "verification"
      ? policy.value.supplierVerificationGroup
      : policy.value.supplierContactEscalationGroup;
  if (!group)
    deny(
      "contact_escalation_policy_required",
      "Explicit contact escalation policy is required",
    );
  requireGroup(policy.value, group, subject);
  const prior = row[kind];
  if (prior) {
    const { subject: oldSubject, seatId, recordedAt, ...old } = prior;
    if (
      subject === oldSubject &&
      seat.seatId === seatId &&
      canonical(old) === canonical(attestation)
    )
      return { changeId: row._id };
    deny(
      "contact_review_immutable",
      "Retained review cannot be overwritten; supersede the proposal",
    );
  }
  const { p } = await context(ctx, args.scope, row);
  if (
    attestation.performedAt < row.createdAt ||
    attestation.performedAt > Date.now()
  )
    deny(
      "contact_review_time",
      "Record a review actually performed after this proposal, never a future action",
    );
  if (attestation.mode === "simulated" && args.scope.environment !== "local")
    deny(
      "simulated_verification_forbidden",
      "Simulation is local only; operator-recorded evidence must reflect an actual independently performed review",
    );
  if (
    kind === "verification" &&
    (p.oldChannel.status === "available" ||
      p.resolution === "retain_current") &&
    attestation.method !== "old_channel_confirmation"
  )
    deny(
      "old_channel_confirmation_required",
      "Confirm through the existing held channel when it is available or being restored",
    );
  if (
    kind === "escalation" &&
    (p.oldChannel.status !== "unavailable" ||
      attestation.method !== "independent_reestablishment" ||
      !row.verification)
  )
    deny(
      "contact_escalation_invalid",
      "Escalation follows independent verification of an unavailable channel and records why alternate evidence is sufficient",
    );
  const review = {
    ...attestation,
    subject,
    seatId: seat.seatId,
    recordedAt: Date.now(),
  };
  await assertContactChangeParticipants(
    ctx,
    args.scope,
    { ...row, [kind]: review },
    policy.value,
  );
  await ctx.db.patch(row._id, { [kind]: review });
  await auditDemo(
    ctx,
    args.scope,
    subject,
    `supplier_contact_${kind}_recorded`,
    { changeId: row._id, mode: attestation.mode, method: attestation.method },
  );
  return { changeId: row._id };
}
export const verify = mutation({
  args: reviewArgs,
  handler: (ctx, args) => recordReview(ctx, args, "verification"),
});
export const escalate = mutation({
  args: reviewArgs,
  handler: (ctx, args) => recordReview(ctx, args, "escalation"),
});
export const decide = mutation({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args) => {
    const { subject, seat } = await requirePaymentHuman(ctx, args.scope),
      input = contactChangeDecisionSchema.parse(args.input);
    const row = await changeRow(
        ctx,
        args.scope,
        input.changeId,
        input.expectedHash,
      ),
      policy = await requireBusinessPolicy(ctx, args.scope);
    requireGroup(policy.value, policy.value.supplierApprovalGroup, subject);
    if (row.decision) {
      if (
        row.decision.subject === subject &&
        row.decision.seatId === seat.seatId &&
        row.decision.outcome === input.outcome &&
        row.decision.reason === input.reason
      )
        return { changeId: row._id, status: row.decision.outcome };
      deny(
        "contact_decision_immutable",
        "A contact decision cannot be overwritten; submit a superseding proposal",
      );
    }
    const { p, supplier } = await context(ctx, args.scope, row);
    const decision = {
      subject,
      seatId: seat.seatId,
      outcome: input.outcome,
      reason: input.reason,
      recordedAt: Date.now(),
    };
    await assertContactChangeParticipants(
      ctx,
      args.scope,
      { ...row, decision },
      policy.value,
      input.outcome === "approved",
    );
    await ctx.db.patch(row._id, { decision, status: input.outcome });
    if (input.outcome === "approved") {
      await ctx.db.patch(supplier._id, {
        contactReviewId: undefined,
        ...(p.resolution === "replace" ? { contactAuthorityId: row._id } : {}),
      });
      await invalidateBusinessPayments(ctx, args.scope, p.supplierId);
    }
    // Rejection retains the safety hold. A fresh explicit retain_current or replacement proposal must resolve it.
    await auditDemo(
      ctx,
      args.scope,
      subject,
      "supplier_contact_change_decided",
      { changeId: row._id, outcome: input.outcome, reason: input.reason },
    );
    return { changeId: row._id, status: input.outcome };
  },
});
export const view = query({
  args: { scope: scopeValidator },
  handler: async (ctx, args): Promise<SupplierContactView> => {
    await requirePaymentHuman(ctx, args.scope);
    const [changes, suppliers, contacts] = await Promise.all([
      ctx.db
        .query("apSupplierContactChanges")
        .withIndex("by_supplier", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      ctx.db
        .query("apSuppliers")
        .withIndex("by_supplier", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
      ctx.db
        .query("apSupplierContacts")
        .withIndex("by_supplier", (q) => q.eq("scope.runId", args.scope.runId))
        .collect(),
    ]);
    for (const row of [...changes, ...suppliers, ...contacts])
      assertRowScope(row, args.scope);
    return {
      changes: changes.map((r) => ({
        changeId: r._id,
        supplierId: r.supplierId,
        proposal: contactChangeProposalSchema.parse(r.proposal),
        hash: r.hash,
        policyHash: r.policyHash,
        supplierHash: r.supplierHash,
        proposedBy: r.proposedBy,
        status: r.status as SupplierContactView["changes"][number]["status"],
        createdAt: r.createdAt,
        verification: r.verification ?? null,
        escalation: r.escalation ?? null,
        decision: r.decision ?? null,
      })),
      suppliers: suppliers.map((r) => ({
        supplierId: r.supplierId,
        activeRevision: r.activeRevision ?? null,
        contactReviewId: r.contactReviewId ?? null,
        contactAuthorityId: r.contactAuthorityId ?? null,
      })),
      contacts: contacts.map((r) => ({
        contactId: r._id,
        supplierId: r.supplierId,
        phone: r.phone,
        evidence: r.evidence,
        origin: r.origin ?? null,
        recordedBy: r.recordedBy,
        recordedSeatId: r.recordedSeatId ?? null,
        mode: r.mode,
        createdAt: r.createdAt,
      })),
    };
  },
});
