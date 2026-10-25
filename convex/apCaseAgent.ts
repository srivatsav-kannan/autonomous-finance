import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  scopeValidator,
  assertRowScope,
  requirePaymentSeat,
  requirePaymentHuman,
} from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { caseRow, readAuth, replay, receipt } from "./lib/apSystem/shared";
import { projectCase } from "./lib/apSystem/projection";
import { ensureAPCaseWork } from "./lib/apSystem/agentWork";
import { prepareAPCasePayment } from "./lib/apSystem/casePayment";
import { recordAgentTransition } from "./lib/apSystem/agentAudit";
import {
  AP_AGENT_VERSION,
  apCaseProgress,
  planAPCase,
} from "../src/ap-system/agent-policy";

const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
const LEASE_MS = 30_000,
  POLL_MS = 5_000,
  WAIT_MS = 24 * 60 * 60 * 1000,
  MAX_ATTEMPTS = 4,
  MAX_TRANSITIONS = 64;
type Work = Doc<"apCaseWork">;
async function facts(ctx: MutationCtx, w: Work) {
  const row = await caseRow(ctx, w.scope, w.caseId),
    detail = await projectCase(ctx, row);
  return {
    row,
    detail,
    plan: planAPCase(detail),
    fingerprint: await sha256Hex(canonical(apCaseProgress(detail))),
  };
}
async function escalate(
  ctx: MutationCtx,
  w: Work,
  actor: string,
  reason: string,
) {
  const before = await facts(ctx, w);
  await ctx.db.patch(w._id, {
    status: "escalated",
    stage: "operator_resolution",
    owner: "controller",
    reason,
    leaseOwner: undefined,
    leaseUntil: undefined,
    nextCheckAt: Number.MAX_SAFE_INTEGER,
    updatedAt: Date.now(),
  });
  await recordAgentTransition(
    ctx,
    w,
    actor,
    "escalate",
    "escalated",
    reason,
    before.detail,
  );
}
export const enroll = mutation({
  args: { ...agent, caseId: v.string() },
  handler: async (ctx, args) => {
    await requirePaymentSeat(ctx, args, ["ap_clerk"]);
    return ensureAPCaseWork(ctx, await caseRow(ctx, args.scope, args.caseId));
  },
});
/** Read-only typed tool; authorization is the same as the AP workspace projection. */
export const inspect = query({
  args: {
    scope: scopeValidator,
    seatId: v.optional(v.string()),
    token: v.optional(v.string()),
    caseId: v.string(),
  },
  handler: async (ctx, args) => {
    await readAuth(ctx, args);
    const row = await caseRow(ctx, args.scope, args.caseId);
    const detail = await projectCase(ctx, row);
    const work = await ctx.db
      .query("apCaseWork")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("caseId", row._id),
      )
      .unique();
    return {
      detail,
      plan: planAPCase(detail),
      work: work
        ? {
            caseId: row._id,
            status: work.status,
            stage: work.stage,
            owner: work.owner,
            reason: work.reason,
            requirements: work.requirements,
            waitSince: work.waitSince ?? null,
            deadlineAt: work.deadlineAt ?? null,
            updatedAt: work.updatedAt,
          }
        : null,
    };
  },
});
/** A bounded persistent poll closes lost-notification and event-before-wait races. */
export const claim = mutation({
  args: { ...agent, requestId: v.string() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, [
      "ap_clerk",
      "payments",
    ]);
    if (!args.requestId || args.requestId.length > 160)
      throw Error("Invalid claim request identity");
    const op = await replay(ctx, args.scope, `agent-claim:${args.requestId}`, {
      actor: seat.seatId,
    });
    if (op.prior) return op.prior.result;
    const now = Date.now();
    const rows = await ctx.db
      .query("apCaseWork")
      .withIndex("by_due", (q) =>
        q.eq("scope.runId", args.scope.runId).lte("nextCheckAt", now),
      )
      .take(50);
    for (const old of rows) {
      assertRowScope(old, args.scope);
      if (["paused", "escalated"].includes(old.status)) continue;
      if (old.version !== AP_AGENT_VERSION) {
        await escalate(
          ctx,
          old,
          seat.seatId,
          "Worker/schema version mismatch requires operator migration.",
        );
        continue;
      }
      if (old.status === "leased" && (old.leaseUntil ?? 0) > now) continue;
      const f = await facts(ctx, old),
        changed = old.fingerprint !== f.fingerprint,
        recoveryChanged = old.attemptFingerprint !== f.fingerprint;
      if (!changed && ["waiting", "complete"].includes(old.status)) {
        if (old.status === "waiting" && (old.deadlineAt ?? Infinity) <= now)
          await escalate(
            ctx,
            old,
            seat.seatId,
            "Wait deadline expired; owner must resolve missing evidence or approval.",
          );
        else await ctx.db.patch(old._id, { nextCheckAt: now + POLL_MS });
        continue;
      }
      if (
        old.transitions >= MAX_TRANSITIONS ||
        (!recoveryChanged && old.attempts >= MAX_ATTEMPTS)
      ) {
        await escalate(
          ctx,
          old,
          seat.seatId,
          "Case progress or recovery budget exhausted; explicit operator resume required.",
        );
        continue;
      }
      // Any authenticated role can discover work, but only its named owner can claim it.
      const role = f.plan.role;
      if (role !== seat.role) {
        const handoff =
          old.status !== "queued" ||
          old.role !== role ||
          old.stage !== f.plan.stage ||
          recoveryChanged;
        await ctx.db.patch(old._id, {
          status: "queued",
          role,
          stage: f.plan.stage,
          owner: f.plan.owner,
          reason: f.plan.reason,
          requirements: f.plan.requirements,
          generation: old.generation + (handoff ? 1 : 0),
          attemptFingerprint: f.fingerprint,
          attempts: recoveryChanged ? 0 : old.attempts,
          leaseOwner: undefined,
          leaseUntil: undefined,
          nextCheckAt: now,
          updatedAt: handoff ? now : old.updatedAt,
        });
        if (handoff)
          await recordAgentTransition(
            ctx,
            old,
            seat.seatId,
            "handoff",
            "handoff",
            f.plan.reason,
            f.detail,
          );
        continue;
      }
      const generation = old.generation + 1;
      await ctx.db.patch(old._id, {
        status: "leased",
        role,
        attemptFingerprint: f.fingerprint,
        leaseOwner: seat.seatId,
        leaseStartedAt: now,
        leaseUntil: now + LEASE_MS,
        nextCheckAt: now + LEASE_MS,
        generation,
        attempts: recoveryChanged ? 1 : old.attempts + 1,
        claimRequestId: args.requestId,
        updatedAt: now,
      });
      const result = {
        caseId: old.caseId,
        generation,
        leaseUntil: now + LEASE_MS,
      };
      await receipt(
        ctx,
        args.scope,
        `agent-claim:${args.requestId}`,
        op.payloadHash,
        result,
      );
      await recordAgentTransition(
        ctx,
        old,
        seat.seatId,
        "claim",
        "claimed",
        "Agent claimed the current case under a fenced lease.",
        f.detail,
      );
      return result;
    }
    return null;
  },
});
/** Lease fencing, current-state validation, optional proposal and queue transition commit atomically. */
export const advance = mutation({
  args: { ...agent, caseId: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, [
      "ap_clerk",
      "payments",
    ]);
    const row = await caseRow(ctx, args.scope, args.caseId);
    const w = await ctx.db
      .query("apCaseWork")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("caseId", row._id),
      )
      .unique();
    if (!w) throw Error("Case work not enrolled");
    assertRowScope(w, args.scope);
    if (
      w.lastCompletedGeneration === args.generation &&
      w.lastCompletedBy === seat.seatId
    )
      return { status: w.status, stage: w.stage, replayed: true };
    if (
      w.version !== AP_AGENT_VERSION ||
      w.status !== "leased" ||
      w.leaseOwner !== seat.seatId ||
      w.role !== seat.role ||
      w.generation !== args.generation ||
      (w.leaseUntil ?? 0) <= Date.now()
    )
      throw Error("Stale or foreign AP case lease");
    let f = await facts(ctx, w);
    const beforeCase = f.detail;
    if (f.plan.role !== seat.role) {
      await ctx.db.patch(w._id, {
        status: "queued",
        role: f.plan.role,
        stage: f.plan.stage,
        owner: f.plan.owner,
        reason: f.plan.reason,
        requirements: f.plan.requirements,
        leaseOwner: undefined,
        leaseUntil: undefined,
        nextCheckAt: Date.now(),
        lastCompletedGeneration: args.generation,
        lastCompletedBy: seat.seatId,
        updatedAt: Date.now(),
      });
      await recordAgentTransition(
        ctx,
        w,
        seat.seatId,
        "handoff",
        "handoff",
        f.plan.reason,
        beforeCase,
      );
      return { status: "queued", stage: f.plan.stage, replayed: false };
    }
    if (f.plan.action === "prepare_payment") {
      await prepareAPCasePayment(ctx, {
        ...args,
        caseId: row._id,
        expectedRevision: f.row.currentRevision,
        snapshotHash: f.row.snapshotHash,
        idempotencyKey: `ap-agent:${row._id}:${f.row.currentRevision}:${f.row.snapshotHash}`,
      });
      f = await facts(ctx, w);
    }
    const now = Date.now(),
      status = f.plan.action === "complete" ? "complete" : "waiting";
    const unchanged =
      w.fingerprint === f.fingerprint && w.stage === f.plan.stage;
    await ctx.db.patch(w._id, {
      status,
      stage: f.plan.stage,
      role: f.plan.role,
      owner: f.plan.owner,
      reason: f.plan.reason,
      requirements: f.plan.requirements,
      fingerprint: f.fingerprint,
      nextCheckAt: now + POLL_MS,
      waitSince:
        status === "waiting"
          ? unchanged
            ? (w.waitSince ?? now)
            : now
          : undefined,
      deadlineAt:
        status === "waiting"
          ? unchanged
            ? (w.deadlineAt ?? now + WAIT_MS)
            : now + WAIT_MS
          : undefined,
      transitions: w.transitions + 1,
      attempts: 0,
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastCompletedGeneration: args.generation,
      lastCompletedBy: seat.seatId,
      updatedAt: now,
    });
    await recordAgentTransition(
      ctx,
      w,
      seat.seatId,
      "advance",
      f.plan.stage,
      `${f.plan.reason}${f.plan.requirements.length ? " Required: " + f.plan.requirements.join(", ") : ""}`,
      beforeCase,
      f.detail,
    );
    return { status, stage: f.plan.stage, replayed: false };
  },
});
/** A rejected atomic advancement is isolated to its case; never convert an unknown transport result into failure. */
export const failed = mutation({
  args: { ...agent, caseId: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    const { seat } = await requirePaymentSeat(ctx, args, [
      "ap_clerk",
      "payments",
    ]);
    const row = await caseRow(ctx, args.scope, args.caseId);
    const w = await ctx.db
      .query("apCaseWork")
      .withIndex("by_case", (q) =>
        q.eq("scope.runId", args.scope.runId).eq("caseId", row._id),
      )
      .unique();
    if (
      !w ||
      w.status !== "leased" ||
      w.leaseOwner !== seat.seatId ||
      w.generation !== args.generation ||
      (w.leaseUntil ?? 0) <= Date.now()
    )
      return { stale: true };
    await escalate(
      ctx,
      w,
      seat.seatId,
      "Current backend policy refused advancement; inspect the case before resuming.",
    );
    return { stale: false };
  },
});
/** Pause/resume is human-only; it never approves fields, a bill or a payment. */
export const control = mutation({
  args: {
    scope: scopeValidator,
    caseId: v.string(),
    action: v.union(v.literal("pause"), v.literal("resume")),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { subject } = await requirePaymentHuman(ctx, args.scope);
    if (!args.reason.trim() || args.reason.length > 2000)
      throw Error("An operator reason is required");
    const row = await caseRow(ctx, args.scope, args.caseId),
      id = await ensureAPCaseWork(ctx, row),
      w = (await ctx.db.get(id))!;
    const beforeCase = await projectCase(ctx, row);
    await ctx.db.patch(id, {
      status: args.action === "pause" ? "paused" : "queued",
      stage: args.action === "pause" ? "paused" : "check_case",
      owner: "ap_clerk",
      role: "ap_clerk",
      reason: args.reason,
      requirements: [],
      generation: w.generation + 1,
      attempts: 0,
      transitions: 0,
      fingerprint: undefined,
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastCompletedGeneration: undefined,
      lastCompletedBy: undefined,
      waitSince: undefined,
      deadlineAt: undefined,
      nextCheckAt:
        args.action === "pause" ? Number.MAX_SAFE_INTEGER : Date.now(),
      updatedAt: Date.now(),
    });
    await recordAgentTransition(
      ctx,
      w,
      subject,
      args.action,
      args.action,
      args.reason,
      beforeCase,
    );
    return { ok: true };
  },
});

/** Model inference can renew only its current lease, for at most five minutes from claim. */
export const renew = mutation({
  args:{...agent,caseId:v.string(),generation:v.number()},
  handler:async(ctx,args)=>{
    const {seat}=await requirePaymentSeat(ctx,args,["ap_clerk","payments"]);
    const row=await caseRow(ctx,args.scope,args.caseId);
    const w=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",args.scope.runId).eq("caseId",row._id)).unique();
    const now=Date.now();
    if(!w||w.status!=="leased"||w.leaseOwner!==seat.seatId||w.generation!==args.generation||(w.leaseUntil??0)<=now||w.leaseStartedAt===undefined||now>=w.leaseStartedAt+300_000)throw Error("Stale or exhausted agent lease");
    const leaseUntil=Math.min(now+LEASE_MS,w.leaseStartedAt+300_000);
    await ctx.db.patch(w._id,{leaseUntil,nextCheckAt:leaseUntil});return {leaseUntil};
  }
});
