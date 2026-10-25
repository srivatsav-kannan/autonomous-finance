// Path 1: the agent-native kernel. Every bookkeeping operation is one typed call to the
// real Convex mutation handlers (convex/ap.ts, convex/ledger.ts), executed in process
// against the test harness DB double, so it runs without a live backend.
import type { MutationCtx, QueryCtx } from "../../../convex/_generated/server";
import { createRun, ingestEvent } from "../../../convex/admin";
import { recordBill, resolveHeldBill } from "../../../convex/ap";
import { sha256Hex } from "../../../convex/lib/kernel";
import { postEntry, trialBalance, verifyChain } from "../../../convex/ledger";
import { kernelHarness, mutationHandler } from "../../../tests/helpers/kernelHarness";
import type { WorldEvent } from "../../world/generate";
import { SEATS, type Op, type SeatId } from "./world-ops";

type KernelResult = { ok: boolean; code?: string; error?: string; replayed?: boolean; [k: string]: unknown };

function queryHandler<A, R>(q: unknown) {
  return (q as { _handler: (ctx: QueryCtx, args: A) => Promise<R> })._handler;
}

export const RUN_ID = "bench-spreadsheet-vs-kernel";

export class KernelBooks {
  readonly h = kernelHarness();
  readonly eventIds = new Map<string, string>();
  readonly billIds = new Map<string, string>();
  readonly tokens = new Map<SeatId, string>();
  readonly #secret: string;
  calls = 0;

  private constructor(secret: string) { this.#secret = secret; }

  /** A fresh run: real createRun, the six seats the stream uses, Jan/Feb open and Dec 2025 closed. */
  static async create(): Promise<KernelBooks> {
    // requireAdmin reads the deployment secret from the environment; this is a local, in-process value.
    const secret = (process.env.KERNEL_ADMIN_SECRET ||= "bench-local-admin-secret");
    const k = new KernelBooks(secret);
    const seats = [];
    for (const [seatId, role] of Object.entries(SEATS) as [SeatId, string][]) {
      const token = `bench-token-${seatId}`;
      k.tokens.set(seatId, token);
      seats.push({ seatId, role, name: seatId, kind: "agent" as const, tokenHash: await sha256Hex(token) });
    }
    const r = await mutationHandler(createRun)(k.ctx, {
      secret, runId: RUN_ID, label: "spreadsheet vs kernel", company: "sweetgreen", simDate: "2026-01-01", seats, periods: ["2025-12", "2026-01", "2026-02"],
    });
    if (!r.ok) throw new Error(`createRun failed: ${JSON.stringify(r)}`);
    const dec = k.h.all("periods").find((p) => p.period === "2025-12")!;
    await k.ctx.db.patch(dec._id, { status: "closed" });
    return k;
  }

  get ctx(): MutationCtx { return this.h.ctx; }
  #auth(seat: SeatId) { return { runId: RUN_ID, seatId: seat, token: this.tokens.get(seat)! }; }

  /** The world's door into the company (admin.ingestEvent), not an agent action. */
  async ingest(e: WorldEvent): Promise<void> {
    const r = await mutationHandler(ingestEvent)(this.ctx, { secret: this.#secret, runId: RUN_ID, type: e.type, externalId: e.externalId, occurredOn: e.occurredOn, payload: e.payload });
    if (!r.ok) throw new Error(`ingest failed: ${JSON.stringify(r)}`);
    this.eventIds.set(e.externalId, r.eventId);
  }

  /** One agent operation = one typed kernel call. */
  async apply(op: Op): Promise<KernelResult> {
    this.calls++;
    switch (op.kind) {
      case "record_bill": {
        const r = await mutationHandler(recordBill)(this.ctx, {
          ...this.#auth(op.seat), idempotencyKey: op.key, vendor: op.vendor, invoiceNumber: op.invoiceNumber, invoiceDate: op.invoiceDate,
          dueDate: op.dueDate, ...(op.store ? { store: op.store } : {}), ...(op.deliveryId ? { deliveryId: op.deliveryId } : {}),
          lines: op.lines, totalCents: op.totalCents, documentEventId: this.eventIds.get(op.documentExternalId) ?? op.documentExternalId,
          decision: op.decision, exceptions: op.exceptions, expenseAccount: op.expenseAccount,
        });
        if (r.ok) this.billIds.set(op.documentExternalId, r.billId);
        return r as KernelResult;
      }
      case "resolve_bill": {
        const billId = this.billIds.get(op.documentExternalId);
        if (!billId) return { ok: false, code: "not_found", error: `no bill for ${op.documentExternalId}` };
        return await mutationHandler(resolveHeldBill)(this.ctx, {
          ...this.#auth(op.seat), idempotencyKey: op.key, billId: billId as never, decision: op.decision, expenseAccount: op.expenseAccount, note: "benchmark resolution",
        }) as KernelResult;
      }
      case "post_entry":
        return await mutationHandler(postEntry)(this.ctx, { ...this.#auth(op.seat), idempotencyKey: op.key, date: op.date, memo: op.memo, source: op.source, lines: op.lines }) as KernelResult;
      case "match_bank":
        return await mutationHandler(postEntry)(this.ctx, {
          ...this.#auth(op.seat), idempotencyKey: op.key, date: op.date, memo: op.memo, source: { kind: "bank_match", ref: op.txnId }, lines: op.lines,
        }) as KernelResult;
    }
  }

  async trialBalance(): Promise<{ code: string; debits: number; credits: number; net: number }[]> {
    return await queryHandler<{ runId: string }, { code: string; debits: number; credits: number; net: number }[]>(trialBalance)(this.ctx, { runId: RUN_ID });
  }

  async verifyChain(): Promise<{ ok: boolean; brokenAt?: number }> {
    return await queryHandler<{ runId: string }, { ok: boolean; brokenAt?: number }>(verifyChain)(this.ctx, { runId: RUN_ID });
  }

  /** Counts of rows a bad operation could have changed. */
  footprint() {
    const entries = this.h.all("journalEntries");
    return {
      entries: entries.length,
      bills: this.h.all("bills").length,
      approvedBills: this.h.all("bills").filter((b) => b.status === "approved").length,
      balances: JSON.stringify(this.h.all("balances").map((b) => [b.account, b.period, b.debits, b.credits])),
      violations: this.h.all("violations").length,
    };
  }
}
