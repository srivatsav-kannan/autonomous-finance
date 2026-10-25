import { assertLegacyRun } from "./lib/demoAuth";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { authSeat, fail, logActivity, recordViolation } from "./lib/kernel";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

/**
 * How agents talk to people: a decision with evidence and options, not a form to fill.
 * `to` is a seat id or a role (e.g. "human_cfo", "controller").
 */
export const createAsk = mutation({
  args: {
    ...seatArgs,
    to: v.string(),
    severity: v.union(v.literal("info"), v.literal("decision"), v.literal("urgent")),
    title: v.string(),
    body: v.string(),
    evidence: v.array(v.object({ label: v.string(), ref: v.string() })),
    options: v.array(v.object({ id: v.string(), label: v.string() })),
    taskId: v.optional(v.id("tasks")),
    proposalBranch: v.optional(v.string()),
    paymentIntentId: v.optional(v.id("paymentIntents")),
    dedupeKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", auth);
    if (!auth.seat.caps.asks) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("forbidden", "seat may not ask"));
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
    const { token: _t, seatId, runId, dedupeKey: _d, ...rest } = args;
    const askId = await ctx.db.insert("asks", { runId, from: seatId, ...rest, status: "open", createdAt: Date.now() });
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
