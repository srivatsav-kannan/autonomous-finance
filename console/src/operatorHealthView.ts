import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";

/** Presentation rules for demoOps.operatorHealth. Pure, so they are unit tested. */
export type OperatorHealth = FunctionReturnType<typeof api.demoOps.operatorHealth>;
type Targets = OperatorHealth["sloTargets"];
type Worker = OperatorHealth["workers"]["dispatcher"];
/** `overTarget` is null when no target applies (informational signals, or a worker that has not reported). */
export type HealthSignal = { group: string; label: string; observed: string; target: string; overTarget: boolean | null };

export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "never";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const minutes = (ms: number) => formatAge(ms);
const count = (row: { count: number; capped?: boolean }) => row.capped ? `${row.count}+` : String(row.count);
const withOldest = (row: { count: number; capped?: boolean }, oldestMs: number | null, word = "oldest") =>
  row.count ? `${count(row)} · ${word} ${formatAge(oldestMs)}` : "0";
const over = (ms: number | null, limit: number) => ms !== null && ms > limit;

function workerSignals(name: string, view: Worker, t: Targets): HealthSignal[] {
  const group = `${name} worker`;
  if (!view) return [{ group, label: "Last pass", observed: "No pass recorded for this run", target: `within ${minutes(t.workerPassMaxAgeMs)}`, overTarget: null }];
  return [
    { group, label: "Last pass", observed: `${formatAge(view.lastPassAgeMs)} ago (${view.lastOutcome}${view.lastErrorClass ? `, ${view.lastErrorClass}` : ""})`,
      target: `within ${minutes(t.workerPassMaxAgeMs)}`, overTarget: over(view.lastPassAgeMs, t.workerPassMaxAgeMs) },
    { group, label: "Last successful pass", observed: view.lastSuccessAgeMs === null ? "never" : `${formatAge(view.lastSuccessAgeMs)} ago`, target: "—", overTarget: null },
    { group, label: "Consecutive failed passes", observed: String(view.consecutiveFailures),
      target: `fewer than ${t.consecutiveFailedPasses}`, overTarget: view.consecutiveFailures >= t.consecutiveFailedPasses },
  ];
}

/** Every signal #56 asks for, next to its proposed target. `overTarget` mirrors the backend alert rules. */
export function healthSignals(h: OperatorHealth): HealthSignal[] {
  const t = h.sloTargets, c = h.commands, e = h.evidence;
  return [
    ...workerSignals("Dispatcher", h.workers.dispatcher, t),
    ...workerSignals("Evidence", h.workers.evidence, t),
    { group: "Payments", label: "Eligible commands waiting", observed: withOldest(c.eligible, c.eligible.oldestWaitMs, "oldest waiting"),
      target: `claimed within ${minutes(t.eligibleCommandMaxWaitMs)}`, overTarget: over(c.eligible.oldestWaitMs, t.eligibleCommandMaxWaitMs) },
    { group: "Payments", label: "Attempted, no confirmed bank transfer", observed: withOldest(c.unknownOutcome, c.unknownOutcome.oldestAgeMs),
      target: `resolved within ${minutes(t.unknownOutcomeMaxAgeMs)}`, overTarget: over(c.unknownOutcome.oldestAgeMs, t.unknownOutcomeMaxAgeMs) },
    { group: "Payments", label: "Automatic recovery exhausted", observed: count(c.retryExhausted), target: "0", overTarget: c.retryExhausted.count > 0 },
    { group: "Payments", label: "Commands in exception", observed: c.exceptions.count ? `${count(c.exceptions)} (${c.exceptions.errorClasses.join(", ")})` : "0",
      target: "0", overTarget: c.exceptions.count > 0 },
    { group: "Payments", label: "Bank settled, not posted locally", observed: String(c.bankSettledLocalUnposted.count), target: "0", overTarget: c.bankSettledLocalUnposted.count > 0 },
    { group: "Payments", label: "Released payments with a late transfer", observed: String(c.lateTransfersAfterRelease.count), target: "0", overTarget: c.lateTransfersAfterRelease.count > 0 },
    { group: "Bank evidence", label: "Imported, not posted", observed: withOldest(e.unpostedTransactions, e.unpostedTransactions.oldestAgeMs),
      target: `posted within ${minutes(t.unpostedTransactionMaxAgeMs)}`, overTarget: over(e.unpostedTransactions.oldestAgeMs, t.unpostedTransactionMaxAgeMs) },
    { group: "Bank evidence", label: "Transactions awaiting verification", observed: e.fetchRetries.count ? `${count(e.fetchRetries)} · ${e.fetchRetries.quarantined} quarantined` : "0",
      target: `quarantined after ${t.quarantineAfterFetchAttempts} failed fetches`, overTarget: e.fetchRetries.quarantined > 0 },
    { group: "Bank evidence", label: "Unprocessed notifications", observed: withOldest(e.pendingNotices, e.pendingNotices.oldestAgeMs),
      target: `processed within ${minutes(t.pendingNoticeMaxAgeMs)}`, overTarget: over(e.pendingNotices.oldestAgeMs, t.pendingNoticeMaxAgeMs) },
    { group: "Bank evidence", label: "Polling cursor", observed: e.cursor
        ? `last import ${formatAge(e.cursor.lastImportAgeMs)} ago · last full scan ${e.cursor.scanCompletedAgeMs === null ? "not completed" : `${formatAge(e.cursor.scanCompletedAgeMs)} ago`}`
        : "No polling pass yet", target: "—", overTarget: null },
  ];
}

export const statusLabel = (status: OperatorHealth["status"]) =>
  status === "healthy" ? "Healthy" : status === "degraded" ? "Degraded" : "Unhealthy";
