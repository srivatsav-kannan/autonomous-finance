// Shared constants for the unofficial Vals Finance Agent (v1.1 public set) harness.
// Values that mirror the official harness cite the file they come from
// (github.com/vals-ai/finance-agent @ 8ba65f8).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** evals/external/vals-finance-agent */
export const HARNESS_DIR = path.resolve(here, "..");
/** autonomous-finance repo root */
export const REPO_ROOT = path.resolve(HARNESS_DIR, "../../..");
/** Where the downloaded benchmark repo lives (outside the hack repo). */
export const BENCH_DIR = path.resolve(REPO_ROOT, "../benchdata/vals-finance-agent");
export const DATASET_CSV = path.join(BENCH_DIR, "repo/data/public.csv");
/** Raw transcripts and per-question records (gitignored: var/). */
export const RUNS_DIR = path.join(REPO_ROOT, "var/evals/vals-finance-agent");
/** Published summary (docs/evals/vals-finance-agent.{md,json}). */
export const DOCS_DIR = path.join(REPO_ROOT, "docs/evals");
export const ENV_FILE = path.join(REPO_ROOT, ".env.local");

export const MODEL = "claude-opus-5-5";
/** Finance research is hard, so the agent runs at high effort; the judge at medium. */
export const AGENT_EFFORT = "high" as const;
export const JUDGE_EFFORT = "medium" as const;

/** run_agent.py: --max-turns default 50. A "turn" here is one model sampling
 * iteration (one entry in usage.iterations), which is what one Vals turn is. */
export const MAX_TURNS = 50;
/** Leaderboard metadata lists max_output_tokens 128000 for the Opus runs. */
export const AGENT_MAX_TOKENS = 128_000;
export const JUDGE_MAX_TOKENS = 16_000;

/** tools.py MAX_END_DATE: searches are capped at the benchmark's "today". */
export const MAX_END_DATE = "2025-04-07";
/** EDGAR full-text search only indexes filings from 2001 onward. */
export const EDGAR_FTS_MIN_DATE = "2001-01-01";
/** SEC requires a declared contact ("name email") in the User-Agent. Set SEC_USER_AGENT before running; no personal default is committed. */
export const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "autonomous-finance-evals (contact not set: export SEC_USER_AGENT)";
/** SEC asks for <= 10 req/s; we stay at 8 across all concurrent questions of one
 * process. Set SEC_RPS lower when running several processes at once (their sum must stay <= 8). */
export const SEC_MAX_REQUESTS_PER_SECOND = Math.min(8, Number(process.env.SEC_RPS ?? 8) || 8);

/** How edgar_search results are serialised. "python" (default, harness v2) matches the
 * official tool's json.dumps output; "compact" reproduces harness v1 (first full pass). */
export const EDGAR_RESULT_FORMAT: "python" | "compact" = process.env.EDGAR_RESULT_FORMAT === "compact" ? "compact" : "python";

/** Server-side refusal fallback (scalar "default" form). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;

/** Safety rails that the official harness does not have (reported if hit). */
export const PER_QUESTION_COST_CAP_USD = 6;
export const PER_QUESTION_WALL_CAP_S = 45 * 60;

/** USD per million tokens. Opus 5.5 prices are from the user brief / pricing page;
 * fallback models are listed in case a refusal fallback serves a turn. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};
export const WEB_SEARCH_USD_PER_1K = 10;
/** Web fetch and the code execution behind dynamic filtering carry no extra fee. */
export const WEB_FETCH_USD_PER_1K = 0;
