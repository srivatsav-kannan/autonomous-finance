import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { lineValidator, sourceValidator } from "./schema";
import {
  authSeat,
  canonical,
  checkIdempotency,
  fail,
  logActivity,
  recordViolation,
  sha256Hex,
  storeIdempotency,
} from "./lib/kernel";
import { appendEntry } from "./lib/post";
import { CHART } from "../src/core/accounts";
import { readCloseReadiness } from "./lib/closeReadiness";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

export const postEntry = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    date: v.string(),
    memo: v.string(),
    source: sourceValidator,
    lines: v.array(lineValidator),
    taskId: v.optional(v.string()),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "ledger.postEntry", auth);
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, "ledger.postEntry", payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, "ledger.postEntry", idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; entryId: Id<"journalEntries">; sequence: number; hash: string }), replayed: true };

    const res = await appendEntry(ctx, {
      runId: args.runId,
      seat: auth.seat,
      date: args.date,
      memo: args.memo,
      source: args.source,
      lines: args.lines,
      idempotencyKey: args.idempotencyKey,
      taskId: args.taskId,
      decisionPath: args.decisionPath,
      memorySha: args.memorySha,
    });
    if (!res.ok) return await recordViolation(ctx, args.runId, args.seatId, "ledger.postEntry", res);
    const result = { ok: true as const, entryId: res.entryId, sequence: res.sequence, hash: res.hash };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, "ledger.postEntry", idem.payloadHash, result);
    return result;
  },
});

/** Corrections never edit history: they post the mirror entry and link both ways. */
export const reverseEntry = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    entryId: v.id("journalEntries"),
    date: v.string(),
    reason: v.string(),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "ledger.reverseEntry", auth);
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, "ledger.reverseEntry", payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, "ledger.reverseEntry", idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; entryId: Id<"journalEntries">; sequence: number }), replayed: true };

    const original = await ctx.db.get(args.entryId);
    if (!original || original.runId !== args.runId) {
      return await recordViolation(ctx, args.runId, args.seatId, "ledger.reverseEntry", fail("not_found", "entry not found"));
    }
    if (original.status === "reversed") {
      return await recordViolation(ctx, args.runId, args.seatId, "ledger.reverseEntry", fail("already_reversed", `entry #${original.sequence} is already reversed`));
    }
    const res = await appendEntry(ctx, {
      runId: args.runId,
      seat: auth.seat,
      date: args.date,
      memo: `Reversal of #${original.sequence}: ${args.reason}`,
      source: { kind: "reversal", ref: String(original.sequence) },
      lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
      idempotencyKey: args.idempotencyKey,
      decisionPath: args.decisionPath,
      memorySha: args.memorySha,
      reversalOf: original._id,
    });
    if (!res.ok) return await recordViolation(ctx, args.runId, args.seatId, "ledger.reverseEntry", res);
    await ctx.db.patch(original._id, { status: "reversed", reversedBy: res.entryId });
    const result = { ok: true as const, entryId: res.entryId, sequence: res.sequence };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, "ledger.reverseEntry", idem.payloadHash, result);
    return result;
  },
});

/**
 * Two-key period close: the controller agent and a human CFO must both sign.
 * Once closed, posting to the period is rejected by the kernel.
 */
