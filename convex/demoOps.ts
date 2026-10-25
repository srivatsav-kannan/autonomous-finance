import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { scopeValidator } from "./demoSchema";
import { requireHuman, requirePaymentDispatcher, requireService } from "./lib/demoAuth";
import { ATTEMPT_BUDGET, TIME_BUDGET_MS } from "./lib/payments/applyEffect";
import type { BankScope } from "../src/payments/contracts";

/** Proposed SLO thresholds. They are TARGETS: none has been measured against a deployed backend.
 * The service loop sleeps 1 s between passes, the dispatcher lease is 30 s and its heartbeat 10 s. */
export const SLO_TARGETS = {
  basis: "target_not_measured",
  workerPassMaxAgeMs: 60_000,
  consecutiveFailedPasses: 3,
  eligibleCommandMaxWaitMs: 5 * 60_000,
  unknownOutcomeMaxAgeMs: 15 * 60_000,
  unpostedTransactionMaxAgeMs: 15 * 60_000,
  pendingNoticeMaxAgeMs: 15 * 60_000,
  quarantineAfterFetchAttempts: 5,
} as const;
const CAP = 200; // Bounded indexed reads; counts at the cap are reported as capped.
const OUTCOMES = ["ok", "partial", "failed"] as const;
const ERROR_CLASSES = ["validation", "authentication", "configuration", "rate_limit", "transport", "unknown",
  "idempotency_conflict", "not_found", "stale_lease", "item_errors", "kernel"];
const NEVER = "Never generate a new provider key, resend a transfer, or free a reservation just to clear this warning.";

const passArgs = { scope: scopeValidator, token: v.string(), workerId: v.string(), outcome: v.union(v.literal("ok"), v.literal("partial"), v.literal("failed")), errorClass: v.optional(v.string()) };
type PassArgs = { scope: BankScope; workerId: string; outcome: typeof OUTCOMES[number]; errorClass?: string };

async function recordPass(ctx: MutationCtx, worker: "dispatcher" | "evidence", args: PassArgs) {
  if (!args.workerId.trim() || args.workerId.length > 100 || (args.errorClass !== undefined && !ERROR_CLASSES.includes(args.errorClass))) {
    throw new Error("Invalid worker health report");
  }
  const now = Date.now();
  const old = await ctx.db.query("demoWorkerHealth").withIndex("by_worker", q => q.eq("scope.runId", args.scope.runId).eq("worker", worker)).unique();
  const failed = args.outcome === "failed";
  const fields = {
    workerId: args.workerId, lastPassAt: now, lastOutcome: args.outcome, lastErrorClass: args.errorClass,
    ...(failed ? { lastFailureAt: now } : { lastSuccessAt: now }),
    consecutiveFailures: failed ? (old?.consecutiveFailures ?? 0) + 1 : 0,
  };
  if (old) await ctx.db.patch(old._id, fields);
  else await ctx.db.insert("demoWorkerHealth", { scope: args.scope, worker, ...fields });
}
/** Wall-clock pass report from the dispatcher service. Never touches financial state. */
export const recordDispatcherPass = mutation({
  args: { ...passArgs, paymentExecutorVersion: v.optional(v.string()) },
  handler: async (ctx, args) => { await requirePaymentDispatcher(ctx, args); await recordPass(ctx, "dispatcher", args); },
});
/** Wall-clock pass report from the evidence service. Never touches financial state. */
export const recordEvidencePass = mutation({
  args: passArgs,
  handler: async (ctx, args) => { await requireService(ctx, args.scope, args.token, "evidence"); await recordPass(ctx, "evidence", args); },
});

type Alert = { state: string; severity: "warning" | "critical"; observed: string; action: string; never: string };
const counted = <T>(rows: T[]) => ({ count: rows.length, capped: rows.length >= CAP });
const age = (now: number, at: number | undefined) => at === undefined ? null : Math.max(0, now - at);
const oldest = (now: number, times: number[]) => times.length ? Math.max(0, now - Math.min(...times)) : null;

