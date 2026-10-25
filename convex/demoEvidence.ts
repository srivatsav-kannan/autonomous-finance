import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { transactionValidator, observationValidator } from "./demoEvidenceSchema";
import { requireService, requireDemoSeat, requirePaymentSeat, requireHuman, requirePaymentHuman, accountingSeat, auditDemo } from "./lib/demoAuth";
import { appendDemoEntry } from "./lib/demoPost";
import { canonical, sha256Hex } from "./lib/kernel";
import type { BankScope } from "../src/payments/contracts";

import { commandFor, transactionFor, saveObservation, saveTransaction, postVerifiedTransaction } from "./lib/payments/applyObservation";

const serviceArgs = { scope: scopeValidator, token: v.string() };
/** Raw signature verification happens in the credential-isolated ingress. ACK only after this commits. */
export const ingestNotice = mutation({
  args: { ...serviceArgs, eventId: v.string(), transferId: v.optional(v.string()), transactionId: v.optional(v.string()), bodyHash: v.string() },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    if ((!args.transferId && !args.transactionId) || !/^[a-f0-9]{64}$/.test(args.bodyHash)) throw new Error("Invalid verified notification");
    const old = await ctx.db.query("demoInbox").withIndex("by_event", q => q.eq("scope.runId", args.scope.runId).eq("eventId", args.eventId)).unique();
    if (old) {
      if (old.bodyHash !== args.bodyHash || old.transferId !== args.transferId || old.transactionId !== args.transactionId) throw new Error("Event ID payload conflict");
      return { duplicate: true };
    }
    await ctx.db.insert("demoInbox", { scope: args.scope, eventId: args.eventId, transferId: args.transferId, transactionId: args.transactionId, bodyHash: args.bodyHash, receivedAt: Date.now(), processed: false });
    return { duplicate: false };
  },
});

/** Evidence service attests ownership of the exact resource referenced by the signed notice. */
export const ignoreForeignNotice = mutation({
  args: { ...serviceArgs, eventId: v.string(), resourceType: v.union(v.literal("ach_transfer"), v.literal("transaction")), resourceId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const notice = await ctx.db.query("demoInbox").withIndex("by_event", q => q.eq("scope.runId", args.scope.runId).eq("eventId", args.eventId)).unique();
    if (!notice || !args.accountId.trim() || args.accountId === args.scope.accountId ||
        (args.resourceType === "ach_transfer" ? notice.transferId !== args.resourceId : notice.transferId !== undefined || notice.transactionId !== args.resourceId)) {
      throw new Error("Foreign notification requires verified ownership of its direct resource");
    }
    if (notice.processed) return { replayed: true };
    const ignoredResource = { resourceType: args.resourceType, resourceId: args.resourceId, accountId: args.accountId, verifiedAt: Date.now() };
    await ctx.db.patch(notice._id, { processed: true, error: undefined, ignoredResource });
    await auditDemo(ctx, args.scope, "evidence-service", "notification_ignored_out_of_scope", { eventId: args.eventId, ...ignoredResource });
    return { replayed: false };
  },
});

