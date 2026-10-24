import { describe, expect, it } from "vitest";
import { workspace } from "../convex/bank";
import type { QueryCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { buildBankWorkspace, type BankWorkspace, type BankWorkspaceInput } from "../src/core/bank-workspace";
import { kernelHarness } from "./helpers/kernelHarness";

const RUN = "bank-test";
const input = (overrides: Partial<BankWorkspaceInput> = {}): BankWorkspaceInput => ({
  run: { runId: RUN, label: "Bank test", simDate: "2026-02-02" },
  balances: [], entries: [], events: [], tasks: [], payments: [], asks: [],
  ...overrides,
});
const event = (id: string, payload: unknown = {}, overrides: Partial<BankWorkspaceInput["events"][number]> = {}): BankWorkspaceInput["events"][number] => ({
  _id: id as Id<"events">, runId: RUN, type: "bank.transaction", recordedAt: 1,
  payload: { account: "operating", txnId: id, date: "2026-01-02", amountCents: -500, description: "ACH vendor payment", ...payload as object },
  ...overrides,
});
const entry = (id: string, overrides: Partial<BankWorkspaceInput["entries"][number]> = {}): BankWorkspaceInput["entries"][number] => ({
  _id: id as Id<"journalEntries">, runId: RUN, sequence: 1, date: "2026-01-02", memo: "Cash movement",
  source: { kind: "bank_match", ref: id }, lines: [{ account: "1000", debit: 0, credit: 500 }], status: "posted",
  ...overrides,
});
const task = (eventId: string, overrides: Partial<BankWorkspaceInput["tasks"][number]> = {}): BankWorkspaceInput["tasks"][number] => ({
  _id: `task-${eventId}` as Id<"tasks">, runId: RUN, type: "cash.match_bank_txn", payload: { eventId },
  status: "done", result: { outcome: "posted", summary: "Recorded in the ledger" }, updatedAt: 1,
  ...overrides,
});
const payment = (id: string, overrides: Partial<BankWorkspaceInput["payments"][number]> = {}): BankWorkspaceInput["payments"][number] => ({
  _id: id as Id<"paymentIntents">, runId: RUN, bankRef: "ACH-1", payee: "Produce vendor", amountCents: 500, status: "settled", ...overrides,
});

describe("bank workspace read model", () => {
  it("has an honest empty state, including for a missing run with orphan rows", () => {
    const empty = buildBankWorkspace(RUN, input());
    expect(empty.accounts).toHaveLength(3);
    expect(empty.accounts.map((account) => account.code)).toEqual(["1000", "1010", "1020"]);
    expect(empty.totals.bookBalanceCents).toBe(0);
    expect(empty.series).toEqual([]);
    expect(empty.transactions).toEqual([]);
    expect(empty.dataBasis.firstDate).toBeNull();
    expect(empty.dataBasis.label).toContain("book balances");
    const missing = buildBankWorkspace(RUN, input({ run: null, events: [event("orphan")], balances: [{ runId: RUN, account: "1000", debits: 100, credits: 0 }] }));
    expect(missing.run).toBeNull();
    expect(missing.totals.transactionCount).toBe(0);
    expect(missing.totals.bookBalanceCents).toBe(0);
  });

  it("sums all balance periods and derives an opening balance that reconciles signed movements and reversals", () => {
    const result = buildBankWorkspace(RUN, input({
      balances: [
        { runId: RUN, account: "1000", debits: 10_000, credits: 1_000 },
        { runId: RUN, account: "1000", debits: 0, credits: 2_000 },
        { runId: RUN, account: "1010", debits: 500, credits: 0 },
        { runId: RUN, account: "2000", debits: 999_999, credits: 0 },
      ],
      // Intentionally out of date/sequence order. The original must remain in
      // the arithmetic after reversal; omitting it would subtract cash twice.
      entries: [
        entry("debit", { date: "2026-01-03", lines: [{ account: "1000", debit: 0, credit: 1_000 }] }),
        entry("deposit", { date: "2026-01-02", lines: [{ account: "1000", debit: 2_000, credit: 0 }] }),
        entry("original", { date: "2026-01-04", status: "reversed", lines: [{ account: "1000", debit: 500, credit: 0 }] }),
        entry("reversal", { date: "2026-01-05", source: { kind: "reversal", ref: "3" }, reversalOf: "original" as Id<"journalEntries"> }),
      ],
    }));
    expect(result.totals).toMatchObject({ bookBalanceCents: 7_500, openingBalanceCents: 6_500, inflowCents: 2_500, outflowCents: 1_500 });
    expect(result.series.map((point) => [point.date, point.balanceCents])).toEqual([
      ["2026-01-02", 8_500], ["2026-01-03", 7_500], ["2026-01-04", 8_000], ["2026-01-05", 7_500],
    ]);
    expect(result.series.at(-1)?.accountBalances).toEqual({ operating: 7_000, payroll: 500, deposits: 0 });
    expect(result.series.at(-1)?.balanceCents).toBe(result.totals.bookBalanceCents);
  });

  it("distinguishes a posted bank line from a confirmed payment reconciliation", () => {
    const result = buildBankWorkspace(RUN, input({
      events: [event("matched", { bankRef: "ACH-1" }), event("recorded"), event("bad-match", { bankRef: "ACH-2" })],
      tasks: [task("matched", { result: { outcome: "reconciled" } }), task("recorded"), task("bad-match", { result: { outcome: "reconciled" } })],
      payments: [payment("payment-1"), payment("payment-2", { bankRef: "ACH-2", amountCents: 600 })],
      entries: [
        entry("settlement", { source: { kind: "payment_settlement", ref: "payment-1" } }),
        entry("posted", { source: { kind: "bank_match", ref: "recorded" } }),
      ],
    }));
    const rows = Object.fromEntries(result.transactions.map((row) => [row.txnId, row]));
    expect(rows.matched).toMatchObject({ status: "reconciled", amountCents: -500, payment: { id: "payment-1", payee: "Produce vendor", status: "settled" }, entries: [{ id: "settlement" }] });
    expect(rows.recorded).toMatchObject({ status: "recorded", taskOutcome: "posted", payment: null });
    expect(rows["bad-match"]?.status).toBe("needs_review");
    expect(result.totals).toMatchObject({ reconciledCount: 1, recordedCount: 1, needsReviewCount: 1 });
  });

  it("keeps reversed matches reviewable and includes their reversing entries", () => {
    const result = buildBankWorkspace(RUN, input({
      events: [event("feed")], tasks: [task("feed")],
      entries: [
        entry("original", { source: { kind: "bank_match", ref: "feed" }, status: "reversed" }),
        entry("reversal", { sequence: 2, source: { kind: "reversal", ref: "1" }, reversalOf: "original" as Id<"journalEntries">, lines: [{ account: "1000", debit: 500, credit: 0 }] }),
      ],
    }));
    expect(result.transactions[0]?.status).toBe("needs_review");
    expect(result.transactions[0]?.entries.map((item) => item.id)).toEqual(["original", "reversal"]);
    expect(result.series.at(-1)?.balanceCents).toBe(0);
  });

  it("retains workflow states and links asks with their recipient without treating an answer as reconciliation", () => {
    const ids = ["queued", "leased", "failed", "waiting", "flagged", "posted-flagged", "mismatch", "retry", "ignored", "ask"];
    const result = buildBankWorkspace(RUN, input({
      events: ids.map((id) => event(id)),
      tasks: ids.map((id) => task(id, ["queued", "leased", "failed", "waiting"].includes(id)
        ? { status: id as "queued" | "leased" | "failed" | "waiting" }
        : { result: { outcome: id === "posted-flagged" ? "posted_flagged" : id } })),
      asks: [
        { _id: "ask-open" as Id<"asks">, runId: RUN, taskId: "task-ask" as Id<"tasks">, title: "Confirm debit", severity: "urgent", status: "open", to: "human_cfo" },
        { _id: "ask-answered" as Id<"asks">, runId: RUN, taskId: "task-flagged" as Id<"tasks">, title: "Answered debit", severity: "urgent", status: "answered", to: "human_cfo" },
      ],
    }));
    expect(Object.fromEntries(result.transactions.map((row) => [row.txnId, row.status]))).toEqual({
      queued: "processing", leased: "processing", failed: "needs_review", waiting: "needs_review", flagged: "needs_review",
      "posted-flagged": "needs_review", mismatch: "needs_review", retry: "unmatched", ignored: "unmatched", ask: "needs_review",
    });
    expect(result.transactions.find((row) => row.txnId === "ask")?.asks[0]).toMatchObject({ id: "ask-open", to: "human_cfo", status: "open" });
    expect(result.transactions.find((row) => row.txnId === "flagged")?.asks[0]?.status).toBe("answered");
  });

  it("rejects malformed event payloads explicitly while preserving zero and negative integer cents", () => {
    const badPayloads = [null, [], "broken", {},
      { account: "unknown" }, { amountCents: "500" }, { amountCents: 1.25 }, { amountCents: NaN },
      { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { txnId: "" }, { date: "2026-02-30" }, { date: "2026-1-2" },
      { description: " " }, { bankRef: 123 },
    ];
    const events = badPayloads.map((payload, i) => [null, "broken"].includes(payload as null | string) || Array.isArray(payload) || i === 3
      ? event(`bad-${i}`, {}, { payload })
      : event(`bad-${i}`, payload));
    const result = buildBankWorkspace(RUN, input({ events: [...events, event("zero", { amountCents: 0 }), event("negative", { amountCents: -301 })] }));
    expect(result.dataBasis.invalidTransactionCount).toBe(badPayloads.length);
    expect(result.totals.transactionCount).toBe(2);
    expect(result.transactions.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([-301, 0]);
  });

  it("does not cross-link another run's cash, task results, payments, or asks", () => {
    const result = buildBankWorkspace(RUN, input({
      events: [event("shared-ref", { bankRef: "ACH-1" }), event("other-event", {}, { runId: "other" })],
      balances: [{ runId: "other", account: "1000", debits: 1_000_000, credits: 0 }],
      entries: [entry("other-entry", { runId: "other", source: { kind: "bank_match", ref: "shared-ref" } })],
      tasks: [task("shared-ref", { runId: "other", result: { outcome: "reconciled" } })],
      payments: [payment("other-payment", { runId: "other" })],
      asks: [{ _id: "other-ask" as Id<"asks">, runId: "other", taskId: "task-shared-ref" as Id<"tasks">, title: "Other run", status: "open", severity: "urgent", to: "human_cfo" }],
    }));
    expect(result.totals.bookBalanceCents).toBe(0);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ status: "unmatched", entries: [], asks: [], payment: null, taskId: null });
  });
});

describe("bank.workspace query", () => {
  it("reads the full run beyond an activity window, scopes every collection, and performs no writes", async () => {
    const harness = kernelHarness();
    const { runId } = await harness.setup();
    for (let index = 0; index < 75; index += 1) {
      await harness.seed("events", { runId, type: "bank.transaction", externalId: `bank-${index}`, occurredOn: "2026-01-02", recordedAt: index,
        payload: { account: "deposits", txnId: `bank-${index}`, date: "2026-01-02", amountCents: 100, description: "Card settlement" } });
    }
    await harness.seed("events", { runId: "other", type: "bank.transaction", externalId: "other", occurredOn: "2026-01-02", recordedAt: 999,
      payload: { account: "operating", txnId: "other", date: "2026-01-02", amountCents: 999_999, description: "Other run" } });
    await harness.seed("events", { runId, type: "sales.daily", externalId: "sales", occurredOn: "2026-01-02", recordedAt: 999, payload: {} });
    await harness.seed("balances", { runId, account: "1020", period: "2026-01", debits: 7_500, credits: 0 });
    await harness.seed("balances", { runId: "other", account: "1020", period: "2026-01", debits: 999_999, credits: 0 });
    const before = { events: harness.all("events"), balances: harness.all("balances") };
    // Convex retains _handler at runtime but omits it from public types.
    const query = (workspace as unknown as { _handler: (ctx: QueryCtx, args: { runId: string }) => Promise<BankWorkspace> })._handler;
    const result = await query(harness.ctx, { runId });
    expect(result.totals.transactionCount).toBe(75);
    expect(result.accounts.find((account) => account.key === "deposits")).toMatchObject({ bookBalanceCents: 7_500, openingBalanceCents: 7_500 });
    expect(result.transactions.every((row) => row.description === "Card settlement")).toBe(true);
    expect(result.dataBasis.invalidTransactionCount).toBe(0);
    expect({ events: harness.all("events"), balances: harness.all("balances") }).toEqual(before);
    expect(harness.all("journalEntries")).toEqual([]);
    expect(harness.all("tasks")).toEqual([]);
  });
});
