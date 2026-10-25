import { assertLegacyRun } from "./lib/demoAuth";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, type Infer } from "convex/values";
import { authSeat, fail, logActivity, recordViolation, type Fail } from "./lib/kernel";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

/** The options an effectful ask offers. The kernel sets them; the asking agent cannot. */
export const EFFECT_OPTIONS = {
  payment: [{ id: "approve", label: "Approve payment" }, { id: "reject", label: "Reject payment" }],
  merge: [{ id: "merge", label: "Merge change" }, { id: "reject", label: "Don't merge" }],
  close: [{ id: "sign", label: "Co-sign close" }, { id: "hold", label: "Hold" }],
} as const;

/** An agent names the target; the kernel validates it and derives the stored effect. */
const effectRequest = v.union(
  v.object({ kind: v.literal("payment"), paymentIntentId: v.id("paymentIntents") }),
  v.object({ kind: v.literal("merge"), proposalBranch: v.string() }),
  v.object({ kind: v.literal("close"), period: v.string() }),
);
type EffectRequest = Infer<typeof effectRequest>;

async function deriveEffect(ctx: MutationCtx, runId: string, req: EffectRequest): Promise<Doc<"asks">["effect"] | Fail> {
  if (req.kind === "payment") {
    const id = ctx.db.normalizeId("paymentIntents", req.paymentIntentId);
    const intent = id ? await ctx.db.get(id) : null;
    if (!intent || intent.runId !== runId) return fail("invalid_effect", "payment intent not found in this run");
    if (intent.status !== "pending_approval") return fail("invalid_effect", `payment intent is ${intent.status}, not pending approval`);
    return {
      kind: "payment", paymentIntentId: intent._id, payee: intent.payee, amountCents: intent.amountCents, method: intent.method, dueDate: intent.dueDate,
      remitTo: { bank: intent.remitTo.bank, accountLast4: intent.remitTo.accountLast4 },
    };
  }
  if (req.kind === "merge") {
    if (!req.proposalBranch.startsWith("proposal/") || req.proposalBranch.length <= "proposal/".length) return fail("invalid_effect", "not a proposal branch");
    const proposalId = req.proposalBranch.slice("proposal/".length);
    const commits = await ctx.db.query("memoryCommits").withIndex("by_run_at", (q) => q.eq("runId", runId)).collect();
    const proposed = commits.filter((c) => c.branch === req.proposalBranch).sort((a, b) => a.at - b.at);
    if (!proposed.length) return fail("invalid_effect", `no recorded proposal ${req.proposalBranch} in this run`);
    if (commits.some((c) => c.branch === "main" && (c.trailers as Record<string, unknown> | undefined)?.["Proposal-Id"] === proposalId)) {
      return fail("invalid_effect", `proposal ${proposalId} is already merged`);
    }
    return { kind: "merge", proposalBranch: req.proposalBranch, proposalId, headSha: proposed.at(-1)!.sha, paths: [...new Set(proposed.flatMap((c) => c.paths))] };
  }
  const period = await ctx.db.query("periods").withIndex("by_run_period", (q) => q.eq("runId", runId).eq("period", req.period)).unique();
  if (!period) return fail("invalid_effect", `period ${req.period} not found in this run`);
  if (period.status !== "open") return fail("invalid_effect", `period ${req.period} is already ${period.status}`);
  return { kind: "close", period: req.period };
}

/**
 * How agents talk to people: a decision with evidence and options, not a form to fill.
 * `to` is a seat id or a role (e.g. "human_cfo", "controller").
 *
 * An ask that acts as the human (approve a payment, merge memory, co-sign a close) names its
 * target in `effect`. The kernel validates the target, stores what the answer will do, and sets
 * the options itself. Without an effect, an answer only records the human's response.
 */
export const createAsk = mutation({
  args: {
    ...seatArgs,
    to: v.string(),
    severity: v.union(v.literal("info"), v.literal("decision"), v.literal("urgent")),
    title: v.string(),
    body: v.string(),
    evidence: v.array(v.object({ label: v.string(), ref: v.string() })),
    options: v.optional(v.array(v.object({ id: v.string(), label: v.string() }))),
    taskId: v.optional(v.id("tasks")),
    effect: v.optional(effectRequest),
    dedupeKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", auth);
    if (!auth.seat.caps.asks) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("forbidden", "seat may not ask"));
    let effect: Doc<"asks">["effect"];
    if (args.effect) {
      if (args.options !== undefined) {
        return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("invalid_options", "the kernel sets the options of an ask with an effect"));
      }
      if (args.to !== "human_cfo") {
        return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("invalid_effect", "only asks to human_cfo carry an effect"));
      }
      const derived = await deriveEffect(ctx, args.runId, args.effect);
      if (derived && "ok" in derived) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", derived);
      effect = derived;
    } else if (!args.options?.length) {
      return fail("invalid_options", "an ask needs at least one option");
    }
    if (args.taskId) {
      const task = await ctx.db.get(args.taskId);
      if (!task || task.runId !== args.runId) {
        return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("invalid_task", "task not found in this run"));
      }
      const existing = await ctx.db
        .query("asks")
        .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "open"))
        .filter((q) => q.eq(q.field("taskId"), args.taskId))
        .first();
      if (existing) return { ok: true as const, askId: existing._id, duplicate: true };
    }
    // Built field by field: nothing the agent sends beyond these reaches the stored ask.
    const { seatId, runId } = args;
    const askId = await ctx.db.insert("asks", {
      runId, from: seatId, to: args.to,
      severity: effect && args.severity === "info" ? "decision" : args.severity,
      title: args.title, body: args.body, evidence: args.evidence,
      options: effect ? EFFECT_OPTIONS[effect.kind].map((o) => ({ ...o })) : args.options!,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(effect ? { effect } : {}),
      status: "open", createdAt: Date.now(),
    });
    await logActivity(ctx, runId, seatId, "asked", `Asked ${args.to}: ${args.title}`, { askId });
    return { ok: true as const, askId, duplicate: false };
  },
});

