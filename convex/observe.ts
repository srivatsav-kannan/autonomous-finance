import { assertLegacyRun } from "./lib/demoAuth";
import { workerRequest } from "./lib/workerRequest";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authSeat, recordViolation } from "./lib/kernel";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

/** Every agent turn is logged: model, tokens, cost, latency, tool calls, outcome. */
export const logRun = mutation({
  args: {
    ...seatArgs,
    requestId: v.optional(v.string()),
    taskId: v.optional(v.id("tasks")),
    kind: v.string(),
    model: v.optional(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    costMicros: v.number(),
    latencyMs: v.number(),
    toolCalls: v.number(),
    outcome: v.string(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "observe.logRun", auth);
    return await workerRequest(ctx, args, "observe.logRun", async () => {
      const { token: _t, requestId: _requestId, ...row } = args;
      await ctx.db.insert("agentRuns", { ...row, at: Date.now() });
      return { ok: true as const };
    });
  },
});

export const note = mutation({
  args: { ...seatArgs, kind: v.string(), text: v.string(), refs: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "observe.note", auth);
    await ctx.db.insert("activity", { runId: args.runId, seatId: args.seatId, kind: args.kind, text: args.text, refs: args.refs, at: Date.now() });
    return { ok: true as const };
  },
});

/** Mirror of the git memory log, so the console can show commits next to ledger entries. */
export const recordCommit = mutation({
  args: {
    ...seatArgs,
    sha: v.string(),
    branch: v.string(),
    message: v.string(),
    paths: v.array(v.string()),
    trailers: v.any(),
  },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "observe.recordCommit", auth);
    const existing = await ctx.db
      .query("memoryCommits")
      .withIndex("by_run_sha", (q) => q.eq("runId", args.runId).eq("sha", args.sha))
      .unique();
    if (existing) return { ok: true as const, duplicate: true };
    await ctx.db.insert("memoryCommits", {
      runId: args.runId,
      sha: args.sha,
      branch: args.branch,
      author: args.seatId,
      message: args.message,
      paths: args.paths,
      trailers: args.trailers,
      at: Date.now(),
    });
    return { ok: true as const };
  },
});

export const overview = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const run = await ctx.db.query("runs").withIndex("by_runId", (q) => q.eq("runId", args.runId)).unique();
    const balances = await ctx.db
      .query("balances")
      .withIndex("by_run_account_period", (q) => q.eq("runId", args.runId))
      .collect();
    const net = (prefix: string) =>
      balances.filter((b) => b.account.startsWith(prefix)).reduce((s, b) => s + b.debits - b.credits, 0);
    const openAsks = await ctx.db
      .query("asks")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId).eq("status", "open"))
      .collect();
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .collect();
    const violations = await ctx.db
      .query("violations")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .collect();
    const head = await ctx.db.query("ledgerHeads").withIndex("by_run", (q) => q.eq("runId", args.runId)).unique();
    return {
      run,
      cashCents: net("100") + net("101") + net("102"),
      apCents: -net("2000"),
      giftCardLiabilityCents: -net("2200"),
      revenueCents: -(net("40")),
      openAsks: openAsks.length,
      urgentAsks: openAsks.filter((a) => a.severity === "urgent").length,
      agentTurns: runs.length,
      llmTurns: runs.filter((r) => r.kind === "llm").length,
      costMicros: runs.reduce((s, r) => s + r.costMicros, 0),
      blockedAttempts: violations.length,
      entries: head?.sequence ?? 0,
    };
  },
});

export const activity = query({
  args: { runId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    return await ctx.db
      .query("activity")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(args.limit ?? 100);
  },
});

export const commits = query({
  args: { runId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    return await ctx.db
      .query("memoryCommits")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(args.limit ?? 100);
  },
});

export const violations = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    return await ctx.db
      .query("violations")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .order("desc")
      .collect();
  },
});

export const agentRuns = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    return await ctx.db
      .query("agentRuns")
      .withIndex("by_run_at", (q) => q.eq("runId", args.runId))
      .collect();
  },
});
