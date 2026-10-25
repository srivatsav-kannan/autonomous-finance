/** Operator-only readback for immutable bootstrap recovery. No enrollment or writes. */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { canonical, getRun, requireAdmin, sha256Hex } from "./lib/kernel";
export const inspect = query({
  args: { secret: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) throw Error("Bootstrap admin authority required");
    if (!/^ap97-[A-Za-z0-9-]+$/.test(args.runId))
      throw Error("Owned bootstrap run required");
    const run = await getRun(ctx, args.runId);
    const config = await ctx.db
      .query("demoConfigs")
      .withIndex("by_run", (q) => q.eq("scope.runId", args.runId))
      .unique();
    if (!run) return { runHash: null, configHash: config ? "orphaned" : null };
    const seats = await ctx.db
      .query("seats")
      .withIndex("by_run_seat", (q) => q.eq("runId", args.runId))
      .collect();
    const periods = await ctx.db
      .query("periods")
      .withIndex("by_run_period", (q) => q.eq("runId", args.runId))
      .collect();
    if (
      run.status !== "active" ||
      seats.some(
        (s) => s.status !== "active" || Object.keys(s.capabilities).length,
      ) ||
      periods.some((p) => p.status !== "open")
    )
      return { runHash: "changed", configHash: null };
    const agentOrder = ["ap97-ap", "ap97-payments", "ap97-controller"];
    seats.sort((a, b) => {
      const index = (id: string) =>
        agentOrder.includes(id)
          ? agentOrder.indexOf(id)
          : 3 + Number(id.replace("ap97-human-", ""));
      return index(a.seatId) - index(b.seatId);
    });
    const create = {
      runId: run.runId,
      label: run.label,
      company: run.company,
      simDate: run.simDate,
      seats: seats.map(({ seatId, role, name, kind, tokenHash }) => ({
        seatId,
        role,
        name,
        kind,
        tokenHash,
      })),
      periods: periods.map((p) => p.period).sort(),
    };
    let configHash: string | null = null;
    if (config) {
      const { _id, _creationTime, createdAt, ...value } = config;
      configHash = await sha256Hex(canonical(value));
    }
    return { runHash: await sha256Hex(canonical(create)), configHash };
  },
});
