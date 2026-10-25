// Pure parts of `npm run evals`: argument rules, the paid budget split and the one-time
// benchmark policy. Unit tested in tests/evals-plan.test.ts.
import type { ModelPolicy } from "../../src/evals/external/models";

export const WORLD_SEEDS = [7, 11, 23, 42] as const;
/** Every external task: the eight-task batch plus the opt-in Invoice Sandbox and FinBalance cases. */
export const ALL_EXTERNAL = "apex,dabstep,invoice-sandbox,finbalance";
export const EXTERNAL_TASKS = 15;
export const EXTERNAL_APEX_TASKS = 3;
/** Same turn budget as the measured run in docs/RESULTS.md §3; Invoice Sandbox needs more than 12. */
export const EXTERNAL_MAX_TURNS = 30;

/** Measured costs from docs/RESULTS.md (Oct 24-25, gpt-6.1-sol), used only for the printed estimate. */
export const MEASURED_USD = { worldPerSeed: 0.05, sheetsAgent: 0.6, external: 6.39 } as const;

export type EvalArgs = { paid: false } | { paid: true; budgetUsd: number };

export const EVALS_USAGE = "Usage: npm run evals                          free evals only (no model calls)\n       npm run evals -- --paid --budget-usd N    also the model evals, capped at $N in total";

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let paid = false;
  let budget: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i]!.split("=", 2) as [string, string | undefined];
    if (name === "--paid") paid = true;
    else if (name === "--budget-usd") budget = inline ?? argv[++i];
    else throw new Error(`Unknown option ${argv[i]}.\n${EVALS_USAGE}`);
  }
  if (!paid) {
    if (budget !== undefined) throw new Error(`--budget-usd applies only with --paid.\n${EVALS_USAGE}`);
    return { paid: false };
  }
  if (budget === undefined) throw new Error(`--paid needs --budget-usd N: the most the model evals may spend in total, in USD.\n${EVALS_USAGE}`);
  const budgetUsd = Number(budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 500) throw new Error("--budget-usd must be a positive number of dollars, at most 500");
  return { paid: true, budgetUsd };
}

/**
 * Split the budget across the paid runs: 10% for the four world seeds (2.5% each), 15% for the
 * spreadsheet agent comparison, 75% for the external benchmarks. Rounded down to the cent so
 * the shares never add up to more than the budget.
 */
export function splitBudget(budgetUsd: number) {
  const cents = (fraction: number) => Math.floor(budgetUsd * fraction * 100) / 100;
  return { worldPerSeed: cents(0.025), sheetsAgent: cents(0.15), external: cents(0.75) };
}

export function paidTotal(shares: ReturnType<typeof splitBudget>): number {
  return Math.round((shares.worldPerSeed * WORLD_SEEDS.length + shares.sheetsAgent + shares.external) * 100) / 100;
}

/** Requests the external run may make: every model turn of 15 tasks x 2 modes, plus one APEX judge call per answer. */
export function externalMaxRequests(maxTurns = EXTERNAL_MAX_TURNS): number {
  return EXTERNAL_TASKS * 2 * maxTurns + EXTERNAL_APEX_TASKS * 2;
}

/** Worst-case reservation of one request under a policy role, in USD (what PaidBudget holds before dispatch). */
export function requestCeilingUsd(config: ModelPolicy["agent"]): number {
  const p = config.prices!;
  return (config.maxInputTokens * Math.max(p.input, p.cacheRead, p.cacheWrite) + config.maxOutputTokens * p.output) / 1e6;
}

/** A one-time approved copy of the checked-in policy, capped at this run's share. */
export function approvedPolicy(base: ModelPolicy, maxCostUsd: number, approvedBy: string, at = new Date()): ModelPolicy {
  if (base.approval) throw new Error("The checked-in policy must stay unapproved (approval: null)");
  return { ...structuredClone(base), approval: { approvedBy, approvedAt: at.toISOString(), maxCostUsd, maxRequests: externalMaxRequests(), maxTurnsPerCase: EXTERNAL_MAX_TURNS } };
}

/** Markdown table: one row per eval. */
export function formatTable(rows: { name: string; status: string; result: string; seconds: number; costUsd?: number }[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  return [
    "| Eval | Status | Result | Time | Cost |",
    "|---|---|---|---:|---:|",
    ...rows.map((r) => `| ${cell(r.name)} | ${r.status} | ${cell(r.result)} | ${Math.round(r.seconds)} s | ${r.costUsd ? `$${r.costUsd.toFixed(2)}` : "$0"} |`),
  ].join("\n");
}
