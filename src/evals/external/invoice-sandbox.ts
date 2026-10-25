// Invoice Sandbox (ciru-ai/invoice-sandbox-benchmark @ b8cb58f) answer parsing and scoring.
// The official metric is scripts/score_submission.py: per CRM customer, net_spend_usd within
// $0.01; missing customers miss; unexpected customers are reported but not penalized; an
// unparseable money value makes the official scorer exit, so the whole answer scores zero.
import type { CustomerTotals } from "./types";

const FIELDS = ["valid_invoice_count", "gross_invoice_spend_usd", "credit_memo_total_usd", "net_spend_usd"] as const;

/** Minimal RFC 4180 reader (quoted cells, doubled quotes), enough for a CSV block in an answer. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Customer rows keyed by customer_id, read from the block whose header contains customer_id and net_spend_usd. */
export function customerRows(answer: string): Map<string, Record<string, string>> | null {
  const body = answer.trim().replace(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i, "$1");
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const cells = parseCsv(line)[0]?.map((c) => c.trim().replace(/^﻿/, "")) ?? [];
    return cells.includes("customer_id") && cells.includes("net_spend_usd");
  });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() && !/^EXCLUDED\b/i.test(lines[end]!.trim())) end++;
  const [header, ...rows] = parseCsv(lines.slice(start, end).join("\n"));
  const names = header!.map((h) => h.trim().replace(/^﻿/, ""));
  const out = new Map<string, Record<string, string>>();
  // Like csv.DictReader keyed by customer_id: blank IDs are skipped, a later duplicate wins.
  for (const cells of rows) {
    const record = Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ""]));
    const id = (record.customer_id ?? "").trim();
    if (id) out.set(id, record);
  }
  return out;
}

/** score_submission.parse_money: strip "$" and ",", Decimal-quantize to cents. Integer cents or null when invalid. */
export function moneyCents(value: string | undefined): number | null {
  const cleaned = (value ?? "").trim().replaceAll("$", "").replaceAll(",", "");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (!match[2] && !match[3])) return null;
  const fraction = (match[3] ?? "").padEnd(3, "0");
  // Decimal.quantize uses ROUND_HALF_EVEN.
  let cents = BigInt(match[2] || "0") * 100n + BigInt(fraction.slice(0, 2));
  const rest = fraction.slice(2);
  const half = BigInt(rest[0]!) > 5n || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || cents % 2n === 1n));
  if (half) cents += 1n;
  const signed = match[1] === "-" ? -cents : cents;
  return Number.isSafeInteger(Number(signed)) ? Number(signed) : null;
}

export interface InvoiceScore {
  score: number;
  passed: boolean;
  reason?: string;
  metrics: Record<string, unknown>;
}

export function scoreInvoiceSandbox(answer: string, expected: Record<string, CustomerTotals>): InvoiceScore {
  const ids = Object.keys(expected);
  const rows = customerRows(answer);
  if (!rows) return { score: 0, passed: false, reason: "No CSV block with customer_id and net_spend_usd columns", metrics: { customers_scored: ids.length, customers_exact: 0 } };
  let exact = 0, totalAbsCents = 0;
  const missing: string[] = [], mismatches: { customer_id: string; expected: string; actual: string }[] = [];
  const fieldExact = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<(typeof FIELDS)[number], number>;
  for (const id of ids) {
    const want = expected[id]!;
    const row = rows.get(id);
    if (!row) { missing.push(id); totalAbsCents += Math.abs(moneyCents(want.net_spend_usd)!); continue; }
    const actual = moneyCents(row.net_spend_usd);
    if (actual === null) return { score: 0, passed: false, reason: `Invalid money value for ${id}: ${JSON.stringify(row.net_spend_usd ?? "")} (the official scorer stops)`, metrics: { customers_scored: ids.length, customers_exact: 0 } };
    const delta = Math.abs(actual - moneyCents(want.net_spend_usd)!);
    totalAbsCents += delta;
    if (delta <= 1) exact++;
    else mismatches.push({ customer_id: id, expected: want.net_spend_usd, actual: row.net_spend_usd ?? "" });
    // Extended diagnostics (not part of the official score), as in evals/external/invoice-sandbox/score.py.
    for (const field of FIELDS) {
      if (field === "valid_invoice_count") fieldExact[field] += Number(/^\s*[+-]?\d+\s*$/.test(row[field] ?? "") && Number(row[field]) === Number(want[field]));
      else { const a = moneyCents(row[field]), e = moneyCents(want[field]); fieldExact[field] += Number(a !== null && e !== null && Math.abs(a - e) <= 1); }
    }
  }
  const unexpected = [...rows.keys()].filter((id) => !(id in expected)).sort();
  const score = exact / ids.length;
  return {
    score, passed: exact === ids.length,
    metrics: {
      customers_scored: ids.length, customers_exact: exact, customer_accuracy: Number(score.toFixed(4)),
      total_absolute_error_usd: (totalAbsCents / 100).toFixed(2), missing_customers: missing, unexpected_customers: unexpected,
      mismatches, field_exact: fieldExact,
    },
  };
}
