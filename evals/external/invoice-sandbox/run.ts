// One benchmark run: fresh workspace (benchmark's reset_env.py) -> local pypdf text extraction ->
// System A, B or C -> official scorer + extended metrics.
//   npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-r1
//   npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-r1 --sample 1
//   npx tsx evals/external/invoice-sandbox/run.ts --system c --run-id c-r1   (our system; needs the local Convex backend)
// Options: --effort (A, default high) --max-turns (A, default 40) --run-cap (USD, A 5 / B 4)
//          --extract-effort (B, default low) --adjudicate-effort (B, default high) --sample (B, default 1)
//          --limit-docs N (B pilot only: extract only the first N documents; output is not scored)
//          --offline (B: no API calls; cached extractions/adjudications only, the rest held for review)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BENCH_DIR, BENCH_PYTHON, HARNESS_DIR, runPaths } from "./lib/config";
import { MODEL, spent, USE_FALLBACKS, type Effort } from "./lib/llm";
import { Workspace } from "./lib/workspace";
import { runSystemA } from "./system-a";
import { runSystemB } from "./system-b";
import { runSystemC } from "./system-c";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const system = (flag("system") ?? "").toLowerCase();
const runId = flag("run-id");
if (!runId || !["a", "b", "c"].includes(system)) {
  console.error("usage: run.ts --system a|b|c --run-id <id> [options]");
  process.exit(2);
}

const p = runPaths(runId);
if (!fs.existsSync(p.workspace)) {
  execFileSync(BENCH_PYTHON, ["-I", path.join(BENCH_DIR, "scripts/reset_env.py"), "--run-id", runId, "--fresh"], { cwd: BENCH_DIR, stdio: "inherit" });
} else if (!args.includes("--reuse-workspace")) {
  console.error(`${p.workspace} exists; pick a new --run-id (fresh workspace per run) or pass --reuse-workspace`);
  process.exit(2);
}
if (!fs.existsSync(path.join(p.textCache, "_manifest.json"))) {
  execFileSync(BENCH_PYTHON, ["-I", path.join(HARNESS_DIR, "extract_text.py"), p.workspace, p.textCache], { stdio: "inherit" });
}
fs.mkdirSync(p.out, { recursive: true });

const ws = new Workspace(p.workspace, p.textCache);
const before = spent((e) => e.run_id === runId);
const started = Date.now();
const meta: Record<string, unknown> = { run_id: runId, system: system.toUpperCase(), model: MODEL, fallbacks: USE_FALLBACKS, started_at: new Date().toISOString() };

if (system === "a") {
  const effort = (flag("effort", "high") as Effort)!;
  const maxTurns = Number(flag("max-turns", "40"));
  const runCap = Number(flag("run-cap", "5"));
  Object.assign(meta, { effort, max_turns: maxTurns, run_cap_usd: runCap });
  const r = await runSystemA({ runId, ws, outDir: p.out, effort, maxTurns, runCapUsd: runCap });
  Object.assign(meta, { result: r });
  console.log(`A ${runId}: ${r.status} after ${r.turns} turns, ${r.toolCalls} tool calls, $${r.costUsd.toFixed(3)}, ${(r.wallMs / 1000).toFixed(0)}s${r.error ? ` (${r.error})` : ""}`);
} else if (system === "c") {
  const runCap = Number(flag("run-cap", "3"));
  const timeoutMin = Number(flag("timeout-min", "30"));
  Object.assign(meta, { run_cap_usd: runCap, timeout_min: timeoutMin, claude: process.env.AGENT_LLM !== "off" });
  const r = await runSystemC({ runId, ws, outDir: p.out, runCapUsd: runCap, timeoutMs: timeoutMin * 60_000, verbose: args.includes("--verbose") });
  Object.assign(meta, { result: r });
  console.log(`C ${runId}: ${r.status}; ${r.documents} docs, ${r.tasks} agent tasks (${r.llm_tasks} used Claude), ${r.parsers_learned} parser(s) learned, ${r.undisposed_documents} without a disposition, ${r.kernel_blocks} kernel blocks, $${r.cost_usd.toFixed(3)}, ${(r.wall_ms / 1000).toFixed(0)}s`);
} else {
  const sample = flag("sample", "1")!;
  const extractEffort = (flag("extract-effort", "low") as Effort)!;
  const adjudicateEffort = (flag("adjudicate-effort", "high") as Effort)!;
  const runCap = Number(flag("run-cap", "4"));
  const limit = flag("limit-docs");
  const offline = args.includes("--offline");
  Object.assign(meta, { sample, extract_effort: extractEffort, adjudicate_effort: adjudicateEffort, run_cap_usd: runCap, ...(limit ? { limit_docs: Number(limit) } : {}), ...(offline ? { offline: true } : {}) });
  const r = await runSystemB({ runId, ws, outDir: p.out, sample, extractEffort, adjudicateEffort, runCapUsd: runCap, ...(limit ? { limitDocs: Number(limit) } : {}), ...(offline ? { offline: true } : {}) });
  Object.assign(meta, { result: r });
  console.log(
    `B ${runId}: ${r.status}; ${r.documents} docs, ${r.extractionCacheHits} cache hits, ${r.retries} re-extractions, ${r.adjudications} adjudications, $${r.costUsd.toFixed(3)}, ${(r.wallMs / 1000).toFixed(0)}s${r.error ? ` (${r.error})` : ""}`,
  );
}

meta.wall_ms = Date.now() - started;
meta.cost_usd = spent((e) => e.run_id === runId) - before;
meta.total_spent_all_runs_usd = spent();
fs.writeFileSync(path.join(p.out, "run_meta.json"), JSON.stringify(meta, null, 2) + "\n");
if (!flag("limit-docs") && fs.existsSync(path.join(p.out, "submission.csv"))) {
  execFileSync(BENCH_PYTHON, ["-I", path.join(HARNESS_DIR, "score.py"), BENCH_DIR, p.out], { stdio: "inherit" });
}
console.log(`spend: this run $${(meta.cost_usd as number).toFixed(3)}, all runs $${(meta.total_spent_all_runs_usd as number).toFixed(3)}`);
