import {creditApplication as loadCreditApplication} from "./lib/apSystem/accountingCredits";
import {loadRecognizedBusinessExport} from "./lib/apSystem/businessExport";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import {
  requirePaymentSeat,
  requirePaymentHuman,
  auditDemo,
  assertRowScope,
} from "./lib/demoAuth";
import { accountingCorrectionRequestSchema } from "../src/ap-system/quickbooks/corrections";
import { domainVoteSchema } from "../src/ap-system/domain-contracts";
import { replay, receipt, deny, caseRow } from "./lib/apSystem/shared";
import {
  resolveVotePrincipal,
  assertIndependentVotes,
  assertApprovalVotes,
  type BusinessVote,
} from "./lib/apSystem/businessAuthority";
import {
  evaluateCorrection,
  correctionRecord,
  approvedCorrection,
} from "./lib/apSystem/accountingCorrectionAuthority";
export const propose = mutation({
  args: {
    scope: scopeValidator,
    seatId: v.string(),
    token: v.string(),
    input: v.any(),
  },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, ["controller"]);
    const request = accountingCorrectionRequestSchema.parse(args.input);
    const key = `accounting-correction:${request.idempotencyKey}`;
    const op = await replay(ctx, args.scope, key, {
      request,
      actor: seat.seatId,
    });
    if (op.prior) return op.prior.result;
    const e = await evaluateCorrection(ctx, args.scope, request);
    const duplicate = await ctx.db
      .query("apAccountingCorrections")
      .withIndex("by_identity", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("identity", e.identity),
      )
      .collect();
    if (duplicate.some((p) => p.status !== "rejected"))
      deny(
        "correction_identity_exists",
        "Existing correction identity must be reviewed or replayed",
      );
    const id = await ctx.db.insert("apAccountingCorrections", {
      scope: args.scope,
      caseId: e.row._id,
      identity: e.identity,
      request,
      payload: e.payload,
      hash: e.hash,
      policyHash: e.policy.hash,
      supplierHash: e.supplier.hash,
      amountCents: e.amountCents,
      route: e.route,
      stage: 0,
      stageStartedAt: Date.now(),
      votes: [],
      status: "pending",
      proposedBy: seat.seatId,
      createdAt: Date.now(),
    });
    await auditDemo(
      ctx,
      args.scope,
      seat.seatId,
      "accounting_correction_proposed",
      { correctionId: id, hash: e.hash, kind: request.kind },
    );
    const result = {
      proposalId: id,
      proposalHash: e.hash,
      kind: request.kind,
      amountCents: e.amountCents,
      route: e.route,
    };
    await receipt(ctx, args.scope, key, op.payloadHash, result);
    return result;
  },
});
export const vote = mutation({
  args: { scope: scopeValidator, input: v.any() },
  handler: async (ctx, args) => {
    const { seat, subject } = await requirePaymentHuman(ctx, args.scope);
    const request = domainVoteSchema.parse(args.input);
    const key = `accounting-correction-vote:${request.idempotencyKey}`;
    const op = await replay(ctx, args.scope, key, { request, subject });
    if (op.prior) return op.prior.result;
    const row = await correctionRecord(ctx, args.scope, request.proposalId);
    if (row.status !== "pending" || row.hash !== request.proposalHash)
      deny(
        "pending_correction_required",
        "Exact pending correction hash required",
      );
    const e = await evaluateCorrection(
      ctx,
      args.scope,
      accountingCorrectionRequestSchema.parse(row.request),
      row._id,
    );
    if (row.hash !== e.hash)
      deny(
        "stale_correction_authority",
        "Correction evidence or policy changed",
      );
    const principal = await resolveVotePrincipal(
      ctx,
      args.scope,
      e.policy.value,
      row,
      subject,
      request.delegationId,
    );
    if (
      [principal.subjectSeatId, principal.principalSeatId].some(
        (id) => id === row.proposedBy || id === e.row.createdBy,
      ) ||
      seat.seatId === row.proposedBy
    )
      deny(
        "correction_self_approval",
        "Controller/case proposer cannot approve their own correction",
      );
    const votes: BusinessVote[] = [
      ...row.votes,
      {
        ...principal,
        subject,
        stage: row.stage,
        stageStartedAt: row.stageStartedAt,
        at: Date.now(),
        delegationId: request.delegationId ?? null,
      },
    ];
    await assertIndependentVotes(ctx, args.scope, votes);
    if (request.outcome === "rejected") {
      await ctx.db.patch(row._id, {
        status: "rejected",
        completedAt: Date.now(),
      });
      const result = { status: "rejected", proposalId: row._id };
      await receipt(ctx, args.scope, key, op.payloadHash, result);
      return result;
    }
    const complete =
      votes.filter((v) => v.stage === row.stage).length >=
      row.route[row.stage].quorum;
    const stage = complete ? row.stage + 1 : row.stage;
    const status = stage >= row.route.length ? "approved" : "pending";
    if (status === "approved")
      await assertApprovalVotes(ctx, args.scope, e.policy.value, {
        ...row,
        votes,
      });
    await ctx.db.patch(row._id, {
      votes,
      stage,
      stageStartedAt: complete ? Date.now() : row.stageStartedAt,
      status,
      ...(status === "approved" ? { completedAt: Date.now() } : {}),
    });
    await auditDemo(ctx, args.scope, subject, "accounting_correction_vote", {
      correctionId: row._id,
      hash: row.hash,
      status,
      reason: request.reason,
    });
    const result = { status, proposalId: row._id };
    await receipt(ctx, args.scope, key, op.payloadHash, result);
    return result;
  },
});
export const proposals = query({
  args: { scope: scopeValidator, caseId: v.id("apCaseRecords") },
  handler: async (ctx, args) => {
    await requirePaymentHuman(ctx, args.scope);
    await caseRow(ctx, args.scope, args.caseId);
    return ctx.db
      .query("apAccountingCorrections")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("caseId", args.caseId),
      )
      .collect();
  },
});
export const current = query({
  args: {
    scope: scopeValidator,
    correctionId: v.id("apAccountingCorrections"),
  },
  handler: async (ctx, args) => {
    await requirePaymentHuman(ctx, args.scope);
    return approvedCorrection(ctx, args.scope, args.correctionId);
  },
});

/** Read the validated immutable group; selecting a component never guesses its total. */
export const creditApplication = query({
  args: {scope: scopeValidator, caseId: v.id("apCaseRecords"), creditApplicationId: v.id("apCreditApplications")},
  handler: async (ctx, args) => {
    await requirePaymentHuman(ctx, args.scope);
    const row = await caseRow(ctx, args.scope, args.caseId);
    if (!row.billId) throw Error("recognized_bill_required");
    const bill = await ctx.db.get(row.billId);
    assertRowScope(bill, args.scope);
    if (!bill) throw Error("recognized_bill_required");
    const recognized = await loadRecognizedBusinessExport(ctx, args.scope, row._id);
    if (recognized.kind !== "invoice") throw Error("recognized_invoice_required");
    return loadCreditApplication(ctx, args.scope, row._id, bill._id, args.creditApplicationId);
  },
});
