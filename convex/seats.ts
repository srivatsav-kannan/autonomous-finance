import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authSeat, fail, loadSeat, logActivity, recordViolation } from "./lib/kernel";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

// Roles the CFO agent may staff up or down on its own. Control roles (controller, payments,
// auditor) change only with a human, so an agent can't hire its own approver.
const AGENT_STAFFABLE = new Set(["ap_clerk", "cash_application", "revenue_accountant", "fpa"]);

export const spawnSeat = mutation({
  args: {
    ...seatArgs,
    newSeatId: v.string(),
    role: v.string(),
    name: v.string(),
    tokenHash: v.string(),
    reportsTo: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const op = "seats.spawnSeat";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.seatsManage) return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "seat may not manage staffing"));
    if (auth.seat.kind === "agent" && !AGENT_STAFFABLE.has(args.role)) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `an agent may not staff ${args.role}; ask a human`));
    }
    if (await loadSeat(ctx, args.runId, args.newSeatId)) return fail("exists", `seat ${args.newSeatId} exists`);
    await ctx.db.insert("seats", {
      runId: args.runId,
      seatId: args.newSeatId,
      role: args.role,
      name: args.name,
      kind: "agent",
      capabilities: {},
      reportsTo: args.reportsTo,
      status: "active",
      tokenHash: args.tokenHash,
      model: args.model,
      effort: args.effort,
      spawnedBy: args.seatId,
      createdAt: Date.now(),
    });
    await logActivity(ctx, args.runId, args.seatId, "spawned", `Spawned ${args.name} (${args.role}): ${args.reason}`, { seatId: args.newSeatId });
    return { ok: true as const };
  },
});

export const retireSeat = mutation({
  args: { ...seatArgs, targetSeatId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const op = "seats.retireSeat";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.seatsManage) return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "seat may not manage staffing"));
    const target = await loadSeat(ctx, args.runId, args.targetSeatId);
    if (!target) return fail("not_found", "seat not found");
    if (auth.seat.kind === "agent" &&
        (target.spawnedBy !== args.seatId || target.kind !== "agent" || !AGENT_STAFFABLE.has(target.role))) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("forbidden", "agents may only retire their own spawned seats in permitted non-control roles"));
    }
    await ctx.db.patch(target._id, { status: "retired", retiredAt: Date.now() });
    await logActivity(ctx, args.runId, args.seatId, "retired", `Retired ${target.name}: ${args.reason}`, { seatId: target.seatId });
    return { ok: true as const };
  },
});

export const list = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("seats")
      .withIndex("by_run_seat", (q) => q.eq("runId", args.runId))
      .collect();
    return rows.map(({ tokenHash: _h, ...rest }) => rest);
  },
});
