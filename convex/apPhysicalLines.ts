import { quantityMicros } from "../src/ap-system/accounting";
import { quantityString } from "../src/ap-system/business-policy";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import {
  requirePaymentSeat,
  requirePaymentHuman,
  assertRowScope,
  auditDemo,
} from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { deny, replay, receipt } from "./lib/apSystem/shared";
import {
  requireBusinessPolicy,
  requireGroup,
} from "./lib/apSystem/businessAuthority";
import { validatePhysicalProposal } from "./lib/apSystem/physicalLines";
import {
  physicalMappingProposalSchema,
  physicalLineOperationSchemas,
  type PhysicalLineView,
} from "../src/ap-system/physical-line-contracts";
export const propose = mutation({
  args: {
    scope: scopeValidator,
    seatId: v.string(),
    token: v.string(),
    idempotencyKey: v.string(),
    proposal: v.any(),
  },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]),
      proposal = physicalMappingProposalSchema.parse(args.proposal);
    const op = await replay(
      ctx,
      args.scope,
      `physical-map:${args.idempotencyKey}`,
      { proposal, actor: seat.seatId },
    );
    if (op.prior) return op.prior.result;
    const checked = await validatePhysicalProposal(ctx, args.scope, proposal);
    const hash = await sha256Hex(
      canonical({
        proposal,
        parsedHash: checked.parsedHash,
        policyHash: checked.policy.hash,
        proposedBy: seat.seatId,
      }),
    );
    const reviewId = await ctx.db.insert("apPhysicalLineReviews", {
      scope: args.scope,
      caseId: checked.row._id,
      sourceHash: proposal.source.sha256,
      proposal,
      hash,
      policyHash: checked.policy.hash,
      parsedHash: checked.parsedHash,
      status: "proposed",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    const result = { reviewId, hash };
    await receipt(
      ctx,
      args.scope,
      `physical-map:${args.idempotencyKey}`,
      op.payloadHash,
      result,
    );
    return result;
  },
});
export const decide = mutation({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope),
      input = physicalLineOperationSchemas.decide.parse(args.input);
    const id = ctx.db.normalizeId("apPhysicalLineReviews", input.reviewId),
      row = id ? await ctx.db.get(id) : null;
    assertRowScope(row, args.scope);
    if (!row || row.hash !== input.expectedHash)
      deny("physical_review_hash", "Approve the exact immutable mapping hash");
    const policy = await requireBusinessPolicy(ctx, args.scope),
      group = policy.value.receiptIdentityApprovalGroup;
    if (!group)
      deny(
        "physical_policy_required",
        "Configure the physical identity reviewer group",
      );
    requireGroup(policy.value, group, subject);
    if (seat.seatId === row.proposedBy)
      deny(
        "physical_review_segregation",
        "The physical identity reviewer must be independent from the proposer",
      );
    if (row.decision) {
      if (
        row.decision.subject === subject &&
        row.decision.seatId === seat.seatId &&
        row.decision.outcome === input.outcome &&
        row.decision.reason === input.reason
      )
        return {
          reviewId: row._id,
          catalogId: row.catalogId ?? null,
          status: row.status,
        };
      deny(
        "physical_review_immutable",
        "A physical identity decision is immutable; submit a new proposal",
      );
    }
    if (row.status !== "proposed" || policy.hash !== row.policyHash)
      deny(
        "physical_review_stale",
        "The mapping policy changed before approval",
      );
    const checked = await validatePhysicalProposal(
      ctx,
      args.scope,
      physicalMappingProposalSchema.parse(row.proposal),
    );
    if (checked.parsedHash !== row.parsedHash)
      deny(
        "physical_review_stale",
        "The exact original line interpretation changed",
      );
    let catalogId = checked.known?._id;
    if (input.outcome === "approved" && !catalogId) {
      const payload = {
        source: row.proposal.source,
        physicalLines: checked.physical,
      };
      catalogId = await ctx.db.insert("apPhysicalSources", {
        scope: args.scope,
        sourceHash: row.sourceHash,
        supplierId: checked.parsed.p.supplierId,
        purpose: checked.parsed.purpose,
        payload,
        hash: await sha256Hex(
          canonical({
            payload,
            supplierId: checked.parsed.p.supplierId,
            purpose: checked.parsed.purpose,
          }),
        ),
        reviewId: row._id,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(row._id, {
      status: input.outcome,
      ...(catalogId ? { catalogId } : {}),
      decision: {
        subject,
        seatId: seat.seatId,
        outcome: input.outcome,
        reason: input.reason,
        at: Date.now(),
      },
    });
    await auditDemo(
      ctx,
      args.scope,
      subject,
      "physical_line_mapping_reviewed",
      { reviewId: row._id, hash: row.hash, outcome: input.outcome },
    );
    return {
      reviewId: row._id,
      catalogId: catalogId ?? null,
      status: input.outcome,
    };
  },
});
export const view = query({
  args: { scope: scopeValidator, caseId: v.optional(v.id("apCaseRecords")) },
  handler: async (ctx, args): Promise<PhysicalLineView> => {
    await requirePaymentHuman(ctx, args.scope);
    const catalogs = await ctx.db
      .query("apPhysicalSources")
      .withIndex("by_hash", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    const reviews = await ctx.db
      .query("apPhysicalLineReviews")
      .withIndex("by_case", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    for (const row of [...catalogs, ...reviews])
      assertRowScope(row, args.scope);
    const uses = await ctx.db
      .query("apReceiptConsumptions")
      .withIndex("by_bill", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    const accruals = await ctx.db
      .query("apAccruals")
      .withIndex("by_run", (q) => q.eq("scope.runId", args.scope.runId))
      .collect();
    return {
      catalogs: catalogs.map((r) => ({
        catalogId: r._id,
        sourceHash: r.sourceHash,
        supplierId: r.supplierId,
        purpose: r.purpose,
        hash: r.hash,
        physicalLines: r.payload.physicalLines,
        capacities: r.payload.physicalLines.map(
          (line: { physicalLineId: string; capacity: string }) => {
            const used = uses
              .filter(
                (u) =>
                  u.physicalSourceId === r._id &&
                  u.physicalLineId === line.physicalLineId,
              )
              .reduce((n, u) => n + quantityMicros(u.quantity), 0n);
            const accrued = accruals
              .filter(
                (a) =>
                  a.payload.source.sha256 === r.sourceHash &&
                  a.payload.identity?.physicalLineId === line.physicalLineId,
              )
              .reduce(
                (n, a) =>
                  n +
                  quantityMicros(a.quantity) -
                  quantityMicros(a.reversedQuantity),
                0n,
              );
            const remaining = quantityMicros(line.capacity) - used - accrued;
            return {
              physicalLineId: line.physicalLineId,
              consumedQuantity: quantityString(used),
              accruedQuantity: quantityString(accrued),
              remainingQuantity: quantityString(
                remaining > 0n ? remaining : 0n,
              ),
            };
          },
        ),
      })),
      reviews: reviews
        .filter((r) => !args.caseId || r.caseId === args.caseId)
        .map((r) => ({
          reviewId: r._id,
          caseId: r.caseId,
          proposal: physicalMappingProposalSchema.parse(r.proposal),
          hash: r.hash,
          parsedHash: r.parsedHash,
          policyHash: r.policyHash,
          status: r.status,
          catalogId: r.catalogId ?? null,
          proposedBy: r.proposedBy,
          createdAt: r.createdAt,
          decision: r.decision ?? null,
        })),
    };
  },
});
