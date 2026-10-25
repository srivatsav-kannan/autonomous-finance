import { v } from "convex/values";
import { query } from "./_generated/server";
import { buildBankWorkspace } from "../src/core/bank-workspace";

/** Complete, read-only bank workspace for a single simulation run. */
export const workspace = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.query("runs").withIndex("by_runId", (q) => q.eq("runId", runId)).unique();
    if (!run) return buildBankWorkspace(runId, { run: null, balances: [], entries: [], events: [], tasks: [], payments: [], asks: [] });
    // Do not cap these reads to the latest activity window: both the cash series
    // and reconciliation counts describe the complete run.
    const [balances, entries, events, tasks, payments, asks] = await Promise.all([
      ctx.db.query("balances").withIndex("by_run_account_period", (q) => q.eq("runId", runId)).collect(),
      ctx.db.query("journalEntries").withIndex("by_run_sequence", (q) => q.eq("runId", runId)).collect(),
      ctx.db.query("events").withIndex("by_run_type", (q) => q.eq("runId", runId).eq("type", "bank.transaction")).collect(),
      ctx.db.query("tasks").withIndex("by_run_role_status", (q) => q.eq("runId", runId).eq("role", "cash_application")).collect(),
      ctx.db.query("paymentIntents").withIndex("by_run_status", (q) => q.eq("runId", runId)).collect(),
      ctx.db.query("asks").withIndex("by_run_status", (q) => q.eq("runId", runId)).collect(),
    ]);
    return buildBankWorkspace(runId, { run, balances, entries, events, tasks, payments, asks });
  },
});
