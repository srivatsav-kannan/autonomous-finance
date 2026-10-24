import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { accountingSeat, auditDemo, requireService } from "../demoAuth";
import { appendDemoEntry } from "../demoPost";
import { releaseReservations, settleEffects, returnEffects } from "./reservations";
import { canonicalJson, sameBankScope, type BankScope, type BankTransaction, type TransferObservation } from "../../../src/payments/contracts";
import { assertObservationMatchesCommand, assertPostingEvidence } from "../../../src/payments/domain/rules";
import { assertFrozenBankCommand, parseBankTransaction, parseTransferObservation } from "../../../src/payments/domain/validation";

const rank = { pending: 0, rejected: 1, settled: 2, returned: 3 };
function scoped(a: BankScope, b: BankScope) { if (!sameBankScope(a, b)) throw new Error("Bank evidence scope mismatch"); }
export async function commandFor(ctx: QueryCtx, scope: BankScope, id: string) {
  return ctx.db.query("demoCommands").withIndex("by_command", q => q.eq("scope.runId", scope.runId).eq("command.commandId", id)).unique();
}
export async function transactionFor(ctx: QueryCtx, scope: BankScope, id: string) {
  return ctx.db.query("demoTransactions").withIndex("by_transaction", q => q.eq("scope.runId", scope.runId).eq("transaction.id", id)).unique();
}
function checkObservation(command: Doc<"demoCommands">, observation: TransferObservation) {
  assertObservationMatchesCommand(command.command, observation, command);
}
export async function saveObservation(ctx: MutationCtx, scope: BankScope, observation: TransferObservation) {
  scoped(scope, observation.scope);
  parseTransferObservation(observation);
  const command = await commandFor(ctx, scope, observation.commandId);
  if (command) { await assertFrozenBankCommand(command.command); checkObservation(command, observation); }
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
export async function saveTransaction(ctx: MutationCtx, scope: BankScope, transaction: BankTransaction) {
  scoped(scope, transaction.scope);
  parseBankTransaction(transaction);
  if (transaction.status !== "posted") throw new Error("Pending transaction is not economic evidence");
  const old = await transactionFor(ctx, scope, transaction.id);
  if (old) {
    if (canonicalJson(old.transaction) !== canonicalJson(transaction)) throw new Error("Immutable bank transaction changed");
    return;
  }
  const command = await commandFor(ctx, scope, transaction.commandId);
  await ctx.db.insert("demoTransactions", { scope, transaction, commandRowId: command?._id, state: command ? "ready" : "unmatched", importedAt: Date.now() });
}

export async function postVerifiedTransaction(ctx: MutationCtx, args: { scope: BankScope; token: string; transactionId: string }) {
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
    await assertFrozenBankCommand(command.command);
    const returning = tx.purpose === "return";
    const original = returning && observation.originalTransactionId ? await transactionFor(ctx, args.scope, observation.originalTransactionId) : null;
    assertPostingEvidence(command.command, observation, tx, original?.entryId ? { transaction: original.transaction, entryId: original.entryId } : undefined);
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
}
