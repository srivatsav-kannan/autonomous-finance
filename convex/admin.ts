import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { fail, getRun, logActivity, requireAdmin, DEFAULT_POLICY } from "./lib/kernel";
import { routeEvent } from "./lib/routing";

// Admin = the world simulator and the eval harness. Never an agent seat.

export const createRun = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    label: v.string(),
    company: v.string(),
    simDate: v.string(),
    policy: v.optional(v.any()),
    seats: v.array(
      v.object({
        seatId: v.string(),
        role: v.string(),
        name: v.string(),
        kind: v.union(v.literal("agent"), v.literal("human")),
        reportsTo: v.optional(v.string()),
        tokenHash: v.string(),
        model: v.optional(v.string()),
        effort: v.optional(v.string()),
      }),
    ),
    periods: v.array(v.string()),
    vendors: v.optional(v.array(v.object({ vendorId: v.string(), legalName: v.string(), bank: v.string(), accountLast4: v.string() }))),
  },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) return denied;
    if (await getRun(ctx, args.runId)) return fail("exists", `run ${args.runId} already exists`);
    await ctx.db.insert("runs", {
      runId: args.runId,
      label: args.label,
      company: args.company,
      simDate: args.simDate,
      status: "active",
      createdAt: Date.now(),
      config: { policy: { ...DEFAULT_POLICY, ...(args.policy ?? {}) }, vendorRegistry: Boolean(args.vendors) },
    });
    for (const s of args.seats) {
      await ctx.db.insert("seats", {
        runId: args.runId,
        ...s,
        capabilities: {},
        status: "active",
        createdAt: Date.now(),
      });
    }
    for (const vnd of args.vendors ?? []) {
      await ctx.db.insert("vendors", {
        runId: args.runId, vendorId: vnd.vendorId, legalName: vnd.legalName, status: "active",
        remitBank: vnd.bank, remitLast4: vnd.accountLast4, verifiedBy: "onboarding", verifiedAt: Date.now(),
      });
    }
    for (const period of args.periods) {
      await ctx.db.insert("periods", { runId: args.runId, period, status: "open" });
    }
    return { ok: true as const };
  },
});

export const setSimDate = mutation({
  args: { secret: v.string(), runId: v.string(), simDate: v.string() },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) return denied;
    const run = await getRun(ctx, args.runId);
    if (!run) return fail("not_found", "run not found");
    await ctx.db.patch(run._id, { simDate: args.simDate });
    return { ok: true as const };
  },
});

/**
 * The world's only door into the company. Deduplicated by externalId, then routed to a seat's queue.
 * Delivering the same event twice is a no-op (exactly-once ingestion).
 */
export const ingestEvent = mutation({
  args: {
    secret: v.string(),
    runId: v.string(),
    type: v.string(),
    externalId: v.string(),
    occurredOn: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) return denied;
    const existing = await ctx.db
      .query("events")
      .withIndex("by_run_external", (q) => q.eq("runId", args.runId).eq("externalId", args.externalId))
      .unique();
    if (existing) return { ok: true as const, eventId: existing._id, duplicate: true };
    const eventId = await ctx.db.insert("events", {
      runId: args.runId,
      type: args.type,
      externalId: args.externalId,
      occurredOn: args.occurredOn,
      payload: args.payload,
      recordedAt: Date.now(),
    });
    const taskIds = [];
    for (const route of routeEvent(args.type, args.payload ?? {})) {
      taskIds.push(
        await ctx.db.insert("tasks", {
          runId: args.runId,
          type: route.taskType,
          role: route.role,
          status: "queued",
          priority: route.priority,
          payload: {
            eventId, externalId: args.externalId, occurredOn: args.occurredOn,
            ...(args.type === "period.end" ? { period: (args.payload as { period?: string })?.period } : {}),
            ...(args.type === "document.received" ? { kind: (args.payload as { kind?: string })?.kind } : {}),
          },
          idempotencyKey: `event:${args.externalId}:${route.taskType}`,
          createdBy: "world",
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    return { ok: true as const, eventId, taskIds, duplicate: false };
  },
});

export const addGoal = mutation({
  args: { secret: v.string(), runId: v.string(), text: v.string(), metric: v.optional(v.string()), target: v.optional(v.number()), setBy: v.string() },
  handler: async (ctx, args) => {
    const denied = requireAdmin(args.secret);
    if (denied) return denied;
    const id = await ctx.db.insert("goals", {
      runId: args.runId,
      text: args.text,
      metric: args.metric,
      target: args.target,
      setBy: args.setBy,
      status: "active",
      createdAt: Date.now(),
    });
    await logActivity(ctx, args.runId, args.setBy, "goal", `New goal: ${args.text}`);
    return { ok: true as const, goalId: id };
  },
});

export const runs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("runs").order("desc").take(20);
  },
});

export const event = query({
  args: { runId: v.string(), eventId: v.id("events") },
  handler: async (ctx, args) => {
    const e = await ctx.db.get(args.eventId);
    if (!e || e.runId !== args.runId) return null;
    return e;
  },
});

/** Events of one type up to a date, for matching (receiving logs, roster, contracts). */
export const eventsOfType = query({
  args: { runId: v.string(), type: v.string(), from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("events")
      .withIndex("by_run_type", (q) => {
        const base = q.eq("runId", args.runId).eq("type", args.type);
        if (args.from && args.to) return base.gte("occurredOn", args.from).lte("occurredOn", args.to);
        if (args.to) return base.lte("occurredOn", args.to);
        if (args.from) return base.gte("occurredOn", args.from);
        return base;
      })
      .collect();
  },
});