type AnswerArgs = { runId: string; seatId: string; token: string; askId: Id<"asks">; optionId: string };

/**
 * Every answer check, before anything is written: the seat, the addressee, the option, stored
 * references, and that no different answer was already recorded. A replay of the same answer passes.
 */
async function checkAnswer(ctx: MutationCtx, args: AnswerArgs, op: string) {
  const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
  if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
  const ask = await ctx.db.get(args.askId);
  if (!ask || ask.runId !== args.runId) return fail("not_found", "ask not found");
  if (ask.to !== args.seatId && ask.to !== auth.seat.role) {
    return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `ask is addressed to ${ask.to}`));
  }
  if (ask.from === args.seatId) {
    return await recordViolation(ctx, args.runId, args.seatId, op, fail("sod", "a seat cannot answer its own ask"));
  }
  if (!ask.options.some((o) => o.id === args.optionId)) return fail("invalid_option", `no option ${args.optionId}`);
  // Revalidate old asks too: stored references may predate creation-time checks.
  const task = ask.taskId ? await ctx.db.get(ask.taskId) : null;
  if (ask.taskId && (!task || task.runId !== args.runId)) {
    return await recordViolation(ctx, args.runId, args.seatId, op, fail("invalid_task", "task not found in this run"));
  }
  if (ask.answer && ask.answer.optionId !== args.optionId) {
    return fail("conflict", `ask already answered "${ask.answer.optionId}" by ${ask.answer.by}; a different answer cannot replace it`);
  }
  if (ask.status === "withdrawn") return fail("bad_state", "ask was withdrawn");
  return { ok: true as const, ask, task };
}

/**
 * First half of a decision whose effects run outside this transaction (the human gateway's
 * payment, close and memory actions): record the answer so a conflicting one is refused, but
 * keep the ask open and its task parked until answerAsk confirms the effects.
 */
export const recordAnswer = mutation({
  args: { ...seatArgs, askId: v.id("asks"), optionId: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const checked = await checkAnswer(ctx, args, "asks.recordAnswer");
    if (!checked.ok) return checked;
    const { ask } = checked;
    if (ask.answer) return { ok: true as const, status: ask.status, answer: ask.answer, replayed: true };
    const answer = { optionId: args.optionId, note: args.note, by: args.seatId, at: Date.now() };
    await ctx.db.patch(ask._id, { answer });
    return { ok: true as const, status: ask.status, answer, replayed: false };
  },
});

/**
 * Answer an ask, or complete a recorded answer. Only the addressee (that seat, or a seat holding
 * that role) may answer. The first answer is final: a replay is a no-op, a different one is refused.
 */
export const answerAsk = mutation({
  args: { ...seatArgs, askId: v.id("asks"), optionId: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const checked = await checkAnswer(ctx, args, "asks.answerAsk");
    if (!checked.ok) return checked;
    const { ask, task } = checked;
    if (ask.status === "answered") return { ok: true as const, alreadyAnswered: true };
    const answer = ask.answer ?? { optionId: args.optionId, note: args.note, by: args.seatId, at: Date.now() };
    await ctx.db.patch(ask._id, { status: "answered", answer });
    if (task && task.status === "waiting") {
      await ctx.db.patch(task._id, { status: "queued", notBefore: undefined, updatedAt: Date.now() });
    }
    const label = ask.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId;
    await logActivity(ctx, args.runId, args.seatId, "answered", `Answered "${ask.title}": ${label}${answer.note ? ` (${answer.note})` : ""}`, { askId: ask._id });
    return { ok: true as const };
  },
});

export const list = query({
  args: { runId: v.string(), status: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const rows = await ctx.db
      .query("asks")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .order("desc")
      .collect();
    return rows.filter((a) => (!args.status || a.status === args.status) && (!args.to || a.to === args.to));
  },
});

export const forTask = query({
  args: { runId: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const rows = await ctx.db
      .query("asks")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});
