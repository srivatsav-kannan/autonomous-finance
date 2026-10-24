import { mutation, query } from "./_generated/server";
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
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", auth);
    if (!auth.seat.caps.asks) return await recordViolation(ctx, args.runId, args.seatId, "asks.createAsk", fail("forbidden", "seat may not ask"));
    if (args.taskId) {
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

/** Answer an ask. Only the addressee (that seat, or a seat holding that role) may answer. */
export const answerAsk = mutation({
  args: { ...seatArgs, askId: v.id("asks"), optionId: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "asks.answerAsk", auth);
    const ask = await ctx.db.get(args.askId);
    if (!ask || ask.runId !== args.runId) return fail("not_found", "ask not found");
    if (ask.status !== "open") return { ok: true as const, alreadyAnswered: true };
    if (ask.to !== args.seatId && ask.to !== auth.seat.role) {
      return await recordViolation(ctx, args.runId, args.seatId, "asks.answerAsk", fail("forbidden", `ask is addressed to ${ask.to}`));
    }
    if (ask.from === args.seatId) {
      return await recordViolation(ctx, args.runId, args.seatId, "asks.answerAsk", fail("sod", "a seat cannot answer its own ask"));
    }
    if (!ask.options.some((o) => o.id === args.optionId)) return fail("invalid_option", `no option ${args.optionId}`);
    await ctx.db.patch(ask._id, {
      status: "answered",
      answer: { optionId: args.optionId, note: args.note, by: args.seatId, at: Date.now() },
    });
    if (ask.taskId) {
      const task = await ctx.db.get(ask.taskId);
      if (task && task.status === "waiting") {
        await ctx.db.patch(task._id, { status: "queued", notBefore: undefined, updatedAt: Date.now() });
      }
    }
    const label = ask.options.find((o) => o.id === args.optionId)?.label ?? args.optionId;
    await logActivity(ctx, args.runId, args.seatId, "answered", `Answered "${ask.title}": ${label}${args.note ? ` (${args.note})` : ""}`, { askId: ask._id });
    return { ok: true as const };
  },
});

export const list = query({
  args: { runId: v.string(), status: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
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
    const rows = await ctx.db
      .query("asks")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});
