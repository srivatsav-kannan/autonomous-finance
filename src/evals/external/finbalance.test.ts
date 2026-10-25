import { describe, expect, it } from "vitest";
import { emptyUsage } from "../../agents/llm";
import { balanceSheetMatches, ledgerBalanceSheet, parseSubmission, round2, scoreFinBalance, SubmissionParseError } from "./finbalance";
import { gradeAnswer } from "./score";
import type { BenchmarkTask, FinBalanceGold } from "./types";

const accountTypes = { Cash: "asset", "Accounts Receivable": "asset", "Accumulated Depreciation": "contra_asset", "Accounts Payable": "liability", "Owner's Equity": "equity", "Retained Earnings": "equity", "Service Revenue": "revenue", "Travel Expense": "expense", "Office Supplies Expense": "expense", "Depreciation Expense": "expense" };
const codes = ["bank_closing_mismatch", "invoice_total_mismatch", "tax_total_mismatch"];
const opening = { assets: { Cash: 1000, "Accounts Receivable": 200, "Accumulated Depreciation": -50 }, liabilities: { "Accounts Payable": 100 }, equity: { "Owner's Equity": 1050 } };
const expectedEntries = [
  { doc_refs: ["D002"], debit_account: "Accounts Receivable", credit_account: "Service Revenue", amount: 500 },
  { doc_refs: ["D003"], debit_account: "Office Supplies Expense", credit_account: "Accounts Payable", amount: 120.5 },
  { doc_refs: ["D004"], debit_account: "Travel Expense", credit_account: "Cash", amount: 30.25 },
];
const standard: FinBalanceGold = {
  recordId: "TEST_STD", periodEnd: "2024-12-31", expectedInconsistency: false, expectedCodes: [], expectedEntries,
  expectedBalanceSheet: ledgerBalanceSheet(opening, expectedEntries, accountTypes), openingBalance: opening, accountTypes, inconsistencyCodes: codes,
};
const negative: FinBalanceGold = { ...standard, recordId: "TEST_NEG", expectedInconsistency: true, expectedCodes: ["bank_closing_mismatch"], expectedEntries: [], expectedBalanceSheet: { assets: {}, liabilities: {}, equity: {} } };
const submit = (value: object) => JSON.stringify({ has_inconsistency: false, inconsistency_codes: [], inconsistency_notes: [], entries: expectedEntries, balance_sheet: standard.expectedBalanceSheet, ...value });

describe("FinBalance ledger port", () => {
  it("rolls income into retained earnings and renders contra assets with their sign", () => {
    expect(standard.expectedBalanceSheet).toEqual({
      assets: { Cash: 969.75, "Accounts Receivable": 700, "Accumulated Depreciation": 50 },
      liabilities: { "Accounts Payable": 220.5 }, equity: { "Owner's Equity": 1050, "Retained Earnings": 349.25 },
    });
  });
  it("rounds like Python round(x, 2), ties to even on exactly representable halves", () => {
    expect([round2(0.125), round2(0.375), round2(1.005), round2(2.675), round2(-0.125), round2(10)]).toEqual([0.12, 0.38, 1, 2.67, -0.12, 10]);
  });
});

describe("FinBalance parser port", () => {
  it("extracts fenced or embedded JSON and repairs thousands separators", () => {
    const fenced = "Here you go:\n```json\n" + submit({}) + "\n```";
    expect(parseSubmission(fenced, codes).entries).toHaveLength(3);
    const separated = '{"has_inconsistency": false, "entries": [{"doc_refs": "D002", "debit_account": "Cash", "credit_account": "Service Revenue", "amount": 1,250.00}], "balance_sheet": null}';
    const parsed = parseSubmission(separated, codes);
    expect(parsed.entries[0]).toMatchObject({ doc_refs: ["D002"], amount: 1250 });
    expect(parsed.balance_sheet).toEqual({ assets: {}, liabilities: {}, equity: {} });
  });
  it("rejects unknown inconsistency codes, non-numeric amounts and non-object answers", () => {
    expect(() => parseSubmission(submit({ inconsistency_codes: ["made_up_code"] }), codes)).toThrow(SubmissionParseError);
    expect(() => parseSubmission(submit({ entries: [{ amount: "a lot" }] }), codes)).toThrow(SubmissionParseError);
    expect(() => parseSubmission("[1, 2]", codes)).toThrow(SubmissionParseError);
    expect(() => parseSubmission("", codes)).toThrow(SubmissionParseError);
  });
  it("normalizes codes and notes like the upstream parser", () => {
    const parsed = parseSubmission(JSON.stringify({ has_inconsistency: 1, inconsistency_codes: " bank_closing_mismatch ", inconsistency_notes: ["  ", "Closing differs"], entries: null }), codes);
    expect(parsed).toMatchObject({ has_inconsistency: true, inconsistency_codes: ["bank_closing_mismatch"], inconsistency_notes: ["Closing differs"], entries: [] });
  });
});

