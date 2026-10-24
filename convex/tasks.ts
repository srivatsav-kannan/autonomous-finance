import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Role } from "../src/core/roles";
import { authSeat, fail, logActivity, recordViolation, requireAdmin } from "./lib/kernel";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 4;

/** Seats hand work to each other through tasks, never through chat. Idempotent by key. */
export const createTask = mutation({
  args: {
    ...seatArgs,
    type: v.string(),
    role: v.string(),
    payload: v.any(),
    idempotencyKey: v.string(),
    priority: v.optional(v.number()),
    parentTaskId: v.optional(v.id("tasks")),
  },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "tasks.createTask", auth);
    if (!auth.seat.caps.taskRoles.includes(args.role as Role)) {
      return await recordViolation(ctx, args.runId, args.seatId, "tasks.createTask",
        fail("forbidden", `${auth.seat.role} may not assign work to ${args.role}`));
    }
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_run_key", (q) => q.eq("runId", args.runId).eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) return { ok: true as const, taskId: existing._id, duplicate: true };
    const taskId = await ctx.db.insert("tasks", {
      runId: args.runId,
      type: args.type,
      role: args.role,
      status: "queued",
      priority: args.priority ?? 3,
      payload: args.payload,
      idempotencyKey: args.idempotencyKey,
      createdBy: args.seatId,
      parentTaskId: args.parentTaskId,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await logActivity(ctx, args.runId, args.seatId, "handoff", `Handed ${args.type} to ${args.role}`, { taskId });
    return { ok: true as const, taskId, duplicate: false };
  },
});

export const adminCreateTask = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    type: v.string(),
    role: v.string(),
    payload: v.any(),
    idempotencyKey: v.string(),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) return denied;
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_run_key", (q) => q.eq("runId", args.runId).eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) return { ok: true as const, taskId: existing._id, duplicate: true };
    const taskId = await ctx.db.insert("tasks", {
      runId: args.runId,
      type: args.type,
      role: args.role,
      status: "queued",
      priority: args.priority ?? 3,
      payload: args.payload,
      idempotencyKey: args.idempotencyKey,
      createdBy: "admin",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ok: true as const, taskId, duplicate: false };
  },
});

/**
 * Lease the highest-priority runnable task for this seat's role. Convex runs mutations
 * serializably, so two seats racing for the same task can never both win it.
 * Expired leases (a crashed worker) are reclaimed here.
 */
export const claimTask = mutation({
  args: { ...seatArgs },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "tasks.claimTask", auth);
    const now = Date.now();
    const role = auth.seat.role;

    const expired = await ctx.db
      .query("tasks")
      .withIndex("by_run_role_status", (q) => q.eq("runId", args.runId).eq("role", role).eq("status", "leased"))
      .filter((q) => q.lt(q.field("leaseExpiresAt"), now))
      .first();
    const candidate =
      expired ??
      (await ctx.db
        .query("tasks")
        .withIndex("by_run_role_status", (q) => q.eq("runId", args.runId).eq("role", role).eq("status", "queued"))
        .filter((q) => q.or(q.eq(q.field("notBefore"), undefined), q.lte(q.field("notBefore"), now)))
        .first());
    if (!candidate) return { ok: true as const, task: null };

    if (candidate.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(candidate._id, { status: "failed", error: candidate.error ?? "too many attempts", updatedAt: now });
      return { ok: true as const, task: null };
    }
    await ctx.db.patch(candidate._id, {
      status: "leased",
      leaseOwner: args.seatId,
      leaseExpiresAt: now + LEASE_MS,
      attempts: candidate.attempts + 1,
      updatedAt: now,
    });
    const task = await ctx.db.get(candidate._id);
    return { ok: true as const, task, reclaimed: Boolean(expired) };
  },
});

export const completeTask = mutation({
  args: { ...seatArgs, taskId: v.id("tasks"), result: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "tasks.completeTask", auth);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.runId !== args.runId) return fail("not_found", "task not found");
    if (task.status === "done") return { ok: true as const, alreadyDone: true };
    if (task.leaseOwner !== args.seatId) {
      return await recordViolation(ctx, args.runId, args.seatId, "tasks.completeTask",
        fail("not_lease_owner", `task is leased by ${task.leaseOwner ?? "nobody"}`));
    }
    await ctx.db.patch(task._id, { status: "done", result: args.result, updatedAt: Date.now(), leaseExpiresAt: undefined });
    return { ok: true as const };
  },
});

export const failTask = mutation({
  args: { ...seatArgs, taskId: v.id("tasks"), error: v.string(), retryInMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "tasks.failTask", auth);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.runId !== args.runId) return fail("not_found", "task not found");
    if (task.leaseOwner !== args.seatId) return fail("not_lease_owner", "not your lease");
    const giveUp = task.attempts >= MAX_ATTEMPTS || args.retryInMs === undefined;
    await ctx.db.patch(task._id, {
      status: giveUp ? "failed" : "queued",
      error: args.error,
      notBefore: giveUp ? undefined : Date.now() + (args.retryInMs ?? 0),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true as const, status: giveUp ? "failed" : "queued" };
  },
});

/** Park a task until an ask is answered (the ask's answer re-queues it). */
export const waitTask = mutation({
  args: { ...seatArgs, taskId: v.id("tasks"), reason: v.string() },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "tasks.waitTask", auth);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.runId !== args.runId) return fail("not_found", "task not found");
    await ctx.db.patch(task._id, { status: "waiting", error: args.reason, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

export const queueStats = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("tasks")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .collect();
    const byRole: Record<string, Record<string, number>> = {};
    for (const t of all) {
      byRole[t.role] ??= {};
      byRole[t.role]![t.status] = (byRole[t.role]![t.status] ?? 0) + 1;
    }
    return byRole;
  },
});

export const get = query({
  args: { runId: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.taskId);
    return t && t.runId === args.runId ? t : null;
  },
});