async function commandsIn(ctx: QueryCtx, scope: BankScope, execution: Doc<"demoCommands">["execution"], dueBy?: number) {
  return ctx.db.query("demoCommands").withIndex("by_run_execution", q => {
    const base = q.eq("scope.runId", scope.runId).eq("execution", execution);
    return dueBy === undefined ? base : base.lte("nextAttemptAt", dueBy);
  }).take(CAP);
}

/** Operator health for one authorized organization/run/account. Ages use server wall-clock
 * timestamps recorded by Convex (nextAttemptAt, firstAttemptAt, importedAt, receivedAt, worker
 * passes), never bank or fixture business dates. Returns counts, ages, row ids and error
 * classes only: no commands, keys, saved requests, lease tokens or provider messages. */
export const operatorHealth = query({
  args: { scope: scopeValidator },
  handler: async (ctx, args) => {
    const { config } = await requireHuman(ctx, args.scope);
    const scope = config.scope;
    const now = Date.now();
    const [queued, unknown, inFlight, exceptions, settled, returned, health, unmatched, ready, failedPosting, retries, notices, cursor] = await Promise.all([
      commandsIn(ctx, scope, "queued", now), commandsIn(ctx, scope, "unknown"), commandsIn(ctx, scope, "in_flight"),
      commandsIn(ctx, scope, "exception"), commandsIn(ctx, scope, "settled"), commandsIn(ctx, scope, "returned"),
      ctx.db.query("demoWorkerHealth").withIndex("by_worker", q => q.eq("scope.runId", scope.runId)).take(2),
      ctx.db.query("demoTransactions").withIndex("by_run_state", q => q.eq("scope.runId", scope.runId).eq("state", "unmatched")).take(CAP),
      ctx.db.query("demoTransactions").withIndex("by_run_state", q => q.eq("scope.runId", scope.runId).eq("state", "ready")).take(CAP),
      ctx.db.query("demoTransactions").withIndex("by_run_state", q => q.eq("scope.runId", scope.runId).eq("state", "exception")).take(CAP),
      ctx.db.query("demoEvidenceRetries").withIndex("by_run_open", q => q.eq("scope.runId", scope.runId).eq("open", true)).take(CAP),
      ctx.db.query("demoInbox").withIndex("by_run_processed", q => q.eq("scope.runId", scope.runId).eq("processed", false)).take(CAP),
      ctx.db.query("demoCursors").withIndex("by_run", q => q.eq("scope.runId", scope.runId)).unique(),
    ]);
    const cancelled = (await ctx.db.query("demoCommands").withIndex("by_run_execution", q => q.eq("scope.runId", scope.runId).eq("execution", "cancelled")).take(CAP))
      .filter(c => c.lateTransferId);
    const workerView = (worker: "dispatcher" | "evidence") => {
      const row = health.find(h => h.worker === worker);
      return row ? { workerId: row.workerId, lastPassAt: row.lastPassAt, lastPassAgeMs: age(now, row.lastPassAt),
        lastSuccessAt: row.lastSuccessAt ?? null, lastSuccessAgeMs: age(now, row.lastSuccessAt), lastOutcome: row.lastOutcome,
        lastErrorClass: row.lastErrorClass ?? null, consecutiveFailures: row.consecutiveFailures } : null;
    };
    const workers = { dispatcher: workerView("dispatcher"), evidence: workerView("evidence") };
    const expired = inFlight.filter(c => (c.leaseExpiresAt ?? 0) <= now);
    const eligible = [...queued.map(c => Math.max(c.createdAt, c.nextAttemptAt)), ...unknown.filter(c => c.nextAttemptAt <= now).map(c => c.nextAttemptAt), ...expired.map(c => c.leaseExpiresAt ?? c.createdAt)];
    const unknownOutcome = [...inFlight, ...unknown, ...exceptions].filter(c => c.firstAttemptAt !== undefined && !c.providerTransferId);
    const exhausted = exceptions.filter(c => (c.budgetAttemptCount ?? c.attemptCount) >= ATTEMPT_BUDGET ||
      ((c.budgetStartedAt ?? c.firstAttemptAt) !== undefined && now - (c.budgetStartedAt ?? c.firstAttemptAt)! >= TIME_BUDGET_MS));
    const exceptionClasses = [...new Set(exceptions.map(c => (c.lastError ?? "unknown").split(":")[0]!.trim().slice(0, 40)))];
    // The bank settled (or returned) a payment whose local journal posting has not succeeded.
    const settledUnposted = [...settled.filter(c => c.posting === "unposted"), ...returned.filter(c => c.posting !== "returned")];
    const postingFailed = failedPosting.filter(t => t.commandRowId);
    const unposted = [...unmatched, ...ready, ...failedPosting];
    const quarantined = retries.filter(r => r.attempts >= SLO_TARGETS.quarantineAfterFetchAttempts);
    const summary = {
      commands: {
        eligible: { ...counted(eligible), oldestWaitMs: oldest(now, eligible) },
        unknownOutcome: { ...counted(unknownOutcome), oldestAgeMs: oldest(now, unknownOutcome.map(c => c.firstAttemptAt!)), oldestId: unknownOutcome.sort((a, b) => a.firstAttemptAt! - b.firstAttemptAt!)[0]?._id ?? null },
        retryExhausted: { ...counted(exhausted), ids: exhausted.slice(0, 20).map(c => c._id) },
        exceptions: { ...counted(exceptions), errorClasses: exceptionClasses },
        bankSettledLocalUnposted: { count: settledUnposted.length + postingFailed.length, ids: [...settledUnposted.map(c => c._id), ...postingFailed.map(t => t.commandRowId!)].slice(0, 20) },
        lateTransfersAfterRelease: { count: cancelled.length, ids: cancelled.map(c => c._id) },
      },
      evidence: {
        unpostedTransactions: { ...counted(unposted), oldestAgeMs: oldest(now, unposted.map(t => t.importedAt)) },
        fetchRetries: { ...counted(retries), quarantined: quarantined.length, oldestAgeMs: oldest(now, retries.map(r => r.firstFailedAt)) },
        pendingNotices: { ...counted(notices), oldestAgeMs: oldest(now, notices.map(n => n.receivedAt)) },
        cursor: cursor ? { lastImportAt: cursor.updatedAt, lastImportAgeMs: age(now, cursor.updatedAt), scanCompletedAt: cursor.scanCompletedAt ?? null, scanCompletedAgeMs: age(now, cursor.scanCompletedAt) } : null,
      },
    };

    const alerts: Alert[] = [];
    const alert = (state: string, severity: Alert["severity"], observed: string, action: string) => alerts.push({ state, severity, observed, action, never: NEVER });
    const hasWork = eligible.length + unknownOutcome.length + summary.commands.bankSettledLocalUnposted.count + unposted.length + retries.length + notices.length > 0;
    for (const [name, view] of [["dispatcher", workers.dispatcher], ["evidence", workers.evidence]] as const) {
      const script = name === "dispatcher" ? "npm run worker:dispatch" : "npm run worker:evidence";
      if (!view) { if (hasWork) alert(`${name}_not_reporting`, "critical", "No pass recorded for this run", `Start ${script} with CONVEX_URL, AP_BANK_SCOPE and the ${name} service secret for this run.`); continue; }
      if (view.lastPassAgeMs! > SLO_TARGETS.workerPassMaxAgeMs) {
        alert(`${name}_stale`, "critical", `Last pass ${Math.round(view.lastPassAgeMs! / 1000)} s ago`,
          `Restore ${name} connectivity: check the process is running, reaches CONVEX_URL and uses this run's AP_BANK_SCOPE; restart ${script}.`);
      }
      if (view.consecutiveFailures >= SLO_TARGETS.consecutiveFailedPasses) {
        alert(`${name}_failing`, "critical", `${view.consecutiveFailures} failed passes (${view.lastErrorClass ?? "unknown"})`,
          view.lastErrorClass === "authentication" || view.lastErrorClass === "configuration"
            ? `Repair credentials or configuration: the ${name} service secret, AP_BANK_SCOPE and the provider API key must match this deployment.`
            : `Restore ${name} connectivity to Convex and the bank; the worker retries automatically once reachable.`);
      }
    }
    if (eligible.length && oldest(now, eligible)! > SLO_TARGETS.eligibleCommandMaxWaitMs) {
      alert("dispatch_backlog", "warning", `${eligible.length} eligible command(s), oldest waiting ${Math.round(oldest(now, eligible)! / 1000)} s`,
        "Confirm the dispatcher is running and passing; eligible work is claimed in order with its original saved request and key.");
    }
    if (unknownOutcome.length && summary.commands.unknownOutcome.oldestAgeMs! > SLO_TARGETS.unknownOutcomeMaxAgeMs) {
      alert("unknown_outcome", "warning", `${unknownOutcome.length} attempted command(s) without a confirmed bank transfer`,
        "Keep reservations. The dispatcher reconciles by operation-key lookup; for a command in exception, inspect it in humanReview and use the audited resume action with a reason.");
    }
    if (exhausted.length) {
      alert("retry_exhausted", "critical", `${exhausted.length} command(s) exhausted automatic recovery`,
        "Inspect the quarantined command in humanReview, confirm its outcome with the provider using the original key, then use the audited resume action with a reason.");
    }
    const review = exceptions.filter(c => !exhausted.includes(c));
    if (review.length) {
      alert("quarantined_command", "critical", `${review.length} command(s) in exception (${exceptionClasses.join(", ")})`,
        "Inspect the quarantined command and its saved request in humanReview; repair credentials or configuration if that is the cause, then use the audited resume action with a reason.");
    }
    if (summary.commands.bankSettledLocalUnposted.count) {
      alert("bank_settled_local_posting_failed", "critical", `${summary.commands.bankSettledLocalUnposted.count} bank-settled payment(s) not posted locally`,
        "Reconcile evidence: repair the local invariant (for example reopen the period or fix the ledger), then let the evidence worker retry posting. Do not dispatch again.");
    }
    if (cancelled.length) {
      alert("released_payment_transfer_appeared", "critical", `${cancelled.length} released payment(s) later showed a bank transfer`,
        "Escalate as a possible duplicate payment: compare the late transfer with any replacement payment and recover funds with the provider. It is never posted automatically.");
    }
    if (unposted.length && summary.evidence.unpostedTransactions.oldestAgeMs! > SLO_TARGETS.unpostedTransactionMaxAgeMs) {
      alert("evidence_unposted", "warning", `${unposted.length} imported transaction(s) not posted`,
        "Reconcile evidence: inspect each transaction in humanView; unmatched activity stays a close blocker until explained.");
    }
    if (retries.length) {
      alert("evidence_fetch_retrying", quarantined.length ? "critical" : "warning", `${retries.length} bank transaction(s) could not be verified`,
        "Restore provider connectivity or wait out rate limits; the evidence worker retries with backoff and the rows stay close blockers. Inspect repeated failures in the provider dashboard.");
    }
    if (notices.length && summary.evidence.pendingNotices.oldestAgeMs! > SLO_TARGETS.pendingNoticeMaxAgeMs) {
      alert("notification_backlog", "warning", `${notices.length} verified notification(s) unprocessed`,
        "Confirm the evidence worker is passing; notifications are hints and polling still imports bank evidence.");
    }
    return {
      clock: "server_wall_clock" as const, now,
      scope: { organizationId: scope.organizationId, runId: scope.runId, provider: scope.provider, environment: scope.environment, accountId: scope.accountId },
      status: alerts.some(a => a.severity === "critical") ? "unhealthy" as const : alerts.length ? "degraded" as const : "healthy" as const,
      workers, ...summary, sloTargets: SLO_TARGETS, alerts,
    };
  },
});