/** The human explicitly classifies a verified sandbox wire as contributed demo capital. */
export const approveSandboxFunding = mutation({
  args: { scope: scopeValidator, transactionId: v.string(), expectedAmountCents: v.number(), reason: v.string() },
  handler: async (ctx, args) => {
    const { subject, seat } = await requirePaymentHuman(ctx, args.scope);
    const evidence = await transactionFor(ctx, args.scope, args.transactionId);
    const tx = evidence?.transaction;
    if (args.scope.provider !== "increase" || args.scope.environment !== "sandbox" || !tx ||
        tx.sourceCategory !== "inbound_wire_transfer" || tx.purpose !== "other" || tx.commandId || tx.transferId || tx.originalTransactionId ||
        tx.status !== "posted" || tx.amountCents <= 0 || tx.amountCents !== args.expectedAmountCents || !args.reason.trim()) {
      throw new Error("Review an imported positive sandbox funding wire and its exact amount");
    }
    if (evidence.entryId) {
      if (!evidence.fundingApproval) throw new Error("Transaction already classified differently");
      return { entryId: evidence.entryId, replayed: true };
    }
    const key = `demo:funding:${args.scope.runId}:${tx.id}`;
    const result = await appendDemoEntry(ctx, {
      runId: args.scope.runId, seat: accountingSeat(args.scope.runId), date: tx.postedAt!.slice(0, 10),
      memo: `Human-approved sandbox capital ${tx.id}`, source: { kind: "bank_match", ref: key },
      lines: [{ account: "1000", debit: tx.amountCents, credit: 0 }, { account: "3000", debit: 0, credit: tx.amountCents }], idempotencyKey: key,
    });
    if (!result.ok) throw new Error(`Funding posting blocked: ${result.code}: ${result.error}`);
    await ctx.db.patch(evidence._id, { entryId: result.entryId, state: "posted", error: undefined, matchedAt: Date.now(), fundingApproval: { subject, reason: args.reason.trim(), at: Date.now() } });
    await auditDemo(ctx, args.scope, seat.seatId, "sandbox_funding_approved", { transactionId: tx.id, amountCents: tx.amountCents, reason: args.reason.trim(), entryId: result.entryId });
    return { entryId: result.entryId, replayed: false };
  },
});

/** Durable imported records and the polling checkpoint commit together (or roll back together). */
export const importPage = mutation({
  args: { ...serviceArgs, expectedCursor: v.union(v.string(), v.null()), cursor: v.union(v.string(), v.null()), transactions: v.array(transactionValidator) },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const old = await ctx.db.query("demoCursors").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).unique();
    if ((old?.cursor ?? null) !== args.expectedCursor) return { stale: true };
    for (const transaction of args.transactions) await saveTransaction(ctx, args.scope, transaction);
    if (old) await ctx.db.patch(old._id, { cursor: args.cursor, updatedAt: Date.now() });
    else await ctx.db.insert("demoCursors", { scope: args.scope, cursor: args.cursor, updatedAt: Date.now() });
    return { stale: false };
  },
});

/** Non-AP transaction notifications still require a verified resource, but no ACH command. */
export const observeTransactionNotice = mutation({
  args: { ...serviceArgs, eventId: v.string(), transaction: transactionValidator },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const notice = await ctx.db.query("demoInbox").withIndex("by_event", q => q.eq("scope.runId", args.scope.runId).eq("eventId", args.eventId)).unique();
    if (!notice || notice.transferId || notice.transactionId !== args.transaction.id || args.transaction.commandId) throw new Error("Non-AP transaction notification mismatch");
    await saveTransaction(ctx, args.scope, args.transaction);
    await ctx.db.patch(notice._id, { processed: true, error: undefined });
  },
});
export const observeTransfer = mutation({
  args: { ...serviceArgs, observation: observationValidator, transactions: v.array(transactionValidator), eventId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    if (args.observation.status === "rejected" && args.transactions.length) throw new Error("Rejection conflicts with economic evidence");
    await saveObservation(ctx, args.scope, args.observation);
    for (const tx of args.transactions) {
      if (tx.transferId !== args.observation.id) throw new Error("Notification transaction/transfer mismatch");
      await saveTransaction(ctx, args.scope, tx);
    }
    if (args.eventId) {
      const notice = await ctx.db.query("demoInbox").withIndex("by_event", q => q.eq("scope.runId", args.scope.runId).eq("eventId", args.eventId!)).unique();
      if (!notice || (notice.transferId && notice.transferId !== args.observation.id) || (notice.transactionId && !args.transactions.some(t => t.id === notice.transactionId))) throw new Error("Notification resource mismatch");
      await ctx.db.patch(notice._id, { processed: true, error: undefined });
    }
  },
});