export const signClose = mutation({
  args: { ...seatArgs, period: v.string(), memoryTag: v.optional(v.string()), expectedSnapshotHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, "ledger.signClose", auth);
    if (!auth.seat.caps.periodClose) {
      return await recordViolation(ctx, args.runId, args.seatId, "ledger.signClose", fail("forbidden", `${auth.seat.role} cannot sign a close`));
    }
    const p = await ctx.db
      .query("periods")
      .withIndex("by_run_period", (q) => q.eq("runId", args.runId).eq("period", args.period))
      .unique();
    if (!p) return fail("not_found", `period ${args.period} not found`);
    if (p.status === "closed") return { ok: true as const, status: "closed", signedBy: p.closedBy ?? [] };
    const readiness = await readCloseReadiness(ctx, args.runId, args.period);
    if (!readiness.ready || (args.expectedSnapshotHash && args.expectedSnapshotHash !== readiness.snapshotHash)) {
      // A new unresolved source or changed review cannot retain old signatures.
      await ctx.db.patch(p._id, { closedBy: [], closeSnapshotHash: undefined, memoryTag: undefined });
      return await recordViolation(ctx, args.runId, args.seatId, "ledger.signClose", readiness.ready
        ? fail("close_changed", "close inputs changed after review; refresh the checklist before signing")
        : fail("close_blocked", `${readiness.blockerCount} source/bill close blocker(s): ${readiness.blockers.map((b) => b.reason).join("; ")}`));
    }
    const sameSnapshot = p.closeSnapshotHash === readiness.snapshotHash;
    const signedBy = Array.from(new Set([...(sameSnapshot ? p.closedBy ?? [] : []), args.seatId]));
    const seats = await Promise.all(
      signedBy.map((s) =>
        ctx.db
          .query("seats")
          .withIndex("by_run_seat", (q) => q.eq("runId", args.runId).eq("seatId", s))
          .unique(),
      ),
    );
    const hasHuman = seats.some((s) => s?.kind === "human");
    const hasController = seats.some((s) => s?.role === "controller");
    const head = await ctx.db
      .query("ledgerHeads")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (hasHuman && hasController) {
      await ctx.db.patch(p._id, {
        status: "closed",
        closedBy: signedBy,
        closedAt: Date.now(),
        ledgerHead: head?.hash,
        memoryTag: args.memoryTag ?? p.memoryTag,
        closeSnapshotHash: readiness.snapshotHash,
      });
      await logActivity(ctx, args.runId, args.seatId, "closed", `Period ${args.period} closed (signed by ${signedBy.join(", ")})`);
      return { ok: true as const, status: "closed", signedBy };
    }
    await ctx.db.patch(p._id, { closedBy: signedBy, closeSnapshotHash: readiness.snapshotHash,
      memoryTag: args.memoryTag ?? (sameSnapshot ? p.memoryTag : undefined) });
    await logActivity(ctx, args.runId, args.seatId, "signed", `Signed close for ${args.period}; waiting for ${hasHuman ? "controller" : "a human CFO"}`);
    return { ok: true as const, status: "open", signedBy };
  },
});

/** The same authoritative source/bill check used by each close signature. */
export const closeReadiness = query({
  args: { runId: v.string(), period: v.string() },
  handler: async (ctx, args) => await readCloseReadiness(ctx, args.runId, args.period),
});

export const trialBalance = query({
  args: { runId: v.string(), period: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("balances")
      .withIndex("by_run_account_period", (q) => q.eq("runId", args.runId))
      .collect();
    const totals = new Map<string, { debits: number; credits: number }>();
    for (const r of rows) {
      if (args.period && r.period > args.period) continue;
      const t = totals.get(r.account) ?? { debits: 0, credits: 0 };
      t.debits += r.debits;
      t.credits += r.credits;
      totals.set(r.account, t);
    }
    return CHART.filter((a) => totals.has(a.code)).map((a) => {
      const t = totals.get(a.code)!;
      return { code: a.code, name: a.name, type: a.type, debits: t.debits, credits: t.credits, net: t.debits - t.credits };
    });
  },
});

export const entries = query({
  args: { runId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("journalEntries")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

/** Recompute the hash chain from genesis; returns the first broken sequence if any. */
export const verifyChain = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("journalEntries")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
      .collect();
    let prev = "genesis";
    for (const e of all) {
      const body = {
        sequence: e.sequence,
        date: e.date,
        memo: e.memo,
        source: e.source,
        lines: e.lines,
        postedBy: e.postedBy,
        decisionPath: e.decisionPath,
        memorySha: e.memorySha,
      };
      const expected = await sha256Hex(prev + canonical(body));
      if (e.prevHash !== prev || e.hash !== expected) {
        return { ok: false as const, brokenAt: e.sequence, entries: all.length };
      }
      prev = e.hash;
    }
    return { ok: true as const, head: prev, entries: all.length };
  },
});
