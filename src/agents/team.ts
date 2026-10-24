import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { api, convex, hashToken, newToken } from "../core/kernel-client";
import type { Role } from "../core/roles";
import { MemoryStore } from "../memory/store";
import { WorldBank } from "../world/bank";
import { memoryDir, runDir } from "../world/scenario";
import { LlmRefused, LlmUnavailable, MODEL } from "./llm";
import { SeatRuntime, type Handler, type Task } from "./runtime";
import { checkWorkerResult, ControlPlane, ControlPlaneUnavailable, OperatorActionRequired, pause, reportDiagnostic, workerFetch, WorkerHttpError, transientFailure, WorkerStopped, type Diagnostic, type RetryOptions } from "./control-plane";
import { TaskLeaseLost, withTaskLease } from "./task-lease";
import { processDocument } from "./handlers/ap";
import { approvePayment, reviewHeld, reviewProposal } from "./handlers/controller";
import { paymentRun, remitChange, secondApproval } from "./handlers/payments";
import { matchBankTxn, reconcilePayout } from "./handlers/cash";
import { postDailyRevenue, processLeaseInvoice, processPayroll } from "./handlers/books";
import { buildParser } from "./handlers/integrations";
import { auditReview, dailyDigest, runClose } from "./handlers/oversight";

export const HANDLERS: Record<string, Handler> = {
  "ap.process_document": processDocument,
  "ap.review_held": reviewHeld,
  "payments.approve": approvePayment,
  "payments.second_approval": secondApproval,
  "payments.run": paymentRun,
  "vendor.remit_change": remitChange,
  "memory.review_proposal": reviewProposal,
  "cash.match_bank_txn": matchBankTxn,
  "cash.reconcile_payout": reconcilePayout,
  "revenue.post_daily": postDailyRevenue,
  "payroll.process": processPayroll,
  "lease.process_invoice": processLeaseInvoice,
  "integrations.build_parser": buildParser,
  "cfo.daily_digest": dailyDigest,
  "close.run": runClose,
  "audit.review": auditReview,
};

const STAFFABLE: Partial<Record<Role, { max: number; spawnAt: number }>> = {
  ap_clerk: { max: 4, spawnAt: 12 },
  cash_application: { max: 2, spawnAt: 20 },
};

export class DrainIncomplete extends Error {
  constructor(readonly reason: "timed_out" | "stopped" | "unstaffed", readonly pending?: number) {
    super(`team drain incomplete: ${reason}${pending === undefined ? "" : ` (${pending} pending tasks)`}`);
  }
}

interface TeamOptions {
  log?: (s: string) => void;
  diagnostic?: (event: Diagnostic) => void;
  retry?: RetryOptions;
}

/**
 * The whole agent team for one run. Each seat runs its own claim -> handle -> complete loop.
 * The CFO agent watches queues and staffs up (and down) within policy, through the kernel.
 */
export class Team {
  readonly runtimes = new Map<string, SeatRuntime>();
  readonly mem: MemoryStore;
  readonly bank: WorldBank;
  private tokensFile: string;
  private tokens: Record<string, string>;
  private stopped = false;
  private readonly scheduling = new AbortController();
  private readonly control: ControlPlane;
  private readonly report: (event: Diagnostic) => void;
  processed = 0;

  constructor(readonly runId: string, private readonly opts: TeamOptions = {}) {
    this.report = opts.diagnostic ?? reportDiagnostic;
    this.control = new ControlPlane(this.report, opts.retry);
    this.mem = new MemoryStore(memoryDir(runId));
    this.bank = new WorldBank(runId);
    this.tokensFile = path.join(runDir(runId), "seats.json");
    this.tokens = JSON.parse(fs.readFileSync(this.tokensFile, "utf8"));
  }

  private log(s: string) {
    this.opts.log?.(s);
  }

  async refreshSeats(): Promise<void> {
    const seats = await this.control.call("seats.list", () => convex({ fetch: workerFetch }).query(api.seats.list, { runId: this.runId }), this.scheduling.signal);
    for (const s of seats) {
      if (s.kind !== "agent") continue;
      if (s.status !== "active") {
        this.runtimes.delete(s.seatId);
        continue;
      }
      if (this.runtimes.has(s.seatId) || !this.tokens[s.seatId]) continue;
      this.runtimes.set(s.seatId, new SeatRuntime(this.runId, { seatId: s.seatId, role: s.role as Role, name: s.name, effort: s.effort }, this.tokens[s.seatId]!, this.mem, this.bank, convex({ fetch: workerFetch })));
    }
  }

  /** Retry only queue RPCs, never the business handler or a different transition. */
  private async transition(rt: SeatRuntime, operation: string, work: () => Promise<{ ok: boolean; code?: string }>) {
    const result = await this.control.call(`${operation}:${rt.seat.seatId}`, work);
    checkWorkerResult(result, operation);
    if (!result.ok) throw new TaskLeaseLost(`${operation}: lease rejected`);
  }