/** Unique transaction + purpose marker, journal, bill/credit effects and match are one mutation. */
export const postTransaction = mutation({
  args: { ...serviceArgs, transactionId: v.string() },
  handler: postVerifiedTransaction,
});
export const recordError = mutation({
  args: { ...serviceArgs, transactionId: v.optional(v.string()), eventId: v.optional(v.string()), error: v.string() },
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    if (args.transactionId) {
      const tx = await transactionFor(ctx, args.scope, args.transactionId);
      if (tx && !tx.entryId) await ctx.db.patch(tx._id, { state: "exception", error: args.error.slice(0, 500) });
    }
    if (args.eventId) {
      const n = await ctx.db.query("demoInbox").withIndex("by_event", q => q.eq("scope.runId", args.scope.runId).eq("eventId", args.eventId!)).unique();
      if (n && !n.processed) await ctx.db.patch(n._id, { error: args.error.slice(0, 500) });
    }
  },
});
export const work = query({
  args: serviceArgs, handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const [notices, commands, transactions, cursor] = await Promise.all([
      ctx.db.query("demoInbox").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(),
      ctx.db.query("demoCursors").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).unique(),
    ]);
    return { notices: notices.filter(n => !n.processed), commands: commands.filter(c => c.providerTransferId && !["cancelled", "rejected"].includes(c.execution)), transactions: transactions.filter(t => !t.entryId), cursor: cursor?.cursor ?? null };
  },
});
export const resolveCommand = query({
  args: { ...serviceArgs, idempotencyKey: v.string() }, handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const commands = await ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    return commands.find(c => c.command.idempotencyKey === args.idempotencyKey)?.command ?? null;
  },
});
async function readCloseState(ctx: QueryCtx, scope: BankScope) {
  const [commands, transactions, notices, versions, observations, bills, credits, ledgerHead] = await Promise.all([
    ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoInbox").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoVersions").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoObservations").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoBills").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("demoCredits").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect(),
    ctx.db.query("ledgerHeads").withIndex("by_run", q => q.eq("runId", scope.runId)).unique(),
  ]);
  return { commands, transactions, notices, versions, observations, bills, credits, ledgerHead };
}
type CloseState = Awaited<ReturnType<typeof readCloseState>>;
function blockersFor({ commands, transactions, notices, versions, observations, bills }: CloseState) {
  return [
    ...versions.filter(p => p.status === "awaiting_approval").map(p => ({ kind: "approval", id: p._id, reason: "Awaiting approval; cancel stale requests before closing" })),
    ...observations.filter(o => !commands.some(c => c.command.commandId === o.observation.commandId && c.providerTransferId === o.transferId)).map(o => ({ kind: "transfer", id: o.transferId, reason: "Unmatched verified bank transfer" })),
    ...commands.filter(c => !["cancelled", "rejected"].includes(c.execution) && (c.reconciliation !== "matched" || !["settled", "returned"].includes(c.execution))).map(c => ({ kind: "payment", id: c.command.commandId, reason: c.lastError ?? `${c.execution}/${c.posting}/${c.reconciliation}` })),
    ...transactions.filter(t => !t.entryId).map(t => ({ kind: "transaction", id: t.transaction.id, reason: t.error ?? t.state })),
    ...notices.filter(n => !n.processed).map(n => ({ kind: "notification", id: n.eventId, reason: n.error ?? "awaiting verification" })),
    ...bills.filter(b => b.status !== "paid" || b.flags.length > 0).map(b => ({ kind: "bill", id: b._id, reason: b.flags.length ? b.flags.join("; ") : b.status })),
  ];
}
export async function closeBlockers(ctx: QueryCtx, scope: BankScope) {
  return blockersFor(await readCloseState(ctx, scope));
}

/** Bind both signers to the same run-wide state, matching the scope of close blockers.
 * Index reads have stable creation order. Exclude polling timestamps and dispatcher
 * leases so observing identical bank facts cannot invalidate a pending signature. */
