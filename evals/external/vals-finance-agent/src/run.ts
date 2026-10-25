// Runs the agent on a set of public questions, with a ledger-wide budget guard.
// Usage (from the autonomous-finance repo root):
//   npx tsx evals/external/vals-finance-agent/src/run.ts --run-id pilot --ids q003,q010,q026 --concurrency 3
//   npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --all --concurrency 6
//   npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --stratified 30 --seed 1
// Flags: --hard-budget USD (default 60, all phases, from the ledger), --reserve USD
// kept back for judging (default 8), --est USD per-question estimate before any
// question finishes (default 2), --reuse-from RUN_ID (copy finished records of the
// same harness version instead of re-running them), --force (re-run finished ids).
import fs from "node:fs";
import { parseArgs, num } from "./args";
import { runAgent } from "./agent";
import { httpStats } from "./env";
import { MODEL, AGENT_EFFORT, MAX_TURNS } from "./config";
import { loadQuestions, type BenchQuestion } from "./dataset";
import { stratifiedSubset } from "./select";
import {
  HARNESS_VERSION,
  appendLedger,
  ledgerTotal,
  readJson,
  readRecords,
  recordPath,
  runDir,
  transcriptPath,
  writeJson,
  type QuestionRecord,
} from "./store";

const args = parseArgs(process.argv.slice(2));
const runId = typeof args["run-id"] === "string" ? args["run-id"] : "";
if (!runId) throw new Error("--run-id is required");
const concurrency = num(args.concurrency, 4);
const hardBudget = num(args["hard-budget"], 60);
const reserve = num(args.reserve, 8);
const estDefault = num(args.est, 2);
const force = args.force === true;
const reuseFrom = typeof args["reuse-from"] === "string" ? args["reuse-from"] : undefined;

const all = loadQuestions();
let selected: BenchQuestion[];
if (typeof args.ids === "string") {
  const ids = new Set(args.ids.split(","));
  selected = all.filter((q) => ids.has(q.id));
  if (selected.length !== ids.size) throw new Error(`unknown ids in --ids ${args.ids}`);
} else if (args.all === true) {
  selected = all;
} else if (args.stratified !== undefined) {
  const prefer = new Set(
    typeof args.prefer === "string" ? args.prefer.split(",") : [],
  );
  selected = stratifiedSubset(all, num(args.stratified, 30), num(args.seed, 1), prefer);
} else {
  throw new Error("one of --ids, --all or --stratified N is required");
}

writeJson(`${runDir(runId)}/run-${Date.now()}.json`, {
  run_id: runId,
  started_at: new Date().toISOString(),
  model: MODEL,
  effort: AGENT_EFFORT,
  max_turns: MAX_TURNS,
  harness_version: HARNESS_VERSION,
  ids: selected.map((q) => q.id),
  argv: process.argv.slice(2),
});

/** A record counts as finished unless it ended on an API error (e.g. exhausted credits), which a resume re-runs. */
function finished(id: string): QuestionRecord | undefined {
  const r = readJson<QuestionRecord>(recordPath(runId, id));
  return r && r.harness_version === HARNESS_VERSION && r.status !== "api_error" ? r : undefined;
}

// Never mix harness versions inside one run directory (a v1 pass is finished with
// EDGAR_RESULT_FORMAT=compact; the fixed v2 harness gets its own --run-id).
const otherVersions = [...new Set(readRecords(runId).map((r) => r.harness_version))].filter((v) => v !== HARNESS_VERSION);
if (otherVersions.length && !force) {
  throw new Error(
    `run ${runId} holds harness v${otherVersions.join(",")} records but this process is v${HARNESS_VERSION}. ` +
      `Use a new --run-id, or set EDGAR_RESULT_FORMAT=compact to continue a v1 run.`,
  );
}

const queue: BenchQuestion[] = [];
for (const q of selected) {
  if (!force && finished(q.id)) continue;
  if (reuseFrom && !force) {
    const prev = readJson<QuestionRecord>(recordPath(reuseFrom, q.id));
    if (prev && prev.harness_version === HARNESS_VERSION) {
      writeJson(recordPath(runId, q.id), { ...prev, run_id: runId, reused_from: reuseFrom });
      const t = readJson<unknown>(transcriptPath(reuseFrom, q.id));
      if (t) writeJson(transcriptPath(runId, q.id), t);
      console.log(`${q.id} reused from ${reuseFrom} (${prev.status}, $${prev.cost.total.toFixed(2)})`);
      continue;
    }
  }
  queue.push(q);
}