  /** Process one task for a seat. Returns false when the seat had nothing to do. */
  async step(rt: SeatRuntime): Promise<boolean> {
    if (this.stopped) return false;
    const claimArgs = { ...rt.kernel.auth, requestId: randomUUID() };
    const claim = await this.control.call(`tasks.claimTask:${rt.seat.seatId}`,
      () => rt.kernel.client.mutation(api.tasks.claimTask, claimArgs), this.scheduling.signal);
    checkWorkerResult(claim, "tasks.claimTask");
    if (!claim.ok) throw new OperatorActionRequired("claim rejected");
    const task = claim.task as Task | null;
    // A claim already in flight at shutdown may commit; leave it for lease recovery.
    if (!task || this.stopped) return false;
    if ((task.leaseExpiresAt ?? 0) <= Date.now()) return false;
    const handler = HANDLERS[task.type];
    if (!handler) throw new OperatorActionRequired(`no handler for task type ${task.type}`);
    const lease = { ...rt.kernel.auth, taskId: task._id, leaseAttempt: task.attempts };
    const before = { ...rt.usage };
    const started = Date.now();
    let outcome = "error";
    let summary: string | undefined;
    let result: Awaited<ReturnType<Handler>> | undefined;
    let handlerError: unknown;
    try {
      result = await withTaskLease(async () => {
        const renewal = await this.control.call(`tasks.heartbeatTask:${rt.seat.seatId}`,
          () => rt.kernel.client.mutation(api.tasks.heartbeatTask, lease));
        checkWorkerResult(renewal, "tasks.heartbeatTask");
        return renewal;
      }, () => handler(rt, task));
    } catch (error) {
      if (error instanceof TaskLeaseLost && error.cause instanceof OperatorActionRequired) throw error.cause;
      if (error instanceof OperatorActionRequired || (error instanceof WorkerHttpError && !transientFailure(error))) {
        throw new OperatorActionRequired("handler RPC rejected; check credentials and deployment");
      }
      handlerError = error;
    }
    const requestId = randomUUID();
    try {
      if (handlerError instanceof TaskLeaseLost) throw handlerError;
      if (result) {
        outcome = result.outcome;
        summary = result.summary;
        if (result.waiting) {
          await this.transition(rt, "tasks.waitTask", () => rt.kernel.client.mutation(api.tasks.waitTask, { ...lease, requestId, reason: summary ?? "waiting" }));
        } else if (outcome === "retry") {
          await this.transition(rt, "tasks.failTask", () => rt.kernel.client.mutation(api.tasks.failTask, { ...lease, requestId, error: summary ?? "retry", retryInMs: 500 }));
        } else {
          await this.transition(rt, "tasks.completeTask", () => rt.kernel.client.mutation(api.tasks.completeTask, { ...lease, requestId, result: { outcome, summary } }));
        }
      } else {
        // Keep transport diagnostics free of raw exception bodies (which may echo auth args).
        summary = handlerError instanceof LlmUnavailable ? "LLM unavailable" : handlerError instanceof LlmRefused ? "LLM refused" : "handler failed";
        const retry = !(handlerError instanceof LlmUnavailable || handlerError instanceof LlmRefused);
        await this.transition(rt, "tasks.failTask", () => rt.kernel.client.mutation(api.tasks.failTask, { ...lease, requestId, error: summary!, retryInMs: retry ? 1000 : undefined }));
      }
    } catch (error) {
      // An ambiguous completion/failure is never converted into a different transition.
      if (!(error instanceof TaskLeaseLost)) throw error;
      outcome = "lease_lost";
      summary = "task lease lost; recovery belongs to the current lease owner";
    }
    this.processed++;
    const llmTurns = rt.usage.turns - before.turns;
    const telemetry = {
      ...rt.kernel.auth, requestId: randomUUID(), taskId: task._id,
      kind: llmTurns > 0 ? "llm" : "deterministic",
      model: llmTurns > 0 ? MODEL : undefined,
      inputTokens: rt.usage.inputTokens - before.inputTokens,
      outputTokens: rt.usage.outputTokens - before.outputTokens,
      cacheReadTokens: rt.usage.cacheReadTokens - before.cacheReadTokens,
      costMicros: rt.usage.costMicros - before.costMicros,
      latencyMs: Date.now() - started,
      toolCalls: rt.usage.toolCalls - before.toolCalls,
      outcome, summary,
    };
    try {
      const logged = await this.control.call(`observe.logRun:${rt.seat.seatId}`,
        () => rt.kernel.client.mutation(api.observe.logRun, telemetry));
      checkWorkerResult(logged, "observe.logRun");
    } catch (error) {
      // Retain a credential-free diagnostic on stderr even when remote observability is down.
      const { token: _token, summary: _summary, ...diagnostic } = telemetry;
      this.report({ event: "telemetry_fallback", ...diagnostic });
      if (!(error instanceof ControlPlaneUnavailable)) throw error;
    }
    this.log(`  ${rt.seat.seatId.padEnd(14)} ${task.type.padEnd(24)} ${outcome.padEnd(14)} ${summary ?? ""}`);
    return true;
  }