async function closeSnapshotHash(scope: BankScope, period: string, state: CloseState) {
  return sha256Hex(canonical({
    version: 1, scope, period, ledgerHead: state.ledgerHead?.hash ?? "genesis",
    bills: state.bills, credits: state.credits, versions: state.versions,
    commands: state.commands.map(c => ({ id: c._id, command: c.command, providerTransferId: c.providerTransferId,
      execution: c.execution, posting: c.posting, reconciliation: c.reconciliation, lastError: c.lastError })),
    transactions: state.transactions.map(({ importedAt: _, matchedAt: _m, ...facts }) => facts),
    notices: state.notices.map(({ receivedAt: _, ...facts }) => facts),
    observations: state.observations.map(({ importedAt: _, observation, ...identity }) => {
      const { updatedAt: _u, ...facts } = observation;
      return { ...identity, observation: facts };
    }),
  }));
}
export const view = query({
  args: { scope: scopeValidator, seatId: v.string(), token: v.string() }, handler: async (ctx, args) => {
    const { seat } = await requireDemoSeat(ctx, args, ["controller", "cfo_agent", "auditor", "payments", "ap_clerk", "treasury", "fpa", "cash_application", "revenue_accountant", "lease_accountant", "payroll_accountant", "integrations_engineer"]);
    const blockers = await closeBlockers(ctx, args.scope);
    const transactions = await ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    if (["controller", "cfo_agent", "auditor", "cash_application"].includes(seat.role)) return { transactions, blockers };
    if (seat.role === "ap_clerk") return { blockers: blockers.filter(b => b.kind === "bill") };
    if (seat.role === "payments") return { blockers: blockers.filter(b => b.kind === "payment") };
    if (seat.role === "integrations_engineer") return { diagnostics: transactions.map(t => ({ id: t.transaction.id, state: t.state, error: t.error })) };
    return { unresolvedCount: blockers.length, importedCount: transactions.length };
  },
});
export const humanView = query({
  args: { scope: scopeValidator }, handler: async (ctx, args) => {
    await requireHuman(ctx, args.scope);
    return { transactions: await ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect(), blockers: await closeBlockers(ctx, args.scope) };
  },
});
export const proposeMatch = mutation({
  args: { scope: scopeValidator, seatId: v.string(), token: v.string(), transactionId: v.string(), commandId: v.string(), note: v.string() },
  handler: async (ctx, args) => {
    await requireDemoSeat(ctx, args, ["controller"]);
    if (!await transactionFor(ctx, args.scope, args.transactionId) || !await commandFor(ctx, args.scope, args.commandId)) throw new Error("Match references outside scope");
    await ctx.db.insert("demoReconciliationProposals", { scope: args.scope, transactionId: args.transactionId, commandId: args.commandId, proposedBy: args.seatId, note: args.note, at: Date.now() });
  },
});

/** Demo close requires both signatures and no unexplained cash, payments, invoices or notices. */
export const signClose = mutation({
  args: { scope: scopeValidator, period: v.string(), seatId: v.optional(v.string()), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = args.seatId && args.token
      ? (await requirePaymentSeat(ctx, { scope: args.scope, seatId: args.seatId, token: args.token }, ["controller"])).seat
      : (await requirePaymentHuman(ctx, args.scope)).seat;
    const state = await readCloseState(ctx, args.scope);
    const blockers = blockersFor(state);
    if (blockers.length) throw new Error(`AP close blocked: ${blockers.map(b => `${b.kind} ${b.id}: ${b.reason}`).join("; ")}`);
    const period = await ctx.db.query("periods").withIndex("by_run_period", q => q.eq("runId", args.scope.runId).eq("period", args.period)).unique();
    if (!period) throw new Error("Period not found");
    if (period.status === "closed") return { status: "closed" as const };
    // Convex commits the snapshot reads and signatures atomically; concurrent writes retry.
    // Old signatures without a snapshot also require a fresh review after this upgrade.
    const snapshotHash = await closeSnapshotHash(args.scope, args.period, state);
    const previousSigners = period.closeSnapshotHash === snapshotHash ? period.closedBy ?? [] : [];
    const signedBy = [...new Set([...previousSigners, actor.seatId])];
    const seats = await Promise.all(signedBy.map(id => ctx.db.query("seats").withIndex("by_run_seat", q => q.eq("runId", args.scope.runId).eq("seatId", id)).unique()));
    const ready = seats.some(s => s?.role === "controller" && s.kind === "agent" && s.status === "active") && seats.some(s => s?.kind === "human" && s.status === "active");
    await ctx.db.patch(period._id, { closedBy: signedBy, closeSnapshotHash: snapshotHash, status: ready ? "closed" : "open", closedAt: ready ? Date.now() : undefined });
    await auditDemo(ctx, args.scope, actor.seatId, "close_signed", { period: args.period, ready, snapshotHash });
    return { status: ready ? "closed" as const : "open" as const };
  },
});
