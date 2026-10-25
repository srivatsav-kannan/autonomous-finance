// FinBalance (Devansh1105/finbalance @ a1062b7, Apache-2.0) parser, scorer and ledger, ported
// from finbalance/benchmark/parser.py, finbalance/benchmark/analysis.py (analyze_submission)
// and finbalance/ledger.py. BS_exact is `final_balance_sheet_matches` on standard records;
// contradiction records score `inconsistency_code_matches` (flag set and exact code set).
import type { FinBalanceGold, FinBalancePosting, Sections } from "./types";

export class SubmissionParseError extends Error {}
export interface ParsedSubmission {
  entries: Required<FinBalancePosting>[];
  balance_sheet: Sections;
  has_inconsistency: boolean;
  inconsistency_codes: string[];
  inconsistency_notes: string[];
}
const SECTIONS = ["assets", "liabilities", "equity"] as const;
export const emptySections = (): Sections => ({ assets: {}, liabilities: {}, equity: {} });
export const emptySubmission = (): ParsedSubmission => ({ entries: [], balance_sheet: emptySections(), has_inconsistency: false, inconsistency_codes: [], inconsistency_notes: [] });

/** Python round(x, 2): exact decimal rounding of the binary value, ties to even. */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const t = Math.abs(x);
  if (t >= 1e21) return x;
  const exact = t.toFixed(20);
  let r = Number(t.toFixed(2));
  if (/^\d+\.\d\d50*$/.test(exact)) {
    const floor = Math.floor(t * 100) / 100;
    const cents = Math.round(floor * 100);
    r = cents % 2 === 0 ? floor : Number(((cents + 1) / 100).toFixed(2));
  }
  return x < 0 ? -r : r;
}
/** Python round(x) to an integer: ties to even. */
function roundInt(x: number): number {
  const f = Math.floor(x), d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}
