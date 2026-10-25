// Aggregates agent records + judgments into docs/evals/vals-finance-agent.{json,md}.
// Usage: npx tsx evals/external/vals-finance-agent/src/report.ts --runs main[,rep2,...] [--judge-tag s3]
// The first run id is the primary (single-pass) result; extra runs are repeats of
// the same questions used to show run-to-run variation.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./args";
import {
  AGENT_EFFORT,
  AGENT_MAX_TOKENS,
  DOCS_DIR,
  JUDGE_EFFORT,
  MAX_END_DATE,
  MAX_TURNS,
  MODEL,
  PER_QUESTION_COST_CAP_USD,
  PER_QUESTION_WALL_CAP_S,
  SEC_MAX_REQUESTS_PER_SECOND,
} from "./config";
import { loadQuestions, type BenchQuestion } from "./dataset";
import { LEADERBOARD_FILE, type LeaderboardSnapshot } from "./leaderboard";
import { classBalanced, classBalancedStderr, mean, median, stratifiedBootstrap, wilson } from "./stats";
import { readJson, readJudgments, readLedger, readRecords, runDir, type QuestionRecord } from "./store";
import type { QuestionJudgment } from "./judge";
import type { AsOfAuditRow } from "./asof-audit";

const args = parseArgs(process.argv.slice(2));
const runIds = (typeof args.runs === "string" ? args.runs : "main").split(",");
const judgeTag = typeof args["judge-tag"] === "string" ? args["judge-tag"] : "s3";
const primary = runIds[0]!;

const questions = loadQuestions();
const qById = new Map(questions.map((q) => [q.id, q]));
const TYPES = [...new Set(questions.map((q) => q.type))].sort();

interface Row {
  q: BenchQuestion;
  r: QuestionRecord;
  j: QuestionJudgment;
}