console.log(
  `run ${runId}: ${selected.length} selected, ${queue.length} to run, concurrency ${concurrency}; ` +
    `ledger so far $${ledgerTotal().toFixed(2)} of hard budget $${hardBudget} (reserve $${reserve} for judging)`,
);

const done: QuestionRecord[] = [];
let inFlight = 0;
let stoppedForBudget = false;

function estimatePerQuestion(): number {
  if (done.length === 0) return estDefault;
  return done.reduce((a, r) => a + r.cost.total, 0) / done.length;
}

async function worker(workerId: number) {
  for (;;) {
    const q = queue.shift();
    if (!q) return;
    const projected = ledgerTotal() + (inFlight + 1) * estimatePerQuestion() + reserve;
    if (projected > hardBudget) {
      stoppedForBudget = true;
      queue.unshift(q);
      console.log(`[w${workerId}] budget guard: projected $${projected.toFixed(2)} > $${hardBudget}; not starting ${q.id}`);
      return;
    }
    inFlight++;
    const startedAt = new Date().toISOString();
    console.log(`[w${workerId}] start ${q.id} (${q.type})`);
    try {
      const { record, messages } = await runAgent(q.question, {
        onCall: (log, running) => {
          appendLedger({ phase: "agent", run_id: runId, id: q.id, usd: log.cost_usd, note: `call ${log.index}` });
          const u = log.usage;
          console.log(
            `  ${q.id} call ${log.index}: ${log.stop_reason} it=${log.iterations} in=${u.input_tokens} cr=${u.cache_read_input_tokens ?? 0} cw=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens} ` +
              `ws=${u.server_tool_use?.web_search_requests ?? 0} wf=${u.server_tool_use?.web_fetch_requests ?? 0} $${log.cost_usd.toFixed(3)} (q total $${running.total.toFixed(2)}) ${log.seconds.toFixed(0)}s` +
              (log.model !== MODEL ? ` SERVED-BY ${log.model}` : ""),
          );
        },
      });
      const full: QuestionRecord = {
        id: q.id,
        type: q.type,
        question: q.question,
        run_id: runId,
        started_at: startedAt,
        harness_version: HARNESS_VERSION,
        ...record,
      };
      writeJson(transcriptPath(runId, q.id), { id: q.id, messages, calls: record.calls });
      writeJson(recordPath(runId, q.id), { ...full, calls: undefined });
      done.push(full);
      console.log(
        `[w${workerId}] done ${q.id}: ${record.status} turns=${record.turns} tools=${JSON.stringify({ ws: record.tool_calls.web_search + record.tool_calls.web_search_in_code, wf: record.tool_calls.web_fetch + record.tool_calls.web_fetch_in_code, ce: record.tool_calls.code_execution, edgar: record.tool_calls.edgar_search })} ` +
          `$${record.cost.total.toFixed(2)} ${(record.wall_seconds / 60).toFixed(1)}min | ledger $${ledgerTotal().toFixed(2)}`,
      );
    } catch (err) {
      console.error(`[w${workerId}] ${q.id} crashed:`, err);
    } finally {
      inFlight--;
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, (_, i) => worker(i + 1)));
const cost = done.reduce((a, r) => a + r.cost.total, 0);
console.log(
  `finished ${done.length} question(s) in ${((Date.now() - t0) / 60000).toFixed(1)} min, agent cost this invocation $${cost.toFixed(2)}, ` +
    `ledger total $${ledgerTotal().toFixed(2)}; API HTTP statuses ${JSON.stringify(httpStats.byStatus)}${stoppedForBudget ? `; STOPPED by budget guard with ${queue.length} left` : ""}`,
);
if (queue.length) fs.writeFileSync(`${runDir(runId)}/not-run.txt`, queue.map((q) => q.id).join("\n") + "\n");
