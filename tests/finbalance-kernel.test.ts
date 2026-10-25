import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { RegisteredQuery } from "convex/server";
import { bookFinBalance } from "../src/evals/external/adapters";
import type { BenchmarkTask, Trace } from "../src/evals/external/types";
import type { QueryCtx } from "../convex/_generated/server";
import { postEntry, trialBalance, verifyChain } from "../convex/ledger";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";
import { bookedAnswer, bookThroughKernel, KernelMappingError, type KernelLedger, type PublicContext } from "../src/evals/external/finbalance-kernel";
import { balanceSheetMatches, ledgerBalanceSheet, scoreFinBalance } from "../src/evals/external/finbalance";
import type { FinBalanceGold, FinBalancePosting } from "../src/evals/external/types";

function queryHandler<A extends Record<string, unknown>, R>(query: RegisteredQuery<"public", A, R>) {
  return (query as unknown as { _handler: (ctx: QueryCtx, args: A) => R })._handler;
}

const types: Record<string, string> = {
  Cash: "asset", "Reserve Cash": "asset", "Accounts Receivable": "asset", "Prepaid Rent": "asset", "Prepaid Insurance": "asset", "Office Supplies": "asset",
  Equipment: "asset", Furniture: "asset", "Right-of-Use Asset": "asset", "Input Tax Receivable": "asset", "Accumulated Depreciation": "contra_asset",
  "Accounts Payable": "liability", "Sales Tax Payable": "liability", "Owner's Equity": "equity", "Retained Earnings": "equity", "Share Capital": "equity",
  "Service Revenue": "revenue", "Other Income": "revenue", "Office Supplies Expense": "expense", "Travel Expense": "expense", "Depreciation Expense": "expense",
};
const context: PublicContext = {
  record_id: "TEST_KERNEL", period_end: "2026-01-31", account_types: types, inconsistency_codes: { bank_closing_mismatch: "x" },
  opening_balance: { assets: { Cash: 20459.88, "Accounts Receivable": 4526.83 }, liabilities: { "Accounts Payable": 985.81 }, equity: { "Owner's Equity": 24000.9 } },
};
const entries: FinBalancePosting[] = [
  { doc_refs: ["D002"], debit_account: "Accounts Receivable", credit_account: "Service Revenue", amount: 4530.84 },
  { doc_refs: ["D002"], debit_account: "Accounts Receivable", credit_account: "Sales Tax Payable", amount: 362.47 },
  { doc_refs: ["D003"], debit_account: "Office Supplies Expense", credit_account: "Accounts Payable", amount: 2391.35 },
  { doc_refs: ["D004"], debit_account: "Travel Expense", credit_account: "Cash", amount: 74.9 },
  { doc_refs: ["D005", "D002"], debit_account: "Cash", credit_account: "Accounts Receivable", amount: 1000 },
  { doc_refs: ["D006"], debit_account: "Depreciation Expense", credit_account: "Accumulated Depreciation", amount: 125.5 },
];

/** The real kernel handlers (postEntry, trialBalance) over the in-memory DB double, as the controller seat. */
async function harnessLedger() {
  const h = kernelHarness();
  const auth = await h.setup("controller"); // opens period 2026-01
  const ledger: KernelLedger = {
    post: async (entry) => await mutationHandler(postEntry)(h.ctx, { ...auth, ...entry }),
    trialBalance: async () => (await queryHandler(trialBalance)(h.ctx, { runId: auth.runId })).map((r) => ({ code: r.code, net: r.net })),
  };
  return { h, auth, ledger };
}