function coerceFloat(v: unknown, at: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "string") {
    const s = v.trim().replaceAll("_", "");
    if (/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(s)) return Number(s);
    if (/^[+-]?(?:inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
  }
  throw new SubmissionParseError(`${at} must be numeric`);
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function extractJsonBlob(text: string): string {
  const stripped = text.trim();
  if (!stripped) throw new SubmissionParseError("empty model response");
  if (stripped.startsWith("{") && stripped.endsWith("}")) return stripped;
  for (const m of stripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const candidate = m[1]!.trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  const start = stripped.indexOf("{"), end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new SubmissionParseError("could not find a JSON object in model response");
  return stripped.slice(start, end + 1);
}
function stringList(v: unknown, at: string, strip: boolean): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") { const s = strip ? v.trim() : v; return strip && !s ? [] : [s]; }
  if (Array.isArray(v)) return strip ? v.map((x) => pyStr(x).trim()).filter(Boolean) : v.map(pyStr);
  throw new SubmissionParseError(`${at} must be a string or list of strings`);
}

/** Port of finbalance.benchmark.parser.parse_submission. */
export function parseSubmission(text: string, allowedCodes: readonly string[]): ParsedSubmission {
  const blob = extractJsonBlob(text);
  let raw: unknown;
  try { raw = JSON.parse(blob); } catch (e) {
    const repaired = blob.replace(/(?<=\d),(?=\d{3}(?:[^\d]|$))/g, "");
    if (repaired === blob) throw new SubmissionParseError(`invalid JSON: ${(e as Error).message}`);
    try { raw = JSON.parse(repaired); } catch { throw new SubmissionParseError(`invalid JSON: ${(e as Error).message}`); }
  }
  if (!isObject(raw)) throw new SubmissionParseError("top-level response must be a JSON object");
  const rawEntries = raw.entries ?? [];
  if (!Array.isArray(rawEntries)) throw new SubmissionParseError("entries must be a list");
  const entries = rawEntries.map((item, i) => {
    if (!isObject(item)) throw new SubmissionParseError(`entries[${i}] must be an object`);
    return {
      doc_refs: (() => { try { return stringList(item.doc_refs, "", false); } catch { throw new SubmissionParseError("entry.doc_refs must be a string or list of strings"); } })(),
      debit_account: "debit_account" in item ? pyStr(item.debit_account) : "",
      credit_account: "credit_account" in item ? pyStr(item.credit_account) : "",
      amount: coerceFloat(item.amount, `entries[${i}].amount`),
      posting_date: "posting_date" in item ? pyStr(item.posting_date) : "",
      label: "label" in item ? pyStr(item.label) : "",
    };
  });
  const sheet = emptySections();
  if (raw.balance_sheet !== null && raw.balance_sheet !== undefined) {
    if (!isObject(raw.balance_sheet)) throw new SubmissionParseError("balance_sheet must be an object");
    for (const section of SECTIONS) {
      const values = raw.balance_sheet[section] ?? {};
      if (!isObject(values)) throw new SubmissionParseError(`balance_sheet.${section} must be an object`);
      for (const [account, amount] of Object.entries(values)) sheet[section][account] = coerceFloat(amount, `balance_sheet.${section}.${account}`);
    }
  }
  const codes: string[] = [];
  for (const code of stringList(raw.inconsistency_codes, "inconsistency_codes", true)) {
    if (!allowedCodes.includes(code)) throw new SubmissionParseError(`inconsistency_codes contains unknown code '${code}'`);
    if (!codes.includes(code)) codes.push(code);
  }
  return {
    entries, balance_sheet: sheet, has_inconsistency: pyTruthy(raw.has_inconsistency ?? false), inconsistency_codes: codes,
    inconsistency_notes: stringList(raw.inconsistency_notes, "inconsistency_notes", true),
  };
}

const DEBIT_NORMAL = new Set(["asset", "expense"]);
const SECTION_OF: Record<string, keyof Sections> = { asset: "assets", contra_asset: "assets", liability: "liabilities", equity: "equity" };

/** Port of finbalance.ledger.Ledger (float arithmetic, rounded to cents at every step). */
export function ledgerBalanceSheet(opening: Sections, entries: FinBalancePosting[], types: Record<string, string>): Sections {
  const balances = new Map<string, number>();
  for (const section of SECTIONS) for (const [account, value] of Object.entries(opening[section] ?? {})) balances.set(account, round2(Number(value)));
  const effect = (account: string, amount: number) => {
    const type = types[account];
    if (!type) throw new Error(`Unknown account '${account}'`);
    return DEBIT_NORMAL.has(type) ? amount : -amount;
  };
  for (const e of entries) {
    const amount = round2(e.amount);
    balances.set(e.debit_account, round2((balances.get(e.debit_account) ?? 0) + effect(e.debit_account, amount)));
    balances.set(e.credit_account, round2((balances.get(e.credit_account) ?? 0) - effect(e.credit_account, amount)));
  }
  return renderBalanceSheet(balances, types);
}
export function renderBalanceSheet(balances: Map<string, number>, types: Record<string, string>): Sections {
  const out = emptySections();
  let revenue = 0, expense = 0;
  for (const [account, balance] of balances) {
    const type = types[account];
    if (!type) throw new Error(`Unknown account '${account}'`);
    if (type === "revenue") { revenue += balance; continue; }
    if (type === "expense") { expense += balance; continue; }
    const rendered = type === "contra_asset" ? -balance : balance;
    if (Math.abs(rendered) > 0.004) out[SECTION_OF[type]!][account] = round2(rendered);
  }
  const retained = round2(revenue - expense);
  if (Math.abs(retained) > 0.004) out.equity["Retained Earnings"] = round2((out.equity["Retained Earnings"] ?? 0) + retained);
  return out;
}

function normalizeSection(accounts: Record<string, number>, tol: number): Map<string, number> {
  return new Map(Object.entries(accounts).filter(([, v]) => Math.abs(Number(v)) > tol).map(([k, v]) => [k, round2(Number(v))]));
}
export function balanceSheetMatches(expected: Sections, predicted: Sections, tol = 0.01): boolean {
  for (const section of SECTIONS) {
    const e = normalizeSection(expected[section] ?? {}, tol), p = normalizeSection(predicted[section] ?? {}, tol);
    if (e.size !== p.size || [...e.keys()].some((k) => !p.has(k))) return false;
    for (const [account, amount] of e) if (Math.abs((p.get(account) ?? 0) - amount) > tol) return false;
  }
  return true;
}

type Status = "exact" | "doc_refs_mismatch" | "wrong_amount" | "wrong_account" | "missing" | "extra" | "unmatched";
const amountKey = (p: FinBalancePosting, tol: number) => tol <= 0 ? roundInt(p.amount * 100) : roundInt(p.amount / tol);
const refs = (p: FinBalancePosting) => [...p.doc_refs].sort();
function matchEntries(expected: FinBalancePosting[], predicted: FinBalancePosting[], tol: number) {
  const ex = expected.map((posting) => ({ posting, status: "unmatched" as Status }));
  const pr = predicted.map((posting) => ({ posting, status: "unmatched" as Status }));
  const keys: [(p: FinBalancePosting) => string, Status][] = [
    [(p) => JSON.stringify([refs(p), p.debit_account, p.credit_account, amountKey(p, tol)]), "exact"],
    [(p) => JSON.stringify([p.debit_account, p.credit_account, amountKey(p, tol)]), "doc_refs_mismatch"],
    [(p) => JSON.stringify([refs(p), p.debit_account, p.credit_account]), "wrong_amount"],
    [(p) => JSON.stringify([refs(p), amountKey(p, tol)]), "wrong_account"],
  ];
  for (const [key, status] of keys) {
    const lookup = new Map<string, typeof pr>();
    for (const item of pr) if (item.status === "unmatched") lookup.set(key(item.posting), [...(lookup.get(key(item.posting)) ?? []), item]);
    for (const item of ex) {
      if (item.status !== "unmatched") continue;
      const match = lookup.get(key(item.posting))?.shift();
      if (match) { item.status = status; match.status = status; }
    }
  }
  for (const item of ex) if (item.status === "unmatched") item.status = "missing";
  for (const item of pr) if (item.status === "unmatched") item.status = "extra";
  return { ex, pr };
}

/** Port of analyze_submission's headline metrics (no slice diagnostics). */
export function analyzeSubmission(gold: FinBalanceGold, parsed: ParsedSubmission, parseSuccess: boolean) {
  const known = (p: FinBalancePosting) => p.debit_account in gold.accountTypes && p.credit_account in gold.accountTypes;
  const invalidAccounts = [...new Set(parsed.entries.flatMap((p) => [p.debit_account, p.credit_account]).filter((a) => !(a in gold.accountTypes)))].sort();
  const reconstructed = ledgerBalanceSheet(gold.openingBalance, parseSuccess ? parsed.entries.filter(known) : [], gold.accountTypes);
  if (gold.expectedInconsistency) {
    const same = new Set(gold.expectedCodes).size === new Set(parsed.inconsistency_codes).size && gold.expectedCodes.every((c) => parsed.inconsistency_codes.includes(c));
    return {
      parse_success: parseSuccess, expected_inconsistency: true,
      inconsistency_flag_matches: parsed.has_inconsistency, inconsistency_code_matches: parsed.has_inconsistency && same,
      missed_inconsistency: !parsed.has_inconsistency, final_balance_sheet_matches: false,
      predicted_entry_count: parsed.entries.length, invalid_accounts: invalidAccounts,
    };
  }
  const { ex, pr } = matchEntries(gold.expectedEntries, parsed.entries, 0.01);
  const count = (s: Status) => ex.filter((x) => x.status === s).length;
  const extra = pr.filter((x) => x.status === "extra").length;
  const exactEntries = ex.length === count("exact") && extra === 0 && pr.length === ex.length;
  const accounting = ex.length === count("exact") + count("doc_refs_mismatch") && !count("wrong_amount") && !count("wrong_account") && !count("missing") && extra === 0;
  const bsMatch = balanceSheetMatches(gold.expectedBalanceSheet, parsed.balance_sheet);
  return {
    parse_success: parseSuccess, expected_inconsistency: false,
    inconsistency_flag_matches: !parsed.has_inconsistency, false_inconsistency_alarm: parsed.has_inconsistency,
    final_balance_sheet_matches: bsMatch,
    journal_entries_matched: exactEntries, journal_entries_accounting_matched: accounting,
    predicted_entries_reconstruct_correct_final_balance_sheet: balanceSheetMatches(gold.expectedBalanceSheet, reconstructed),
    predicted_balance_sheet_matches_reconstructed_balance_sheet: balanceSheetMatches(reconstructed, parsed.balance_sheet),
    exact_entry_match_count: count("exact"), doc_refs_mismatch_count: count("doc_refs_mismatch"), wrong_amount_count: count("wrong_amount"),
    wrong_account_count: count("wrong_account"), missing_entry_count: count("missing"), extra_entry_count: extra,
    expected_entry_count: ex.length, predicted_entry_count: pr.length, invalid_accounts: invalidAccounts,
  };
}

export function scoreFinBalance(answer: string, gold: FinBalanceGold) {
  let parsed = emptySubmission(), parseSuccess = false, reason: string | undefined;
  try { parsed = parseSubmission(answer, gold.inconsistencyCodes); parseSuccess = true; }
  catch (e) { if (!(e instanceof SubmissionParseError)) throw e; reason = `FinBalance parse failure: ${e.message}`; }
  const metrics = analyzeSubmission(gold, parsed, parseSuccess);
  const passed = gold.expectedInconsistency ? metrics.inconsistency_code_matches === true : metrics.final_balance_sheet_matches;
  return { score: Number(passed), passed, reason, metrics, method: gold.expectedInconsistency ? "finbalance-contradiction-code-v1" : "finbalance-bs-exact-v1" };
}
