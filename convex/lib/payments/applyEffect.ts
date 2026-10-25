import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { assertRowScope, auditDemo, requirePaymentDispatcher } from "../demoAuth";
import { assertDispatchAuthority } from "./executionConfig";
import { PAYMENT_EXECUTOR_VERSION, type BankScope, type EffectLease } from "../../../src/payments/contracts";

type DispatcherArgs = { scope: BankScope; token: string; paymentExecutorVersion?: string };
type ClaimArgs = DispatcherArgs & { commandId: Id<"demoCommands">; generation: number; leaseToken: string };
const LEASE_MS = 30_000;
const ATTEMPT_BUDGET = 8;
const TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
async function ownedClaim(ctx: MutationCtx, args: ClaimArgs) {
  await requirePaymentDispatcher(ctx, args);
  const c = await ctx.db.get(args.commandId); assertRowScope(c, args.scope);
  const row = c as Doc<"demoCommands">;
  if (row.execution !== "in_flight" || row.generation !== args.generation || row.leaseToken !== args.leaseToken || (row.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Stale dispatcher lease");
  const attempt = await ctx.db.query("demoAttempts").withIndex("by_command", q => q.eq("commandId", row._id).eq("generation", row.generation)).unique();
  if (!attempt || attempt.completedAt) throw new Error("Attempt already completed");
  return { row, attempt };
}
export async function claimEffect(ctx: MutationCtx, args: DispatcherArgs & { workerId: string; leaseToken: string }) {
    const config = await requirePaymentDispatcher(ctx, args);
    if (!args.workerId.trim() || args.leaseToken.length < 16) throw new Error("Unique worker lease token required");
    const now = Date.now();
    const rows = await ctx.db.query("demoCommands").withIndex("by_run", q => q.eq("scope.runId", args.scope.runId)).collect();
    for (const row of rows.sort((a,b) => a.nextAttemptAt - b.nextAttemptAt)) {
      if (!(row.execution === "queued" || row.execution === "unknown" || (row.execution === "in_flight" && (row.leaseExpiresAt ?? 0) <= now)) || row.nextAttemptAt > now) continue;
      if ((row.budgetAttemptCount ?? row.attemptCount) >= ATTEMPT_BUDGET || ((row.budgetStartedAt ?? row.firstAttemptAt) !== undefined && now - (row.budgetStartedAt ?? row.firstAttemptAt)! >= TIME_BUDGET_MS)) {
        await ctx.db.patch(row._id, { execution: "exception", lastError: "Automatic recovery budget exhausted; bank outcome unresolved", leaseToken: undefined, leaseExpiresAt: undefined });
        continue;
      }
      if (row.leaseToken === args.leaseToken) throw new Error("Restart requires a fresh lease token");
      const priorAttempt = await ctx.db.query("demoAttempts").withIndex("by_command", q => q.eq("commandId", row._id)).first();
      const firstDispatch = row.attemptCount === 0 && row.generation === 0 && row.firstAttemptAt === undefined &&
        row.execution === "queued" && !row.providerTransferId && !priorAttempt;
      if (!firstDispatch && (row.firstAttemptAt === undefined || !Number.isSafeInteger(row.firstAttemptAt) || row.firstAttemptAt < 0 || row.firstAttemptAt > now)) {
        throw new Error("Historical dispatch is ambiguous; original first attempt required for review");
      }
      try {
        await assertDispatchAuthority(ctx, config, row, firstDispatch);
      } catch (error) {
        // Persist review work instead of endlessly retrying stale approval. Preserve all
        // reservations: corrupt snapshot data is not sufficient authority to release them.
        if (!firstDispatch) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        await ctx.db.patch(row._id, { execution: "exception", lastError: `First dispatch blocked: ${reason}`.slice(0, 2000), leaseToken: undefined, leaseExpiresAt: undefined });
        await auditDemo(ctx, args.scope, "dispatcher", "payment_dispatch_blocked", { commandId: row._id, reason });
        continue;
      }
      const firstAttemptAt = row.firstAttemptAt ?? now;
      const leaseExpiresAt = now + LEASE_MS;
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, { execution: "in_flight", generation, leaseToken: args.leaseToken, leaseExpiresAt, attemptCount: row.attemptCount + 1, budgetAttemptCount: (row.budgetAttemptCount ?? row.attemptCount) + 1, budgetStartedAt: row.budgetStartedAt ?? now, firstAttemptAt });
      await ctx.db.insert("demoAttempts", { scope: args.scope, commandId: row._id, generation, leaseToken: args.leaseToken, workerId: args.workerId, startedAt: now });
      return { commandId: row._id, command: row.command, generation, leaseToken: args.leaseToken,
        paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, action: firstDispatch ? "submit" as const : "reconcile" as const,
        firstAttemptAt, leaseExpiresAt, providerTransferId: row.providerTransferId } satisfies EffectLease;
    }
    return null;
}

export async function completeEffect(ctx: MutationCtx, args: ClaimArgs & { providerTransferId: string }) {
    const { row, attempt } = await ownedClaim(ctx, args);
    if (!args.providerTransferId.trim() || (row.providerTransferId && row.providerTransferId !== args.providerTransferId)) throw new Error("Provider transfer identity conflict");
    const duplicate = await ctx.db.query("demoCommands").withIndex("by_transfer", q => q.eq("scope.runId", args.scope.runId).eq("providerTransferId", args.providerTransferId)).unique();
    if (duplicate && duplicate._id !== row._id) throw new Error("Provider transfer already belongs to another command");
    await ctx.db.patch(row._id, { execution: "pending", providerTransferId: args.providerTransferId, leaseToken: undefined, leaseExpiresAt: undefined, lastError: undefined });
    await ctx.db.patch(attempt._id, { completedAt: Date.now(), result: "provider_accepted" });
    return { ok: true as const };
}

export async function failEffect(ctx: MutationCtx, args: ClaimArgs & { errorClass: string; error: string; retryAfterMs?: number }) {
    const { row, attempt } = await ownedClaim(ctx, args);
    const classes = ["validation", "authentication", "configuration", "rate_limit", "transport", "unknown", "idempotency_conflict", "not_found"];
    if (!classes.includes(args.errorClass) || (args.retryAfterMs !== undefined && (!Number.isSafeInteger(args.retryAfterMs) || args.retryAfterMs < 0))) throw new Error("Invalid provider failure classification");
    const retryable = ["rate_limit", "transport", "unknown", "not_found"].includes(args.errorClass);
    const exhausted = (row.budgetAttemptCount ?? row.attemptCount) >= ATTEMPT_BUDGET || Date.now() - (row.budgetStartedAt ?? row.firstAttemptAt)! >= TIME_BUDGET_MS;
    // Deterministic persisted jitter: restarts cannot erase/recompute a chosen retry time.
    const jitter = (row.generation * 7919) % 1000;
    const backoff = Math.min(60_000, 500 * 2 ** (row.attemptCount - 1)) + jitter;
    const nextAttemptAt = Date.now() + Math.max(backoff, args.retryAfterMs ?? 0);
    const execution = retryable && !exhausted ? "unknown" as const : "exception" as const;
    await ctx.db.patch(row._id, { execution, lastError: `${args.errorClass}: ${args.error}`.slice(0, 2000), nextAttemptAt, leaseToken: undefined, leaseExpiresAt: undefined });
    await ctx.db.patch(attempt._id, { completedAt: Date.now(), result: execution, errorClass: args.errorClass });
    return { execution, nextAttemptAt };
}
export async function heartbeatEffect(ctx: MutationCtx, args: ClaimArgs) {
  const { row } = await ownedClaim(ctx, args);
  await ctx.db.patch(row._id, { leaseExpiresAt: Date.now() + LEASE_MS });
  return { ok: true as const };
}
