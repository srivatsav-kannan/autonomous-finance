import type { Role } from "../../core/roles";
import type { Usage } from "../../agents/llm";

export const MODES = ["full-team", "generalist", "rules-only"] as const;
export type Mode = (typeof MODES)[number];
export const BENCHMARKS = ["apex", "dabstep", "invoice-sandbox", "finbalance"] as const;
export type Benchmark = (typeof BENCHMARKS)[number];
export const ANSWER_TYPES = ["number", "integer-set", "customer-net-spend", "finbalance-standard", "finbalance-contradiction"] as const;
export interface BenchmarkTask {
  id: string;
  benchmark: Benchmark;
  sourceId: string;
  label: string;
  role: Role;
  prompt: string;
  evidence: string;
  evidenceSha256: string;
  answerType?: (typeof ANSWER_TYPES)[number];
  decimals?: number;
}
export interface CustomerTotals {
  customer_name: string;
  valid_invoice_count: string;
  gross_invoice_spend_usd: string;
  credit_memo_total_usd: string;
  net_spend_usd: string;
}
export type Sections = { assets: Record<string, number>; liabilities: Record<string, number>; equity: Record<string, number> };
export interface FinBalancePosting { doc_refs: string[]; debit_account: string; credit_account: string; amount: number; posting_date?: string; label?: string }
export interface FinBalanceGold {
  recordId: string;
  periodEnd: string;
  expectedInconsistency: boolean;
  expectedCodes: string[];
  expectedEntries: FinBalancePosting[];
  expectedBalanceSheet: Sections;
  openingBalance: Sections;
  accountTypes: Record<string, string>;
  inconsistencyCodes: string[];
}
export interface Gold {
  kind: "rubric" | "number" | "integer-set" | "customer-net-spend" | "finbalance";
  answer: string;
  decimals?: number;
  criteria?: { id: string; description: string }[];
  customers?: Record<string, CustomerTotals>;
  finbalance?: FinBalanceGold;
}
export interface Trace {
  seat: string;
  tool: string;
  input: unknown;
  output: unknown;
}
export interface Answer {
  status: "answered" | "abstained" | "error";
  answer: string;
  reason?: string;
  usage: Usage;
  trace: Trace[];
  kernelRunId?: string;
}
export interface Grade {
  status: "graded" | "ungraded" | "error";
  score: number | null;
  passed: boolean | null;
  method: string;
  reason?: string;
  criteria?: { id: string; met: boolean; reason: string }[];
  /** Benchmark-specific diagnostics (Invoice Sandbox field exactness, FinBalance entry metrics). */
  metrics?: Record<string, unknown>;
  judgeUsage: Usage;
}
export interface Result extends Answer {
  taskId: string;
  benchmark: Benchmark;
  mode: Mode;
  repeat: number;
  wallSeconds: number;
  grade: Grade;
}