function rowsFor(runId: string): Row[] {
  const recs = new Map(readRecords(runId).map((r) => [r.id, r]));
  const judg = new Map(readJudgments(runId, judgeTag).map((j) => [j.id, j]));
  const rows: Row[] = [];
  for (const [id, r] of recs) {
    const j = judg.get(id);
    const q = qById.get(id);
    if (j && q) rows.push({ q, r, j });
  }
  return rows.sort((a, b) => a.q.index - b.q.index);
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function runMetrics(rows: Row[]) {
  const n = rows.length;
  const correct = rows.filter((x) => x.j.all_pass).length;
  const groups = new Map<string, number[]>();
  for (const x of rows) groups.set(x.q.type, [...(groups.get(x.q.type) ?? []), x.j.all_pass ? 1 : 0]);
  const checks = rows.flatMap((x) => x.j.checks);
  const byOp = (op: string) => {
    const cs = checks.filter((c) => c.operator === op);
    return { passed: cs.filter((c) => c.verdict === "pass").length, total: cs.length };
  };
  const w = wilson(correct, n);
  const cbCi = stratifiedBootstrap(groups);
  return {
    n,
    correct,
    accuracy: correct / n,
    wilson95: [w.lo, w.hi],
    class_balanced_accuracy: classBalanced(groups),
    class_balanced_bootstrap95: [cbCi.lo, cbCi.hi],
    class_balanced_stderr: classBalancedStderr(groups),
    rubric_pass_rate: checks.filter((c) => c.verdict === "pass").length / checks.length,
    rubric_checks: { passed: checks.filter((c) => c.verdict === "pass").length, total: checks.length },
    mean_check_fraction: mean(rows.map((x) => x.j.passed / x.j.total)),
    per_operator: { correctness: byOp("correctness"), contradiction: byOp("contradiction") },
    per_type: TYPES.map((t) => {
      const rs = rows.filter((x) => x.q.type === t);
      const cs = rs.flatMap((x) => x.j.checks);
      return {
        type: t,
        n: rs.length,
        correct: rs.filter((x) => x.j.all_pass).length,
        accuracy: rs.length ? rs.filter((x) => x.j.all_pass).length / rs.length : null,
        rubric_pass_rate: cs.length ? cs.filter((c) => c.verdict === "pass").length / cs.length : null,
      };
    }),
  };
}

function opsMetrics(rows: Row[]) {
  const r = rows.map((x) => x.r);
  const tc = (f: (x: QuestionRecord) => number) => ({ total: sum(r.map(f)), mean: mean(r.map(f)) });
  const statusCounts: Record<string, number> = {};
  for (const x of r) statusCounts[x.status] = (statusCounts[x.status] ?? 0) + 1;
  const errors: Record<string, number> = {};
  for (const x of r) for (const [k, v] of Object.entries(x.tool_calls.errors)) errors[k] = (errors[k] ?? 0) + v;
  const costs = r.map((x) => x.cost.total);
  const walls = r.map((x) => x.wall_seconds);
  const tokens = (k: keyof QuestionRecord["tokens"]) => sum(r.map((x) => x.tokens[k]));
  const starts = r.map((x) => Date.parse(x.started_at));
  const ends = r.map((x) => Date.parse(x.started_at) + x.wall_seconds * 1000);
  return {
    status_counts: statusCounts,
    turns: { mean: mean(r.map((x) => x.turns)), median: median(r.map((x) => x.turns)), max: Math.max(...r.map((x) => x.turns)) },
    api_calls: tc((x) => x.api_calls),
    pause_turns: tc((x) => x.pause_turns),
    continue_injections: tc((x) => x.continue_injections),
    tool_calls: {
      web_search: tc((x) => x.tool_calls.web_search + x.tool_calls.web_search_in_code),
      web_search_from_code: tc((x) => x.tool_calls.web_search_in_code),
      web_fetch: tc((x) => x.tool_calls.web_fetch + x.tool_calls.web_fetch_in_code),
      web_fetch_from_code: tc((x) => x.tool_calls.web_fetch_in_code),
      code_execution: tc((x) => x.tool_calls.code_execution),
      edgar_search: tc((x) => x.tool_calls.edgar_search),
      submit_final_result: tc((x) => x.tool_calls.submit_final_result),
      questions_using_edgar_search: r.filter((x) => x.tool_calls.edgar_search > 0).length,
      errors,
    },
    tokens: {
      input_uncached: tokens("input_tokens"),
      cache_read: tokens("cache_read_input_tokens"),
      cache_write: tokens("cache_write_5m_tokens") + tokens("cache_write_1h_tokens"),
      output: tokens("output_tokens"),
      web_search_requests: tokens("web_search_requests"),
      web_fetch_requests: tokens("web_fetch_requests"),
      per_question_mean_total_input: mean(r.map((x) => x.tokens.input_tokens + x.tokens.cache_read_input_tokens + x.tokens.cache_write_5m_tokens + x.tokens.cache_write_1h_tokens)),
      per_question_mean_output: mean(r.map((x) => x.tokens.output_tokens)),
    },
    cost: {
      agent_total: sum(costs),
      per_question_mean: mean(costs),
      per_question_median: median(costs),
      per_question_max: Math.max(...costs),
      breakdown: {
        input: sum(r.map((x) => x.cost.input)),
        output: sum(r.map((x) => x.cost.output)),
        cache_read: sum(r.map((x) => x.cost.cache_read)),
        cache_write: sum(r.map((x) => x.cost.cache_write)),
        web_search: sum(r.map((x) => x.cost.web_search)),
      },
      judge_total: sum(rows.map((x) => x.j.cost.total)),
    },
    wall_time: {
      per_question_mean_s: mean(walls),
      per_question_median_s: median(walls),
      per_question_max_s: Math.max(...walls),
      run_elapsed_min: (Math.max(...ends) - Math.min(...starts)) / 60000,
    },
    fallbacks: {
      questions_with_fallback: r.filter((x) => x.tokens.fallback_iterations > 0 || x.served_by_models.some((m) => m !== MODEL)).length,
      fallback_iterations: sum(r.map((x) => x.tokens.fallback_iterations)),
      served_by: [...new Set(r.flatMap((x) => x.served_by_models))],
    },
  };
}

interface SpotCheck {
  id: string;
  check_index: number;
  my_verdict: "pass" | "fail";
  note: string;
}

function spotCheck(rows: Row[]) {
  const file = path.join(runDir(primary), "spotcheck.json");
  const items = readJson<SpotCheck[]>(file);
  if (!items) return null;
  const out = items.map((s) => {
    const row = rows.find((x) => x.q.id === s.id);
    const c = row?.j.checks[s.check_index];
    return {
      id: s.id,
      check_index: s.check_index,
      operator: c?.operator ?? "?",
      criteria: c?.criteria ?? "?",
      judge_verdict: c?.verdict ?? "?",
      judge_samples: c?.samples.map((x) => x.verdict) ?? [],
      my_verdict: s.my_verdict,
      agree: c?.verdict === s.my_verdict,
      note: s.note,
    };
  });
  return { n: out.length, agree: out.filter((x) => x.agree).length, items: out };
}

const lb = readJson<LeaderboardSnapshot>(LEADERBOARD_FILE);
const runs = runIds.map((id) => ({ id, rows: rowsFor(id) }));
const prim = runs[0]!;
if (!prim.rows.length) throw new Error(`no graded rows for run ${primary} (judge tag ${judgeTag})`);
const primM = runMetrics(prim.rows);
const primOps = opsMetrics(prim.rows);
const perRun = runs.map((x) => ({ run_id: x.id, ...runMetrics(x.rows), cost: opsMetrics(x.rows).cost.agent_total }));

// Repeats: per-question mean correctness over runs that graded that question.
let repeats: unknown = null;
if (runs.length > 1) {
  const ids = prim.rows.map((x) => x.q.id).filter((id) => runs.every((r) => r.rows.some((x) => x.q.id === id)));
  const perQ = ids.map((id) => mean(runs.map((r) => (r.rows.find((x) => x.q.id === id)!.j.all_pass ? 1 : 0))));
  const groups = new Map<string, number[]>();
  ids.forEach((id, i) => {
    const t = qById.get(id)!.type;
    groups.set(t, [...(groups.get(t) ?? []), perQ[i]!]);
  });
  // Bootstrap over questions (each question carries its mean over the runs).
  const all = new Map([["all", perQ]]);
  const ci = stratifiedBootstrap(all);
  repeats = {
    runs: runs.length,
    questions_in_all_runs: ids.length,
    mean_accuracy: mean(perQ),
    question_bootstrap95: [ci.lo, ci.hi],
    mean_class_balanced: classBalanced(groups),
    per_run_accuracy: perRun.map((p) => ({ run_id: p.run_id, n: p.n, accuracy: p.accuracy, class_balanced: p.class_balanced_accuracy })),
    always_correct: perQ.filter((p) => p === 1).length,
    never_correct: perQ.filter((p) => p === 0).length,
    sometimes_correct: perQ.filter((p) => p > 0 && p < 1).length,
  };
}

const ledger = readLedger();
const ledgerByPhase: Record<string, number> = {};
for (const e of ledger) ledgerByPhase[e.phase] = (ledgerByPhase[e.phase] ?? 0) + e.usd;

const v11 = lb?.versions.find((v) => v.key === "v1.1");
const v21 = lb?.versions.find((v) => v.key === "v2.1");
const v2 = lb?.versions.find((v) => v.key === "v2");
const v1 = lb?.versions.find((v) => v.key === "v1");
const typeKey = (t: string) => Object.entries(v11?.task_names ?? {}).find(([, name]) => name === t)?.[0];

const DEVIATIONS = [
  "Search provider: Tavily web_search (date-capped at 2025-04-07, up to 20 results) is replaced by Anthropic's server-side web_search_20260209, which has no date filter; results can include material published after the benchmark's as-of date (the prompt still says to answer as of April 07, 2025).",
  "Document tools: parse_html_page + retrieve_information (key-value store queried by a second call to the same LLM) are replaced by Anthropic's server-side web_fetch_20260209 with dynamic filtering (the model filters fetched pages/PDFs with code before they reach context). web_fetch can only fetch URLs that already appeared in the conversation, unlike parse_html_page.",
  "EDGAR: sec-api.io full-text search is replaced by our edgar_search client tool over SEC's free EDGAR full-text search (efts.sec.gov/LATEST/search-index): same tool name, description, parameters, validation and 2025-04-07 date cap; results are mapped to sec-api-style metadata (accessionNo, cik, companyNameLong, ticker, formType, type, description, filedAt, periodOfReport, filingUrl). EDGAR FTS indexes 2001+ only and its query parser is EDGAR's, not sec-api's.",
  "Prompt: INSTRUCTIONS_PROMPT is sent verbatim as the first user message (no system prompt, as in the official harness) except one paragraph: the data-storage / retrieve_information paragraph is replaced by an equivalent paragraph about web_fetch.",
  `Model settings: ${MODEL}, adaptive thinking (always on), output_config.effort "${AGENT_EFFORT}", max_tokens ${AGENT_MAX_TOKENS}, no temperature (the official CLI default is temperature 0; Vals' Anthropic leaderboard runs list temperature 1.0), streaming, top-level prompt caching, server-side refusal fallbacks (fallbacks: "default").`,
  `Turn limit: ${MAX_TURNS} turns as in run_agent.py, where one turn = one model sampling iteration (usage.iterations), counted across server-side tool loops; the check happens between API calls, so a call already in flight can finish a few iterations past the limit. Text-only replies get "Continue." as in get_agent.py; only submit_final_result ends a question.`,
  `Safety rails not in the official harness: per-question cost cap ${usd(PER_QUESTION_COST_CAP_USD)} and wall-clock cap ${PER_QUESTION_WALL_CAP_S / 60} min (a hit is scored as no answer); SEC requests limited to ${SEC_MAX_REQUESTS_PER_SECOND}/s with the declared User-Agent.`,
  `Judge: ${MODEL} at effort "${JUDGE_EFFORT}" with structured JSON verdicts, one call per rubric check, mode of ${judgeTag.replace(/^s/, "")} samples (Vals v1.1 uses GPT-5.2 as judge and the mode of three; its judge prompt and rounding guidelines are not public, so ours are written from the operator definitions in the Finance Agent paper). Empty answers are graded without a model call (correctness checks fail).`,
  "Metric: a question counts as correct only if all of its rubric checks pass (the paper's conjunction rule). Vals' leaderboard 'Accuracy' for v1/v1.1 is the class-balanced mean of the nine category accuracies on the private 337-question Test set (verified: Opus 4.7's per-category numbers average to its 64.37%); we report naive and class-balanced accuracy on the 50-question public set.",
  "Data split: the public set (50) is not the Test set the leaderboard is computed on; Vals publishes no public-set scores.",
];

// Coverage: every record of the primary run, graded or not (API errors, e.g. exhausted credits, are not graded).
const allRecords = readRecords(primary);
const gradedIds = new Set(prim.rows.map((x) => x.q.id));
const answeredUngraded = allRecords.filter((r) => r.status === "submitted" && !gradedIds.has(r.id)).map((r) => r.id);
const notAnswered = allRecords.filter((r) => r.status !== "submitted").map((r) => ({ id: r.id, type: r.type, status: r.status, error: (r.final_error ?? "").slice(0, 200) }));
const neverRun = questions.filter((q) => !allRecords.some((r) => r.id === q.id)).map((q) => q.id);
const unscored = questions.length - prim.rows.length;
const coverage = {
  questions: questions.length,
  answered: allRecords.filter((r) => r.status === "submitted").length,
  graded: prim.rows.length,
  answered_not_graded: answeredUngraded,
  not_answered: notAnswered,
  never_run: neverRun,
  graded_by_type: Object.fromEntries(TYPES.map((t) => [t, `${prim.rows.filter((x) => x.q.type === t).length}/${questions.filter((q) => q.type === t).length}`])),
  /** Full-set accuracy if every unscored question were wrong / right. */
  full_set_bounds: [primM.correct / questions.length, (primM.correct + unscored) / questions.length],
  reason:
    unscored > 0
      ? "The Anthropic API key ran out of credit during the run (HTTP 400 'Your credit balance is too low'). The questions in flight then failed, and the remaining answers could not be graded. No further API calls were made."
      : null,
};

// First-call latency (time to the first complete response of each question). In the
// first pass, every request after the 8th waited minutes because Node's fetch
// multiplexed all API requests over one HTTP/2 connection (fixed afterwards).
const firstCalls = prim.rows
  .filter((x) => !(x.r as QuestionRecord & { reused_from?: string }).reused_from)
  .map((x) => {
    const t = readJson<{ calls?: { seconds: number }[] }>(path.join(runDir(primary), "transcripts", `${x.q.id}.json`));
    return { id: x.q.id, started: Date.parse(x.r.started_at), s: t?.calls?.[0]?.seconds ?? NaN };
  })
  .filter((x) => Number.isFinite(x.s))
  .sort((a, b) => a.started - b.started);
const latency = {
  first_8_started_median_s: median(firstCalls.slice(0, 8).map((x) => x.s)),
  later_median_s: median(firstCalls.slice(8).map((x) => x.s)),
  n_later: firstCalls.slice(8).length,
};

// web_fetch URL validation vs. our edgar_search output (harness v1 compact JSON):
// classify each fetch of a URL that had appeared only in a client tool result by
// whether it was the last URL of that result.
const URL_RE = /https?:\/\/[^"\\\s]+/g;
function fetchDiagnostics(runId: string) {
  const counts = { last_ok: 0, last_blocked: 0, earlier_ok: 0, earlier_blocked: 0 };
  const blockedByQuestion: Record<string, number> = {};
  for (const r of readRecords(runId)) {
    const t = readJson<{ messages: { role: string; content: unknown }[] }>(path.join(runDir(runId), "transcripts", `${r.id}.json`));
    if (!t) continue;
    const last = new Set<string>();
    const earlier = new Set<string>();
    let other = "";
    for (const m of t.messages) {
      if (typeof m.content === "string") {
        other += m.content;
        continue;
      }
      const blocks = m.content as { type: string; id?: string; name?: string; input?: { url?: string }; tool_use_id?: string; content?: unknown }[];
      if (m.role === "user") {
        for (const b of blocks) {
          if (b.type !== "tool_result" || typeof b.content !== "string") continue;
          const urls = b.content.match(URL_RE) ?? [];
          if (urls.length) {
            last.add(urls[urls.length - 1]!);
            urls.slice(0, -1).forEach((u) => earlier.add(u));
          }
        }
        continue;
      }
      const pending = new Map<string, string>();
      for (const b of blocks) {
        if (b.type === "server_tool_use" && b.name === "web_fetch" && b.id) pending.set(b.id, b.input?.url ?? "");
        else if (b.type === "web_search_tool_result") other += JSON.stringify(b.content);
        else if (b.type === "web_fetch_tool_result") {
          const url = pending.get(b.tool_use_id ?? "") ?? "";
          const c = b.content as { error_code?: string } | null;
          const blocked = c?.error_code === "url_not_in_prior_context";
          const ok = !c?.error_code;
          if (url && !other.includes(url)) {
            if (last.has(url)) ok ? counts.last_ok++ : blocked && counts.last_blocked++;
            else if (earlier.has(url)) {
              if (ok) counts.earlier_ok++;
              else if (blocked) {
                counts.earlier_blocked++;
                blockedByQuestion[r.id] = (blockedByQuestion[r.id] ?? 0) + 1;
              }
            }
          }
          if (ok) other += JSON.stringify(b.content).slice(0, 3_000_000);
        }
      }
    }
  }
  return { ...counts, questions_with_blocked_fetch: Object.keys(blockedByQuestion).length, blocked_by_question: blockedByQuestion };
}
const fetchDiag = fetchDiagnostics(primary);
const blockedIds = new Set(Object.keys(fetchDiag.blocked_by_question));
const blockedRows = prim.rows.filter((x) => blockedIds.has(x.q.id));
const unblockedRows = prim.rows.filter((x) => !blockedIds.has(x.q.id));
const fetchValidation = {
  ...fetchDiag,
  graded_with_blocked_fetch: { n: blockedRows.length, correct: blockedRows.filter((x) => x.j.all_pass).length },
  graded_without: { n: unblockedRows.length, correct: unblockedRows.filter((x) => x.j.all_pass).length },
  harness_versions_in_run: [...new Set(readRecords(primary).map((r) => r.harness_version))],
};

// As-of leakage (see asof-audit.ts): answers that cite / fetch SEC filings filed after the cap.
const asofFile = readJson<{ rows: AsOfAuditRow[] }>(path.join(runDir(primary), "asof-audit.json"));
let asof: null | {
  cited_post_cap: { n: number; correct: number; ids: string[] };
  fetched_post_cap: { n: number; correct: number; ids: string[] };
  rest: { n: number; correct: number };
} = null;
if (asofFile) {
  const pick = (ids: Set<string>) => {
    const rs = prim.rows.filter((x) => ids.has(x.q.id));
    return { n: rs.length, correct: rs.filter((x) => x.j.all_pass).length, ids: rs.map((x) => x.q.id) };
  };
  const cited = new Set(asofFile.rows.filter((r) => r.cited_after_cap.length).map((r) => r.id));
  const fetched = new Set(asofFile.rows.filter((r) => r.fetched_after_cap.length).map((r) => r.id));
  const rest = prim.rows.filter((x) => !cited.has(x.q.id) && !fetched.has(x.q.id));
  asof = { cited_post_cap: pick(cited), fetched_post_cap: pick(fetched), rest: { n: rest.length, correct: rest.filter((x) => x.j.all_pass).length } };
}

const out = {
  title: "Vals AI Finance Agent benchmark (v1.1 public set, 50 questions): Claude Opus 5.5, UNOFFICIAL harness",
  unofficial_harness: true,
  disclaimer:
    "Indicative only, not leaderboard-equivalent: different search provider (Anthropic web search instead of Tavily), different document tools (web_fetch instead of parse_html_page/retrieve_information), our EDGAR tool (SEC full-text search instead of sec-api.io), our judge (Claude Opus 5.5 instead of GPT-5.2), and the public set instead of the private Test set.",
  generated_at: new Date().toISOString(),
  benchmark: {
    repo: "https://github.com/vals-ai/finance-agent",
    commit: "8ba65f81ab759a8e0d44e72aabc5a47cf839d563 (2026-07-21)",
    dataset: "data/public.csv",
    license: "MIT (code), CC BY 4.0 (dataset)",
    questions: questions.length,
    rubric_checks: sum(questions.map((q) => q.rubric.length)),
  },
  config: {
    model: MODEL,
    agent_effort: AGENT_EFFORT,
    agent_max_tokens: AGENT_MAX_TOKENS,
    max_turns: MAX_TURNS,
    tools: ["web_search_20260209 (server)", "web_fetch_20260209 (server, dynamic filtering)", "edgar_search (client, SEC EDGAR FTS)", "submit_final_result (client)"],
    fallbacks: "default (beta server-side-fallback-2026-07-01)",
    as_of_date_cap: MAX_END_DATE,
    judge_model: MODEL,
    judge_effort: JUDGE_EFFORT,
    judge_tag: judgeTag,
    runs: runIds,
  },
  coverage,
  headline: primM,
  repeats,
  per_run: perRun,
  operations: { ...primOps, first_call_latency: latency, web_fetch_url_validation: fetchValidation },
  spend: {
    ledger_total_usd: sum(ledger.map((e) => e.usd)),
    by_phase_usd: ledgerByPhase,
    budget_usd: 60,
  },
  judge_spot_check: spotCheck(prim.rows),
  as_of_leakage: asof,
  leaderboard: lb
    ? {
        fetched_at: lb.fetched_at,
        note: "All leaderboard numbers are on Vals' private Test sets (v1.1: 337 questions; v2/v2.1: 449), not on the public set we ran. v1.1 'Accuracy' is class-balanced across nine categories; v2.1's primary metric is dealbreaker-gated partial credit with a three-model jury, and v2/v2.1 use a different, harder question set and harness (calculator, price_history, 2-hour limit).",
        versions: lb.versions.map((v) => ({
          key: v.key,
          benchmark: v.benchmark,
          updated: v.updated,
          archived: v.archived,
          page_url: v.page_url,
          headline: v.headline,
          top3: v.overall_top.slice(0, 3),
          claude_opus_5_5: v.anthropic_settings["anthropic/claude-opus-5-5"] ?? null,
          claude_opus_5_5_by_task: v.anthropic["anthropic/claude-opus-5-5"] ?? null,
          anthropic_overall: Object.fromEntries(Object.entries(v.anthropic_settings).map(([m, e]) => [m, e.accuracy])),
        })),
        v1_1_per_category_reference: v11
          ? Object.fromEntries(
              TYPES.map((t) => {
                const k = typeKey(t);
                return [t, k ? { "claude-opus-4-7": v11.anthropic["anthropic/claude-opus-4-7"]?.[k] ?? null, "claude-sonnet-4-6": v11.anthropic["anthropic/claude-sonnet-4-6"]?.[k] ?? null } : null];
              }),
            )
          : null,
      }
    : null,
  deviations: DEVIATIONS,
  failures: notAnswered,
  questions: prim.rows.map((x) => ({
    id: x.q.id,
    type: x.q.type,
    question: x.q.question,
    status: x.r.status,
    correct: x.j.all_pass,
    checks_passed: x.j.passed,
    checks_total: x.j.total,
    failed_checks: x.j.checks.filter((c) => c.verdict === "fail").map((c) => ({ index: c.index, operator: c.operator, criteria: c.criteria.length > 160 ? `${c.criteria.slice(0, 157)}...` : c.criteria })),
    turns: x.r.turns,
    tool_calls: {
      web_search: x.r.tool_calls.web_search + x.r.tool_calls.web_search_in_code,
      web_fetch: x.r.tool_calls.web_fetch + x.r.tool_calls.web_fetch_in_code,
      code_execution: x.r.tool_calls.code_execution,
      edgar_search: x.r.tool_calls.edgar_search,
    },
    tokens: { input_total: x.r.tokens.input_tokens + x.r.tokens.cache_read_input_tokens + x.r.tokens.cache_write_5m_tokens + x.r.tokens.cache_write_1h_tokens, output: x.r.tokens.output_tokens },
    cost_usd: Number(x.r.cost.total.toFixed(4)),
    wall_seconds: Math.round(x.r.wall_seconds),
    repeat_results: runs.length > 1 ? runs.map((r) => r.rows.find((y) => y.q.id === x.q.id)?.j.all_pass ?? null) : undefined,
  })),
};

fs.mkdirSync(DOCS_DIR, { recursive: true });
fs.writeFileSync(path.join(DOCS_DIR, "vals-finance-agent.json"), JSON.stringify(out, null, 2) + "\n");

// ---------- markdown ----------
const L: string[] = [];
const m = primM;
L.push(`# Vals AI Finance Agent (v1.1 public set): Claude Opus 5.5, unofficial harness`);
L.push("");
L.push(`> **Unofficial harness.** ${out.disclaimer}`);
L.push("");
L.push(`Generated ${out.generated_at.slice(0, 10)} from \`evals/external/vals-finance-agent/\` (reproduce: see its README). Raw transcripts: \`var/evals/vals-finance-agent/runs/\` (gitignored).`);
L.push("");
if (coverage.reason) {
  L.push(`> **Incomplete coverage: ${m.n} of ${questions.length} questions are graded.** ${coverage.reason} Every score below is on the ${m.n} graded questions only. The graded subset is not stratified: it is the first 45 questions in CSV order minus q039. It under-represents Beat or Miss (${coverage.graded_by_type["Beat or Miss"]} graded) and Market Analysis (${coverage.graded_by_type["Market Analysis"]}). Across the full 50, accuracy would lie between ${pct(coverage.full_set_bounds[0]!)} (all ${unscored} unscored questions wrong) and ${pct(coverage.full_set_bounds[1]!)} (all right).`);
  L.push("");
}
L.push(`## Result`);
L.push("");
L.push(`| Metric | Value |`);
L.push(`|---|---|`);
L.push(`| Coverage (primary pass \`${primary}\`) | **${m.n} of ${questions.length} questions graded.** ${coverage.answered} were answered; ${coverage.answered_not_graded.length} of those were not graded (${coverage.answered_not_graded.join(", ") || "none"}), and ${coverage.not_answered.length} were not answered (${coverage.not_answered.map((x) => x.id).join(", ") || "none"}) |`);
L.push(`| Accuracy (all rubric checks pass) | **${pct(m.accuracy)}** (${m.correct}/${m.n}), 95% Wilson CI ${pct(m.wilson95[0]!)} to ${pct(m.wilson95[1]!)} |`);
L.push(`| Class-balanced accuracy (Vals' leaderboard formula) | ${pct(m.class_balanced_accuracy)}, 95% stratified-bootstrap CI ${pct(m.class_balanced_bootstrap95[0]!)} to ${pct(m.class_balanced_bootstrap95[1]!)} (stderr ${pct(m.class_balanced_stderr)}) |`);
L.push(`| Rubric check pass rate | ${pct(m.rubric_pass_rate)} (${m.rubric_checks.passed}/${m.rubric_checks.total}); correctness ${m.per_operator.correctness.passed}/${m.per_operator.correctness.total}, contradiction ${m.per_operator.contradiction.passed}/${m.per_operator.contradiction.total} |`);
L.push(`| Mean fraction of checks passed per question | ${pct(m.mean_check_fraction)} |`);
if (repeats) {
  const rp = repeats as { runs: number; questions_in_all_runs: number; mean_accuracy: number; question_bootstrap95: number[]; mean_class_balanced: number; per_run_accuracy: { run_id: string; accuracy: number }[]; always_correct: number; never_correct: number; sometimes_correct: number };
  L.push(`| Mean over ${rp.runs} independent passes | ${pct(rp.mean_accuracy)} (passes: ${rp.per_run_accuracy.map((p) => `${p.run_id} ${pct(p.accuracy)}`).join(", ")}), 95% bootstrap CI over questions ${pct(rp.question_bootstrap95[0]!)} to ${pct(rp.question_bootstrap95[1]!)}; class-balanced ${pct(rp.mean_class_balanced)} |`);
  L.push(`| Question stability across passes | ${rp.always_correct} always correct, ${rp.never_correct} never, ${rp.sometimes_correct} mixed |`);
}
L.push(`| Agent cost (primary pass) | ${usd(primOps.cost.agent_total)} total, ${usd(primOps.cost.per_question_mean)} mean / ${usd(primOps.cost.per_question_median)} median / ${usd(primOps.cost.per_question_max)} max per question (web search fees ${usd(primOps.cost.breakdown.web_search)}) |`);
L.push(`| Judge cost (primary pass) | ${usd(primOps.cost.judge_total)} |`);
L.push(`| Total spend, all phases (ledger) | ${usd(out.spend.ledger_total_usd)} of the $60 budget (${Object.entries(ledgerByPhase).map(([k, v]) => `${k} ${usd(v)}`).join(", ")}) |`);
L.push(`| Wall time per question | ${(primOps.wall_time.per_question_mean_s / 60).toFixed(1)} min mean, ${(primOps.wall_time.per_question_median_s / 60).toFixed(1)} median, ${(primOps.wall_time.per_question_max_s / 60).toFixed(1)} max; pass elapsed ${primOps.wall_time.run_elapsed_min.toFixed(0)} min at concurrency 8 |`);
L.push(`| Turns per question | ${primOps.turns.mean.toFixed(1)} mean, ${primOps.turns.median} median, ${primOps.turns.max} max (limit ${MAX_TURNS}) |`);
L.push(`| Tool calls (total / mean per question) | web_search ${primOps.tool_calls.web_search.total} / ${primOps.tool_calls.web_search.mean.toFixed(1)}; web_fetch ${primOps.tool_calls.web_fetch.total} / ${primOps.tool_calls.web_fetch.mean.toFixed(1)}; code execution (dynamic filtering) ${primOps.tool_calls.code_execution.total} / ${primOps.tool_calls.code_execution.mean.toFixed(1)}; edgar_search ${primOps.tool_calls.edgar_search.total} / ${primOps.tool_calls.edgar_search.mean.toFixed(1)} (used in ${primOps.tool_calls.questions_using_edgar_search} questions) |`);
L.push(`| Tokens (primary pass) | ${(primOps.tokens.cache_read / 1e6).toFixed(2)}M cache read, ${(primOps.tokens.cache_write / 1e6).toFixed(2)}M cache write, ${(primOps.tokens.input_uncached / 1e3).toFixed(1)}K uncached input, ${(primOps.tokens.output / 1e6).toFixed(2)}M output; ${primOps.tokens.web_search_requests} web searches, ${primOps.tokens.web_fetch_requests} fetches |`);
L.push(`| Status | ${Object.entries(primOps.status_counts).map(([k, v]) => `${k} ${v}`).join(", ")}; refusal fallbacks used in ${primOps.fallbacks.questions_with_fallback} question(s); served by ${primOps.fallbacks.served_by.join(", ")} |`);
L.push("");
L.push(`## By question type`);
L.push("");
L.push(`| Question type | n | Correct | Accuracy | Check pass rate | Vals v1.1 Test set: Opus 4.7 / Sonnet 4.6 |`);
L.push(`|---|---|---|---|---|---|`);
for (const t of m.per_type) {
  const ref = (out.leaderboard?.v1_1_per_category_reference as Record<string, Record<string, number | null> | null> | null)?.[t.type];
  const refS = ref ? `${ref["claude-opus-4-7"]?.toFixed(1) ?? "-"}% / ${ref["claude-sonnet-4-6"]?.toFixed(1) ?? "-"}%` : "-";
  L.push(`| ${t.type} | ${t.n} | ${t.correct} | ${t.accuracy === null ? "-" : pct(t.accuracy)} | ${t.rubric_pass_rate === null ? "-" : pct(t.rubric_pass_rate)} | ${refS} |`);
}
L.push("");
L.push(`Per-type n is 3 to 9, so per-type accuracies are very noisy (one question moves a 3-question type by 33 points).`);
L.push("");
L.push(`## Leaderboard comparison (fetched ${lb?.fetched_at.slice(0, 10) ?? "n/a"})`);
L.push("");
if (lb) {
  L.push(`Vals publishes results only on private Test sets, never on the public set, so no published number is directly comparable to ours.`);
  L.push("");
  L.push(`| Leaderboard | Updated | Leader(s) | Claude Opus 5.5 | Comparable to this run? |`);
  L.push(`|---|---|---|---|---|`);
  const row = (v: typeof v11, comp: string) => {
    if (!v) return;
    const o = v.anthropic_settings["anthropic/claude-opus-5-5"];
    L.push(
      `| [${v.benchmark}](${v.page_url})${v.archived ? " (archived)" : ""} | ${v.updated} | ${v.overall_top.slice(0, 3).map((t) => `${t.model.split("/")[1]} ${t.accuracy.toFixed(2)}%`).join("; ")} | ${o ? `${o.accuracy?.toFixed(2)}% (effort ${o.compute_effort}, ${usd(o.cost_per_test ?? 0)}/test, ${((o.latency ?? 0) / 60).toFixed(0)} min/test)` : "not listed"} | ${comp} |`,
    );
  };
  row(v11, "Closest: same harness design, taxonomy and grading as the public set we ran, but Test set (337 Q), GPT-5.2 judge, Tavily + sec-api tools");
  row(v21, "No: different questions (v2), harness (adds calculator, price_history; 2 h limit), dealbreaker-gated partial credit, 3-model jury");
  row(v2, "No: v2 question set and harness");
  row(v1, "No: older harness (SerpAPI, no submit tool)");
  L.push("");
  const o21 = v21?.anthropic["anthropic/claude-opus-5-5"];
  if (o21) L.push(`On v2.1, Claude Opus 5.5's all-pass score (closest to our all-checks metric) is ${o21.all_pass?.toFixed(2)}% versus ${o21.overall?.toFixed(2)}% partial credit.`);
  const v11Anth = v11 ? Object.entries(v11.anthropic_settings).map(([k, e]) => `${k.split("/")[1]} ${e.accuracy?.toFixed(2)}% (effort ${e.compute_effort ?? "n/a"}, ${usd(e.cost_per_test ?? 0)}/test)`).join("; ") : "";
  if (v11Anth) L.push(`Anthropic models on v1.1: ${v11Anth}. Claude Opus 5.5 is not listed on v1.1 (last updated ${v11?.updated}).`);
  L.push("");
}
L.push(`## Deviations from the official protocol`);
L.push("");
for (const d of DEVIATIONS) L.push(`- ${d}`);
L.push("");
L.push(`## Judge spot-check`);
L.push("");
const sc = out.judge_spot_check;
if (sc) {
  L.push(`I re-graded ${sc.n} judge decisions by hand (question, criterion and answer only). Agreement: **${sc.agree}/${sc.n}**.`);
  L.push("");
  L.push(`| Question | Check | Judge (samples) | Mine | Note |`);
  L.push(`|---|---|---|---|---|`);
  for (const s of sc.items) L.push(`| ${s.id} | #${s.check_index} ${s.operator}: ${s.criteria.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 90)} | ${s.judge_verdict} (${s.judge_samples.join(",")}) | ${s.my_verdict} | ${s.note.replace(/\|/g, "/")} |`);
} else L.push(`No spot-check file yet (${path.join(runDir(primary), "spotcheck.json")}).`);
L.push("");
L.push(`## Failures and anomalies`);
L.push("");
if (notAnswered.length) {
  L.push(`- Not answered: ${notAnswered.map((f) => `${f.id} (${f.type}, ${f.status})`).join(", ")}. The cause was the API key running out of credit (HTTP 400 "Your credit balance is too low to access the Anthropic API"); these are infrastructure failures, not model failures, so they are left out of the score instead of counted as wrong.`);
}
if (answeredUngraded.length) L.push(`- Answered but not graded (the judge needs the same API key): ${answeredUngraded.join(", ")}.`);
if (fetchValidation.earlier_blocked > 0) {
  L.push(
    `- **Harness defect (v1, this pass): most EDGAR filings could not be fetched.** edgar_search returned compact, whitespace-free JSON. For URLs that appeared only in an edgar_search result, web_fetch accepted the last URL of that result (${fetchValidation.last_ok}/${fetchValidation.last_ok + fetchValidation.last_blocked} fetches succeeded) and rejected every earlier one as url_not_in_prior_context (${fetchValidation.earlier_blocked}/${fetchValidation.earlier_blocked + fetchValidation.earlier_ok}). ` +
      `${fetchValidation.questions_with_blocked_fetch} of 50 questions hit at least one blocked fetch. The agent usually recovered through web search, so these answers were still scored, but this likely understates the agent's accuracy. ` +
      `Graded accuracy was ${fetchValidation.graded_with_blocked_fetch.correct}/${fetchValidation.graded_with_blocked_fetch.n} with a blocked fetch and ${fetchValidation.graded_without.correct}/${fetchValidation.graded_without.n} without; this split is correlational. ` +
      `Fix (harness v2, not yet run because of the credit outage): results are now serialised like the official tool's Python json.dumps output (", " separators).`,
  );
}
if (prim.rows.some((x) => x.q.id === "q001" && !x.j.all_pass)) {
  L.push(`- q001 (US Steel / Nippon Steel): the expected answer and rubric include facts from the deal's mid-2025 completion (a U.S. golden share, the $14B / $11B-by-2028 investment pledge, the up-to-$4B new mill). Those postdate the benchmark's April 07, 2025 as-of date, so an answer that respects the date fails 7 of its 9 checks.`);
}
L.push(
  `- Wall times in this pass are inflated. The median time to a question's first response was ${latency.first_8_started_median_s.toFixed(0)} s for the first 8 questions started and ${latency.later_median_s.toFixed(0)} s for the ${latency.n_later} after them. Node 26's fetch sent every API request over one HTTP/2 connection, so new requests queued behind the long streaming turns; a probe in a fresh process took about 2 s. The harness now uses separate HTTP/1.1 sockets for the API. Token, cost and accuracy figures are unaffected.`,
);
const gradedFailures = prim.rows.filter((x) => x.r.status !== "submitted");
if (!gradedFailures.length) L.push(`- Every graded question ended with a submit_final_result call: no turn-limit, cost or time cap, refusal, or fallback hits.`);
const errs = primOps.tool_calls.errors;
if (Object.keys(errs).length) L.push(`- Tool errors returned to the agent: ${Object.entries(errs).map(([k, v]) => `${k} x${v}`).join(", ")}.`);
L.push("");
if (asof) {
  L.push(
    `- As-of leakage (no date filter on web_search): ${asof.fetched_post_cap.n} answers fetched, and ${asof.cited_post_cap.n} cited, at least one SEC filing filed after ${MAX_END_DATE}. ` +
      `Accuracy was ${asof.cited_post_cap.correct}/${asof.cited_post_cap.n} among the citing answers vs ${asof.rest.correct}/${asof.rest.n} among answers that neither fetched nor cited one. The official harness caps both search tools at that date.`,
  );
}
L.push("");
L.push(`## Per question (primary pass)`);
L.push("");
L.push(`| ID | Type | Correct | Checks | Turns | Search / Fetch / Code / EDGAR | Cost | Min | Failed checks |`);
L.push(`|---|---|---|---|---|---|---|---|---|`);
for (const q of out.questions) {
  const fails = q.failed_checks.map((c) => `#${c.index} ${c.operator === "contradiction" ? "contradiction" : c.criteria.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 60)}`).join("; ");
  L.push(`| ${q.id} | ${q.type} | ${q.correct ? "yes" : "no"}${q.repeat_results ? ` (${q.repeat_results.map((r) => (r === null ? "-" : r ? "Y" : "N")).join("")})` : ""} | ${q.checks_passed}/${q.checks_total} | ${q.turns} | ${q.tool_calls.web_search} / ${q.tool_calls.web_fetch} / ${q.tool_calls.code_execution} / ${q.tool_calls.edgar_search} | ${usd(q.cost_usd)} | ${(q.wall_seconds / 60).toFixed(1)} | ${fails || "-"} |`);
}
L.push("");
fs.writeFileSync(path.join(DOCS_DIR, "vals-finance-agent.md"), L.join("\n"));
console.log(`wrote ${path.join(DOCS_DIR, "vals-finance-agent.md")} and .json`);
console.log(`primary ${primary}: ${m.correct}/${m.n} = ${pct(m.accuracy)} [${pct(m.wilson95[0]!)}, ${pct(m.wilson95[1]!)}], class-balanced ${pct(m.class_balanced_accuracy)}, check pass ${pct(m.rubric_pass_rate)}`);