describe("FinBalance scoring", () => {
  it("scores BS_exact on standard records, within a one-cent tolerance", () => {
    expect(scoreFinBalance(submit({}), standard)).toMatchObject({ score: 1, passed: true, method: "finbalance-bs-exact-v1" });
    const nudged = { ...standard.expectedBalanceSheet, assets: { ...standard.expectedBalanceSheet.assets, Cash: 969.76 } };
    expect(balanceSheetMatches(standard.expectedBalanceSheet, nudged)).toBe(true);
    const wrong = { ...standard.expectedBalanceSheet, assets: { ...standard.expectedBalanceSheet.assets, Cash: 969.5 } };
    expect(scoreFinBalance(submit({ balance_sheet: wrong }), standard)).toMatchObject({ score: 0, passed: false });
    // An extra nonzero account, or a missing one, fails; zero-valued accounts are ignored.
    expect(balanceSheetMatches(standard.expectedBalanceSheet, { ...standard.expectedBalanceSheet, liabilities: { "Accounts Payable": 220.5, "Notes Payable": 0 } })).toBe(true);
    expect(balanceSheetMatches(standard.expectedBalanceSheet, { ...standard.expectedBalanceSheet, liabilities: { "Accounts Payable": 220.5, "Notes Payable": 5 } })).toBe(false);
  });
  it("separates the reported balance sheet from entry and reconstruction diagnostics", () => {
    const refs = expectedEntries.map((e, i) => i === 0 ? { ...e, doc_refs: ["D002", "D005"] } : e);
    const result = scoreFinBalance(submit({ entries: refs }), standard);
    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({ journal_entries_matched: false, journal_entries_accounting_matched: true, doc_refs_mismatch_count: 1, predicted_entries_reconstruct_correct_final_balance_sheet: true });
    const dropped = scoreFinBalance(submit({ entries: expectedEntries.slice(1) }), standard).metrics;
    expect(dropped).toMatchObject({ final_balance_sheet_matches: true, missing_entry_count: 1, predicted_entries_reconstruct_correct_final_balance_sheet: false });
  });
  it("scores contradiction records on the flag plus the exact code set", () => {
    const flag = (codesFound: string[], has = true) => JSON.stringify({ has_inconsistency: has, inconsistency_codes: codesFound, inconsistency_notes: [], entries: [], balance_sheet: {} });
    expect(scoreFinBalance(flag(["bank_closing_mismatch"]), negative)).toMatchObject({ score: 1, method: "finbalance-contradiction-code-v1" });
    expect(scoreFinBalance(flag(["bank_closing_mismatch", "tax_total_mismatch"]), negative).passed).toBe(false);
    expect(scoreFinBalance(flag(["invoice_total_mismatch"]), negative).passed).toBe(false);
    expect(scoreFinBalance(flag(["bank_closing_mismatch"], false), negative).passed).toBe(false);
    // A false alarm on a standard record leaves an empty balance sheet, so BS_exact fails.
    expect(scoreFinBalance(flag(["bank_closing_mismatch"]), standard).metrics).toMatchObject({ false_inconsistency_alarm: true, final_balance_sheet_matches: false });
  });
  it("scores unparseable answers zero, with the parse failure as the reason", async () => {
    const grade = await gradeAnswer({ id: "finbalance-x" } as BenchmarkTask, { status: "answered", answer: "The books balance.", usage: emptyUsage(), trace: [] }, { kind: "finbalance", answer: "", finbalance: standard }, false);
    expect(grade).toMatchObject({ status: "graded", score: 0, passed: false, metrics: { parse_success: false } });
    expect(grade.reason).toContain("FinBalance parse failure");
  });
});
