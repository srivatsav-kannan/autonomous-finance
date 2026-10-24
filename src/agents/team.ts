import fs from "node:fs";
import path from "node:path";
import { api, convex, hashToken, newToken } from "../core/kernel-client";
import type { Role } from "../core/roles";
import { MemoryStore } from "../memory/store";
import { WorldBank } from "../world/bank";
import { memoryDir, runDir } from "../world/scenario";
import { LlmRefused, LlmUnavailable, MODEL } from "./llm";
import { SeatRuntime, type Handler, type Task } from "./runtime";
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
  processed = 0;

  constructor(readonly runId: string, private readonly opts: { log?: (s: string) => void } = {}) {
    this.mem = new MemoryStore(memoryDir(runId));
    this.bank = new WorldBank(runId);
    this.tokensFile = path.join(runDir(runId), "seats.json");
    this.tokens = JSON.parse(fs.readFileSync(this.tokensFile, "utf8"));
  }

  private log(s: string) {
    this.opts.log?.(s);
  }

  async refreshSeats(): Promise<void> {
    const seats = await convex().query(api.seats.list, { runId: this.runId });
    for (const s of seats) {
      if (s.kind !== "agent") continue;
      if (s.status !== "active") {
        this.runtimes.delete(s.seatId);
        continue;
      }
      if (this.runtimes.has(s.seatId) || !this.tokens[s.seatId]) continue;
      this.runtimes.set(s.seatId, new SeatRuntime(this.runId, { seatId: s.seatId, role: s.role as Role, name: s.name, effort: s.effort }, this.tokens[s.seatId]!, this.mem, this.bank));
    }
  }

  /** Process one task for a seat. Returns false when the seat had nothing to do. */
  async step(rt: SeatRuntime): Promise<boolean> {
    const claim = await rt.kernel.client.mutation(api.tasks.claimTask, rt.kernel.auth);
    if (!claim.ok) throw new Error(`claim failed for ${rt.seat.seatId}: ${claim.error}`);
    const task = claim.task as Task | null;
    if (!task) return false;
    const handler = HANDLERS[task.type];
    const before = { ...rt.usage };
    const started = Date.now();
    let outcome = "error";
    let summary: string | undefined;
    try {
      if (!handler) throw new Error(`no handler for ${task.type}`);
      const res = await handler(rt, task);
      outcome = res.outcome;
      summary = res.summary;
      if (res.waiting) {
        await rt.kernel.client.mutation(api.tasks.waitTask, { ...rt.kernel.auth, taskId: task._id, reason: res.summary ?? "waiting" });
      } else if (res.outcome === "retry") {
        await rt.kernel.client.mutation(api.tasks.failTask, { ...rt.kernel.auth, taskId: task._id, error: res.summary ?? "retry", retryInMs: 500 });
      } else {
        await rt.kernel.client.mutation(api.tasks.completeTask, { ...rt.kernel.auth, taskId: task._id, result: { outcome, summary } });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary = msg.slice(0, 300);
      const retry = !(e instanceof LlmUnavailable || e instanceof LlmRefused);
      await rt.kernel.client.mutation(api.tasks.failTask, { ...rt.kernel.auth, taskId: task._id, error: summary, retryInMs: retry ? 1000 : undefined });
      this.log(`! ${rt.seat.seatId} ${task.type}: ${summary}`);
    }
    const llmTurns = rt.usage.turns - before.turns;
    await rt.kernel.client.mutation(api.observe.logRun, {
      ...rt.kernel.auth,
      taskId: task._id,
      kind: llmTurns > 0 ? "llm" : "deterministic",
      model: llmTurns > 0 ? MODEL : undefined,
      inputTokens: rt.usage.inputTokens - before.inputTokens,
      outputTokens: rt.usage.outputTokens - before.outputTokens,
      cacheReadTokens: rt.usage.cacheReadTokens - before.cacheReadTokens,
      costMicros: rt.usage.costMicros - before.costMicros,
      latencyMs: Date.now() - started,
      toolCalls: rt.usage.toolCalls - before.toolCalls,
      outcome,
      summary,
    });
    this.processed++;
    this.log(`  ${rt.seat.seatId.padEnd(14)} ${task.type.padEnd(24)} ${outcome.padEnd(14)} ${summary ?? ""}`);
    return true;
  }

  /** CFO agent staffing: spawn seats when a queue backs up, retire spawned ones when idle. */
  async staff(): Promise<void> {
    const cfo = this.runtimes.get("cfo-agent");
    if (!cfo) return;
    const stats = await convex().query(api.tasks.queueStats, { runId: this.runId });
    for (const [role, rule] of Object.entries(STAFFABLE) as [Role, { max: number; spawnAt: number }][]) {
      const queued = stats[role]?.queued ?? 0;
      const seats = [...this.runtimes.values()].filter((r) => r.seat.role === role);
      if (queued >= rule.spawnAt * seats.length && seats.length < rule.max) {
        const n = seats.length + 1;
        const seatId = `${role.replace("_", "-")}-${n}`;
        if (this.tokens[seatId]) continue;
        const token = newToken();
        const name = role === "ap_clerk" ? `AP Clerk ${n}` : `Cash Application Agent ${n}`;
        const r = await cfo.kernel.client.mutation(api.seats.spawnSeat, {
          ...cfo.kernel.auth, newSeatId: seatId, role, name, tokenHash: hashToken(token), reportsTo: "controller", effort: "medium",
          reason: `${queued} ${role} tasks queued for ${seats.length} seat(s)`,
        });
        if (!r.ok) continue;
        this.tokens[seatId] = token;
        fs.writeFileSync(this.tokensFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
        this.log(`+ cfo-agent spawned ${seatId} (${queued} queued)`);
      }
    }
    await this.refreshSeats();
  }

  /** Run every seat until all queues are empty (eval/drain mode) or `stop()` is called. */
  async runUntilIdle(opts: { idleRounds?: number } = {}): Promise<void> {
    await this.refreshSeats();
    let idle = 0;
    while (!this.stopped && idle < (opts.idleRounds ?? 2)) {
      await this.staff();
      const results = await Promise.all([...this.runtimes.values()].map(async (rt) => {
        let did = false;
        // Each seat drains a few tasks per round so busy roles don't starve the others.
        for (let i = 0; i < 4; i++) {
          if (!(await this.step(rt))) break;
          did = true;
        }
        return did;
      }));
      idle = results.some(Boolean) ? 0 : idle + 1;
    }
  }

  /** Long-running mode: keep polling for work. */
  async runForever(pollMs = 750): Promise<void> {
    await this.refreshSeats();
    while (!this.stopped) {
      await this.runUntilIdle({ idleRounds: 1 });
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  stop() {
    this.stopped = true;
  }
}
