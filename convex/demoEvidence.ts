import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { scopeValidator } from "./demoSchema";
import { transactionValidator, observationValidator } from "./demoEvidenceSchema";
import { requireService, requireDemoSeat, requireHuman, accountingSeat, auditDemo } from "./lib/demoAuth";
import { releaseReservations, settleEffects, returnEffects } from "./lib/demoEffects";
import { appendDemoEntry } from "./lib/demoPost";
import { canonical, sha256Hex } from "./lib/kernel";
import { canonicalJson, sameBankScope, type BankScope, type BankTransaction, type TransferObservation } from "../src/integrations/contracts";

const serviceArgs = { scope: scopeValidator, token: v.string() };
const rank = { pending: 0, rejected: 1, settled: 2, returned: 3 };
function scoped(a: BankScope, b: BankScope) { if (!sameBankScope(a, b)) throw new Error("Bank evidence scope mismatch"); }
async function commandFor(ctx: QueryCtx, scope: BankScope, id: string) {
  return ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", scope.runId).eq("command.commandId", id)).unique();
}
async function transactionFor(ctx: QueryCtx, scope: BankScope, id: string) {
  return ctx.db.query("demoTransactions").withIndex("by_transaction", q => q.eq("scope.runId", scope.runId).eq("transaction.id", id)).unique();
}
function checkObservation(command: Doc<"demoCommands">, observation: TransferObservation) {
  scoped(command.scope, observation.scope);
  const c = command.command;
  if (c.commandId !== observation.commandId || c.requestHash !== observation.requestHash || c.idempotencyKey !== observation.idempotencyKey ||
      c.amountCents !== observation.amountCents || c.currency !== observation.currency || canonicalJson(c.destination) !== canonicalJson(observation.destination)) throw new Error("Bank transfer differs from approved command");
  if (command.providerTransferId && command.providerTransferId !== observation.id) throw new Error("Command already bound to another transfer");
  if (command.firstAttemptAt === undefined) throw new Error("Transfer has no recorded dispatch attempt");
  if (command.execution === "cancelled") throw new Error("Bank evidence for cancelled command");
}
async function saveObservation(ctx: MutationCtx, scope: BankScope, observation: TransferObservation) {
  scoped(scope, observation.scope);
  const command = await commandFor(ctx, scope, observation.commandId);
  if (command) checkObservation(command, observation);
  const old = await ctx.db.query("demoObservations").withIndex("by_transfer", q => q.eq("scope.runId", scope.runId).eq("transferId", observation.id)).unique();
  if (old) {
    const { status: _s, updatedAt: _u, pendingTransactionId: _p, originalTransactionId: _o, returnTransactionId: _r, rejectionReason: _rr, ...identity } = old.observation;
    const { status: _s2, updatedAt: _u2, pendingTransactionId: _p2, originalTransactionId: _o2, returnTransactionId: _r2, rejectionReason: _rr2, ...nextIdentity } = observation;
    if (canonicalJson(identity) !== canonicalJson(nextIdentity)) throw new Error("Immutable bank transfer identity changed");
    for (const field of ["originalTransactionId", "returnTransactionId"] as const) {
      if (old.observation[field] && observation[field] && old.observation[field] !== observation[field]) throw new Error("Bank economic evidence identity changed");
    }
    if (rank[observation.status] < rank[old.observation.status]) return;
    for (const field of ["originalTransactionId", "returnTransactionId"] as const) {
      if (old.observation[field] && !observation[field]) throw new Error("Bank economic evidence identity changed");
    }
    await ctx.db.patch(old._id, { observation, importedAt: Date.now() });
  } else await ctx.db.insert("demoObservations", { scope, transferId: observation.id, observation, importedAt: Date.now() });
  if (!command) return; // A verified early notice is retained until the command is recoverable.
  if (observation.status === "rejected") {
    const activity = await ctx.db.query("demoTransactions").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).collect();
    if (activity.some(t => t.transaction.transferId === observation.id || t.transaction.commandId === command.command.commandId)) throw new Error("Rejection conflicts with economic evidence");
    if (observation.originalTransactionId || observation.returnTransactionId || command.posting !== "unposted") throw new Error("Rejection conflicts with economic evidence");
    await releaseReservations(ctx, command.versionId);
    await ctx.db.patch(command.versionId, { status: "rejected" });
  }
  // A settled observation is still not cash-posting evidence. Posting needs its posted transaction.
  const execution = observation.status;
  if (command.execution !== "returned" && !(command.execution === "settled" && execution === "pending")) {
    await ctx.db.patch(command._id, { providerTransferId: observation.id, execution, reconciliation: (execution === "returned" && command.posting !== "returned") || (execution === "settled" && command.posting === "unposted") ? "unmatched" : command.reconciliation, leaseToken: undefined, leaseExpiresAt: undefined });
  }
}
async function saveTransaction(ctx: MutationCtx, scope: BankScope, transaction: BankTransaction) {
  scoped(scope, transaction.scope);
  if (!Number.isSafeInteger(transaction.amountCents) || transaction.amountCents === 0) throw new Error("Invalid bank integer cents");
  if (transaction.status !== "posted") throw new Error("Pending transaction is not economic evidence");
  if (!transaction.postedAt || !Number.isFinite(Date.parse(transaction.postedAt))) throw new Error("Bank posted timestamp required");
  const old = await transactionFor(ctx, scope, transaction.id);
  if (old) {
    if (canonicalJson(old.transaction) !== canonicalJson(transaction)) throw new Error("Immutable bank transaction changed");
    return;
  }
  const command = await commandFor(ctx, scope, transaction.commandId);
  await ctx.db.insert("demoTransactions", { scope, transaction, commandRowId: command?._id, state: command ? "ready" : "unmatched", importedAt: Date.now() });
}

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
  handler: async (ctx, args) => {
    await requireService(ctx, args.scope, args.token, "evidence");
    const evidence = await transactionFor(ctx, args.scope, args.transactionId);
    if (!evidence) throw new Error("Imported evidence not found");
    if (evidence.entryId) return { entryId: evidence.entryId, replayed: true };
    const tx = evidence.transaction;
    const command = await commandFor(ctx, args.scope, tx.commandId);
    if (!command) throw new Error("Unmatched bank transaction");
    const observed = await ctx.db.query("demoObservations").withIndex("by_transfer", q => q.eq("scope.runId", args.scope.runId).eq("transferId", tx.transferId)).unique();
    if (!observed) throw new Error("Verified transfer observation missing");
    const observation = observed.observation;
    checkObservation(command, observation);
    if (tx.status !== "posted" || tx.currency !== command.command.currency || tx.transferId !== observation.id) throw new Error("Unverified economic evidence");
    const returning = tx.purpose === "return";
    if (Math.abs(tx.amountCents) !== command.command.amountCents || (returning ? tx.amountCents < 0 : tx.amountCents > 0)) throw new Error("Bank debit/return amount differs from approved amount");
    if (returning) {
      if (observation.status !== "returned" || observation.returnTransactionId !== tx.id || !observation.originalTransactionId || tx.originalTransactionId !== observation.originalTransactionId) throw new Error("Return requires distinct verified original debit and return");
      const original = await transactionFor(ctx, args.scope, observation.originalTransactionId);
      if (!original?.entryId || original.transaction.purpose !== "debit" || original.transaction.transferId !== tx.transferId) throw new Error("Post original debit before the return");
    } else if (!["settled", "returned"].includes(observation.status) || observation.originalTransactionId !== tx.id) throw new Error("Bank settlement evidence missing");
    const amount = Math.abs(tx.amountCents);
    const key = `${args.scope.organizationId}:${args.scope.runId}:${args.scope.provider}:${args.scope.environment}:${args.scope.accountId}:${tx.id}:${tx.purpose}`;
    const result = await appendDemoEntry(ctx, {
      runId: args.scope.runId, seat: accountingSeat(args.scope.runId), date: tx.postedAt!.slice(0, 10),
      memo: `Verified ACH ${tx.purpose} ${tx.id}`, source: { kind: "payment_settlement", ref: key },
      lines: returning ? [{ account: "1000", debit: amount, credit: 0 }, { account: "2000", debit: 0, credit: amount }] : [{ account: "2000", debit: amount, credit: 0 }, { account: "1000", debit: 0, credit: amount }], idempotencyKey: key,
    });
    if (!result.ok) throw new Error(`Local posting blocked: ${result.code}: ${result.error}`);
    if (returning) await returnEffects(ctx, command.versionId);
    else await settleEffects(ctx, command.versionId);
    await ctx.db.patch(evidence._id, { entryId: result.entryId, commandRowId: command._id, state: "posted", error: undefined, matchedAt: Date.now() });
    await ctx.db.patch(command._id, {
      posting: returning ? "returned" : "posted", execution: observation.status, reconciliation: returning || observation.status === "settled" ? "matched" : "unmatched", lastError: undefined,
    });
    await auditDemo(ctx, args.scope, "evidence-service", "bank-posted-and-matched", { transactionId: tx.id, entryId: result.entryId, commandId: command.command.commandId });
    return { entryId: result.entryId, replayed: false };
  },
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
      ? (await requireDemoSeat(ctx, { scope: args.scope, seatId: args.seatId, token: args.token }, ["controller"])).seat
      : (await requireHuman(ctx, args.scope)).seat;
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