describe("FinBalance entries booked through the ledger kernel", () => {
  it("derives the balance sheet from the kernel trial balance, matching FinBalance's own ledger", async () => {
    const { h, auth, ledger } = await harnessLedger();
    const booking = await bookThroughKernel(ledger, context, entries, "bench:test");
    expect(booking.skipped).toEqual([]);
    expect(booking.posted.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(booking.balanceSheet).toEqual(ledgerBalanceSheet(context.opening_balance, entries, types));
    expect(booking.balanceSheet).toEqual({
      assets: { Cash: 21384.98, "Accounts Receivable": 8420.14, "Accumulated Depreciation": -125.5 },
      liabilities: { "Accounts Payable": 3377.16, "Sales Tax Payable": 362.47 }, equity: { "Owner's Equity": 24000.9, "Retained Earnings": 1939.09 },
    });
    // Every FinBalance account got its own non-cash kernel account; cash codes need bank evidence.
    expect(new Set(Object.values(booking.mapping)).size).toBe(Object.keys(booking.mapping).length);
    expect(Object.values(booking.mapping).some((code) => ["1000", "1010", "1020"].includes(code))).toBe(false);
    const posted = h.all("journalEntries");
    expect(posted).toHaveLength(6);
    expect(posted.every((e) => e.postedBy === "controller-1" && e.source.kind === "adjustment" && e.date === "2026-01-31")).toBe(true);
    expect(await queryHandler(verifyChain)(h.ctx, { runId: auth.runId })).toMatchObject({ ok: true, entries: 6 });
    // Replaying the same booking key is idempotent in the kernel.
    const again = await ledger.post({ idempotencyKey: "bench:test:entry:1", date: "2026-01-31", memo: posted[0]!.memo, source: posted[0]!.source, lines: posted[0]!.lines });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(h.all("journalEntries")).toHaveLength(6);
  });

  it("drops entries FinBalance's reconstruction would drop, swaps negative amounts, and records kernel refusals", async () => {
    const { h, auth, ledger } = await harnessLedger();
    const odd: FinBalancePosting[] = [
      { doc_refs: ["D002"], debit_account: "Accounts Receivable", credit_account: "Consulting Income", amount: 10 },
      { doc_refs: ["D003"], debit_account: "Travel Expense", credit_account: "Cash", amount: 0 },
      { doc_refs: ["D004"], debit_account: "Cash", credit_account: "Travel Expense", amount: -74.9 },
    ];
    const booking = await bookThroughKernel(ledger, context, odd, "bench:odd");
    expect(booking.skipped.map((s) => s.reason)).toEqual(["unknown account Consulting Income", "zero amount has no effect"]);
    expect(booking.balanceSheet.assets.Cash).toBe(20384.98);
    expect(booking.balanceSheet.equity["Retained Earnings"]).toBe(-74.9);

    expect(h.all("journalEntries")).toHaveLength(1);
    expect(auth.seatId).toBe("controller-1");
  });

  it("records kernel refusals (a closed period) and leaves those entries out of the balance sheet", async () => {
    const { h, auth, ledger } = await harnessLedger();
    const period = h.all("periods").find((p) => p.runId === auth.runId && p.period === "2026-01")!;
    await h.ctx.db.patch(period._id, { status: "closed" });
    const refused = await bookThroughKernel(ledger, context, entries.slice(0, 1), "bench:closed");
    expect(refused.posted).toEqual([]);
    expect(refused.skipped[0]!.reason).toContain("period_closed");
    expect(refused.balanceSheet).toEqual({ assets: context.opening_balance.assets, liabilities: context.opening_balance.liabilities, equity: context.opening_balance.equity });
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(h.all("violations")).toHaveLength(1);
  });

  it("refuses rather than merges balance-sheet accounts when the kernel chart has too few slots", async () => {
    const { ledger } = await harnessLedger();
    const equity: FinBalancePosting[] = [
      { doc_refs: ["D1"], debit_account: "Cash", credit_account: "Owner's Equity", amount: 5 },
      { doc_refs: ["D2"], debit_account: "Cash", credit_account: "Share Capital", amount: 5 },
    ];
    await expect(bookThroughKernel(ledger, context, equity, "bench:equity")).rejects.toThrow(KernelMappingError);
  });

  it("produces an answer FinBalance scores on the kernel's balance sheet, not the model's", async () => {
    const { ledger } = await harnessLedger();
    const booking = await bookThroughKernel(ledger, context, entries, "bench:answer");
    const parsed = { entries: entries.map((e) => ({ posting_date: "", label: "", ...e })), balance_sheet: { assets: { Cash: 1 }, liabilities: {}, equity: {} }, has_inconsistency: false, inconsistency_codes: [], inconsistency_notes: [] };
    const answer = bookedAnswer(parsed, booking.balanceSheet);
    const gold: FinBalanceGold = { recordId: "TEST_KERNEL", periodEnd: "2026-01-31", expectedInconsistency: false, expectedCodes: [], expectedEntries: entries, expectedBalanceSheet: ledgerBalanceSheet(context.opening_balance, entries, types), openingBalance: context.opening_balance, accountTypes: types, inconsistencyCodes: ["bank_closing_mismatch"] };
    expect(scoreFinBalance(answer, gold)).toMatchObject({ passed: true, metrics: { journal_entries_matched: true } });
    expect(balanceSheetMatches(gold.expectedBalanceSheet, parsed.balance_sheet)).toBe(false);
  });
});

describe("full-team FinBalance booking step", () => {
  // Public evidence as prepare_extra.py writes it: context.json in the documents table, read via the evidence worker.
  function evidence(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finbalance-evidence-"));
    const file = path.join(dir, "evidence.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE documents(path TEXT PRIMARY KEY, content TEXT); CREATE TABLE table_catalog(name TEXT, path TEXT, sheet TEXT, columns_json TEXT, row_count INTEGER);");
    db.prepare("INSERT INTO documents VALUES (?, ?)").run("context.json", JSON.stringify(context));
    db.close();
    return file;
  }
  const task = { id: "finbalance-test", benchmark: "finbalance" } as BenchmarkTask;

  it("replaces the controller's balance sheet with the kernel's and traces the booking", async () => {
    const { h, ledger } = await harnessLedger();
    const trace: Trace[] = [];
    const final = "```json\n" + JSON.stringify({ has_inconsistency: false, inconsistency_codes: [], inconsistency_notes: [], entries, balance_sheet: { assets: { Cash: 1 }, liabilities: {}, equity: {} } }) + "\n```";
    const result = await bookFinBalance(ledger, evidence(), task, final, "bench:flow", trace, "controller");
    expect(JSON.parse(result.answer).balance_sheet).toEqual(ledgerBalanceSheet(context.opening_balance, entries, types));
    expect(result.summary).toBe("booked 6/6 entries through the kernel (0 skipped)");
    expect(trace.map((t) => [t.seat, t.tool])).toEqual([["controller", "kernel_book_entries"]]);
    expect(h.all("journalEntries")).toHaveLength(6);
  });

  it("books nothing for contradiction answers or answers that do not parse", async () => {
    const { h, ledger } = await harnessLedger();
    const db = evidence(), trace: Trace[] = [];
    const flagged = await bookFinBalance(ledger, db, task, JSON.stringify({ has_inconsistency: true, inconsistency_codes: ["bank_closing_mismatch"], inconsistency_notes: ["x"], entries, balance_sheet: {} }), "bench:neg", trace, "controller");
    expect(JSON.parse(flagged.answer)).toMatchObject({ has_inconsistency: true, entries: [], balance_sheet: { assets: {}, liabilities: {}, equity: {} } });
    const prose = await bookFinBalance(ledger, db, task, "I could not finish.", "bench:prose", trace, "controller");
    expect(prose.answer).toBe("I could not finish.");
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(trace.map((t) => (t.output as { booked: boolean }).booked)).toEqual([false, false]);
  });
});
