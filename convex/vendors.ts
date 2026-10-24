import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authSeat, fail, getRun, logActivity, recordViolation } from "./lib/kernel";

// The vendor registry is where money is allowed to go. Git memory holds what the company knows
// about a vendor; this table holds the verified payee and bank details the kernel pays against.
// A new vendor or a bank-detail change takes effect only when a human approves it, so no pair of
// agent seats can redirect money between themselves.

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

export const get = query({
  args: { runId: v.string(), vendorId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vendors")
      .withIndex("by_run_vendor", (q) => q.eq("runId", args.runId).eq("vendorId", args.vendorId))
      .unique();
  },
});

export const list = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vendors")
      .withIndex("by_run_vendor", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

/** An agent records a verified bank-detail change; it waits for a human. */
export const proposeRemitChange = mutation({
  args: { ...seatArgs, vendorId: v.string(), bank: v.string(), accountLast4: v.string(), evidence: v.string() },
  handler: async (ctx, args) => {
    const op = "vendors.proposeRemitChange";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.paymentsRequest && auth.seat.kind !== "human") {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `${auth.seat.role} may not propose bank changes`));
    }
    const vendor = await ctx.db
      .query("vendors")
      .withIndex("by_run_vendor", (q) => q.eq("runId", args.runId).eq("vendorId", args.vendorId))
      .unique();
    if (!vendor) return await recordViolation(ctx, args.runId, args.seatId, op, fail("unknown_vendor", `${args.vendorId} is not a registered vendor`));
    await ctx.db.patch(vendor._id, {
      pendingRemit: { bank: args.bank, accountLast4: args.accountLast4, proposedBy: args.seatId, evidence: args.evidence, at: Date.now() },
    });
    await logActivity(ctx, args.runId, args.seatId, "proposed", `Bank change for ${args.vendorId} -> ${args.bank} ****${args.accountLast4} awaiting human approval`);
    return { ok: true as const };
  },
});

/** Only a human, who did not propose it, can make a bank-detail change effective. */
export const approveRemitChange = mutation({
  args: { ...seatArgs, vendorId: v.string() },
  handler: async (ctx, args) => {
    const op = "vendors.approveRemitChange";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (auth.seat.kind !== "human") {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "bank-detail changes need a human approver"));
    }
    const vendor = await ctx.db
      .query("vendors")
      .withIndex("by_run_vendor", (q) => q.eq("runId", args.runId).eq("vendorId", args.vendorId))
      .unique();
    if (!vendor?.pendingRemit) return fail("nothing_pending", `no pending bank change for ${args.vendorId}`);
    if (vendor.pendingRemit.proposedBy === args.seatId) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("sod", "the proposer cannot approve a bank change"));
    }
    await ctx.db.patch(vendor._id, {
      remitBank: vendor.pendingRemit.bank,
      remitLast4: vendor.pendingRemit.accountLast4,
      verifiedBy: args.seatId,
      verifiedAt: Date.now(),
      pendingRemit: undefined,
    });
    await logActivity(ctx, args.runId, args.seatId, "approved", `Bank change for ${args.vendorId} approved`);
    return { ok: true as const };
  },
});

/** Onboarding a new vendor is a human decision. */
export const registerVendor = mutation({
  args: { ...seatArgs, vendorId: v.string(), legalName: v.string(), bank: v.string(), accountLast4: v.string() },
  handler: async (ctx, args) => {
    const op = "vendors.registerVendor";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (auth.seat.kind !== "human") {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "new vendors are onboarded by a human"));
    }
    if (!(await getRun(ctx, args.runId))) return fail("not_found", "run not found");
    const existing = await ctx.db
      .query("vendors")
      .withIndex("by_run_vendor", (q) => q.eq("runId", args.runId).eq("vendorId", args.vendorId))
      .unique();
    if (existing) return fail("exists", `${args.vendorId} is already registered`);
    await ctx.db.insert("vendors", {
      runId: args.runId, vendorId: args.vendorId, legalName: args.legalName, status: "active",
      remitBank: args.bank, remitLast4: args.accountLast4, verifiedBy: args.seatId, verifiedAt: Date.now(),
    });
    return { ok: true as const };
  },
});