  /** CFO agent staffing: spawn seats when a queue backs up, retire spawned ones when idle. */
  async staff(): Promise<void> {
    const cfo = this.runtimes.get("cfo-agent");
    if (!cfo) return;
    const stats = await this.control.call("tasks.queueStats", () => convex({ fetch: workerFetch }).query(api.tasks.queueStats, { runId: this.runId }), this.scheduling.signal);
    for (const [role, rule] of Object.entries(STAFFABLE) as [Role, { max: number; spawnAt: number }][]) {
      const queued = stats[role]?.queued ?? 0;
      const seats = [...this.runtimes.values()].filter((r) => r.seat.role === role);
      if (queued >= rule.spawnAt * seats.length && seats.length < rule.max) {
        const n = seats.length + 1;
        const seatId = `${role.replace("_", "-")}-${n}`;
        if (this.stopped) return;
        const token = this.tokens[seatId] ?? newToken();
        // Save before sending: a lost spawn response must retain the same credential.
        this.tokens[seatId] = token;
        fs.writeFileSync(this.tokensFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
        const name = role === "ap_clerk" ? `AP Clerk ${n}` : `Cash Application Agent ${n}`;
        const r = await this.control.call("seats.spawnSeat", () => cfo.kernel.client.mutation(api.seats.spawnSeat, {
          ...cfo.kernel.auth, requestId: `spawn:${seatId}:${hashToken(token)}`, newSeatId: seatId, role, name, tokenHash: hashToken(token), reportsTo: "controller", effort: "medium",
          reason: `Automatic staffing for ${role}`,
        }), this.scheduling.signal);
        checkWorkerResult(r, "seats.spawnSeat");
        if (!r.ok) continue;
        this.log(`+ cfo-agent spawned ${seatId} (${queued} queued)`);
      }
    }
    await this.refreshSeats();
  }

  /** A transport outage in one seat must not prevent other seats from making progress. */
  private async round(): Promise<{ didWork: boolean; healthy: boolean }> {
    let healthy = true;
    const recover = async (work: () => Promise<unknown>) => {
      try { await work(); }
      catch (error) {
        if (error instanceof ControlPlaneUnavailable || error instanceof WorkerStopped) healthy = false;
        else { this.stop(); throw error; }
      }
    };
    await recover(() => this.refreshSeats());
    if (this.stopped) return { didWork: false, healthy: false };
    await recover(() => this.staff());
    let didWork = false;
    await Promise.all([...this.runtimes.values()].map((rt) => recover(async () => {
      for (let i = 0; i < 4 && !this.stopped; i++) {
        if (!(await this.step(rt))) break;
        didWork = true;
      }
    })));
    return { didWork, healthy };
  }

  /** Resolves only when no executable work remains. Incomplete drains reject, including in evals. */
  async runUntilIdle(opts: { idleRounds?: number; timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("drain timeoutMs must be positive and finite");
    if (!Number.isInteger(opts.idleRounds ?? 2) || (opts.idleRounds ?? 2) <= 0) throw new Error("idleRounds must be a positive integer");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.drain(opts.idleRounds ?? 2),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { this.stop(); reject(new DrainIncomplete("timed_out")); }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async drain(idleRounds: number): Promise<void> {
    let idle = 0;
    while (!this.stopped) {
      const round = await this.round();
      if (this.stopped) break;
      if (!round.healthy) {
        idle = 0;
        await pause(250, this.scheduling.signal).catch(() => {});
        continue;
      }
      if (round.didWork) { idle = 0; continue; }
      try {
        const state = await this.control.call("tasks.drainState", () => convex({ fetch: workerFetch }).query(api.tasks.drainState, {
          runId: this.runId, roles: [...new Set([...this.runtimes.values()].map((rt) => rt.seat.role))],
        }), this.scheduling.signal);
        if (this.stopped) break;
        if (state.unstaffed) throw new DrainIncomplete("unstaffed", state.pending);
        if (!state.pending) {
          if (++idle >= idleRounds) return;
        } else idle = 0;
        // Recheck for earlier/new work and renewed leases at least once per second.
        await pause(Math.max(10, Math.min(1000, (state.nextDueAt ?? Date.now()) - Date.now())), this.scheduling.signal);
      } catch (error) {
        if (error instanceof WorkerStopped) break;
        if (!(error instanceof ControlPlaneUnavailable)) throw error;
        idle = 0;
        await pause(250, this.scheduling.signal).catch(() => {});
      }
    }
    throw new DrainIncomplete("stopped");
  }

  /** Long-running mode has bounded per-call recovery, but no drain deadline. */
  async runForever(pollMs = 750): Promise<void> {
    while (!this.stopped) {
      await this.round();
      if (!this.stopped) await pause(pollMs, this.scheduling.signal).catch(() => {});
    }
  }

  stop() {
    this.stopped = true;
    this.scheduling.abort();
  }
}
