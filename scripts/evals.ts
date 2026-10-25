// Run every eval in sequence and print one summary table.
//   npm run evals                                 free: no model calls
//   npm run evals -- --paid --budget-usd N        also the model evals, at most $N in total
// Free: control tests, the simulated world with the model off (seed 7), the spreadsheet-vs-kernel
// timing benchmark, and the external benchmarks in rules-only mode (both batches).
// Paid: the world on 4 seeds, the agent spreadsheet comparison, and full team vs generalist on
// all 15 external tasks. Needs the backend (npm run backend + npm run backend:configure).
// Each run's output lands in var/evals/suite-<stamp>/; the table in var/evals/summary-<stamp>.md.
import "../src/core/env";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL_POLICY, loadModelPolicy } from "../src/evals/external/models";
import { SPEND_FILE } from "../src/agents/llm";
import { checkBackend } from "./lib/backend";
import {
  ALL_EXTERNAL, approvedPolicy, EVALS_USAGE, EXTERNAL_MAX_TURNS, externalMaxRequests, formatTable, MEASURED_USD,
  paidTotal, parseEvalArgs, requestCeilingUsd, splitBudget, WORLD_SEEDS, type EvalArgs,
} from "./lib/evals-plan";

const fail = (msg: string): never => { console.error(`\nevals stopped: ${msg}`); process.exit(1); };
let opts: EvalArgs;
try { opts = parseEvalArgs(process.argv.slice(2)); } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
const args = opts!;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outRoot = path.join("var", "evals", `suite-${stamp}`);
const runTag = Date.now().toString(36);
type Row = { name: string; status: string; result: string; seconds: number; costUsd?: number };
const rows: Row[] = [];
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const spentUsd = () => (fs.existsSync(SPEND_FILE) ? readJson<{ spentMicros: number }>(SPEND_FILE).spentMicros / 1e6 : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Free steps run with inference disabled, even when a model key is configured. */
const FREE = { AGENT_LLM: "off" };

/** Run one eval as a child process, streaming its output to the terminal and to a log file. */
function step(name: string, script: string, scriptArgs: string[], env: Record<string, string> = {}): Promise<{ code: number | null; seconds: number; log: string }> {
  const log = path.join(outRoot, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`);
  console.log(`\n=== ${name}\n$ ${script} ${scriptArgs.join(" ")}`);
  const started = Date.now();
  return new Promise((resolve) => {
    const out = fs.createWriteStream(log);
    const child = spawn(process.execPath, ["--import", "tsx", script, ...scriptArgs], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const tee = (chunk: Buffer, to: NodeJS.WriteStream) => { to.write(chunk); out.write(chunk); };
    child.stdout.on("data", (c: Buffer) => tee(c, process.stdout));
    child.stderr.on("data", (c: Buffer) => tee(c, process.stderr));
    child.on("close", (code) => out.end(() => resolve({ code, seconds: (Date.now() - started) / 1000, log: fs.readFileSync(log, "utf8") })));
  });
}
const crashed = (name: string, r: { code: number | null; seconds: number }, why = `exit ${r.code}`) =>
  rows.push({ name, status: "ERROR", result: `${why}; see ${outRoot}/`, seconds: r.seconds });

// ---------- preflight ----------
const policy = loadModelPolicy(DEFAULT_MODEL_POLICY);
if (args.paid && !process.env.OPENAI_API_KEY?.trim()) fail("--paid needs OPENAI_API_KEY in .env.local (or the environment). Nothing was run.");
if (args.paid && process.env.AGENT_LLM === "off") fail("--paid with AGENT_LLM=off would make no model calls. Unset AGENT_LLM.");
const backend = await checkBackend();
if (!backend.ok) fail(backend.reason);
for (const batch of ["finance-eight", "finance-extra"]) {
  if (!fs.existsSync(path.join("var", "benchmarks", batch, "provenance.json"))) fail(`benchmark batch ${batch} is not prepared; run npm run setup.`);
}
fs.mkdirSync(outRoot, { recursive: true });

let shares: ReturnType<typeof splitBudget> | undefined;
let policyFile: string | undefined;
if (args.paid) {
  shares = splitBudget(args.budgetUsd);
  const agentCeiling = requestCeilingUsd(policy.agent), judgeCeiling = requestCeilingUsd(policy.judge);
  // Free, no model calls: the spreadsheet agent's own plan and estimate.
  const plan = await step("Spreadsheet agent cost plan", "src/evals/spreadsheet/agent.ts", ["--dry-run"], { AGENT_PROVIDER: "openai" });
  const sheetsExpected = Number(/Expected total ~\$([\d.]+)/.exec(plan.log)?.[1] ?? MEASURED_USD.sheetsAgent);
  console.log(`
Paid plan, budget $${args.budgetUsd.toFixed(2)} (allotted $${paidTotal(shares).toFixed(2)}). Each run stops at its cap; a stopped run keeps partial results.

| Run | Expected | Cap |
|---|---:|---:|
${WORLD_SEEDS.map((s) => `| World, seed ${s}, model on (${process.env.AGENT_MODEL ?? "gpt-6.1-sol"}) | ~$${MEASURED_USD.worldPerSeed.toFixed(2)} (measured) | $${shares!.worldPerSeed.toFixed(2)} |`).join("\n")}
| Spreadsheet agent comparison (kernel vs spreadsheet tools) | ~$${sheetsExpected.toFixed(2)} (planner estimate; measured $${MEASURED_USD.sheetsAgent.toFixed(2)}) | $${shares.sheetsAgent.toFixed(2)} |
| External: full team vs generalist, 15 tasks, ${EXTERNAL_MAX_TURNS} turns, APEX judge | ~$${MEASURED_USD.external.toFixed(2)} agents (measured) plus judge | $${shares.external.toFixed(2)} |

External requests reserve their worst case before dispatch: $${agentCeiling.toFixed(2)} per ${policy.agent.model} call, $${judgeCeiling.toFixed(2)} per ${policy.judge.model} judge call, at most ${externalMaxRequests()} requests.`);
  const expectedTotal = MEASURED_USD.worldPerSeed * WORLD_SEEDS.length + sheetsExpected + MEASURED_USD.external;
  if (args.budgetUsd < expectedTotal * 1.5) console.log(`Note: $${args.budgetUsd.toFixed(2)} is under 1.5x the expected $${expectedTotal.toFixed(2)}; some runs may stop at their cap before finishing.`);
  // One-time approval for this invocation only. PaidBudget claims it once (adjacent .usage.json).
  policyFile = path.join("var", `external-models.evals-${stamp}.json`);
  fs.writeFileSync(policyFile, `${JSON.stringify(approvedPolicy(policy, shares.external, `npm run evals -- --paid --budget-usd ${args.budgetUsd}`), null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote the one-time approved benchmark policy ${policyFile} (cap $${shares.external.toFixed(2)}).`);
}

// ---------- free ----------
{
  const name = "Control tests";
  const r = await step(name, "scripts/control-tests.ts", ["--out", outRoot], FREE);
  const file = path.join(outRoot, "control-tests.json");
  if (!fs.existsSync(file)) crashed(name, r);
  else {
    const c = readJson<{ held: number; total: number; results: { id: string; held: boolean }[] }>(file);
    const broken = c.results.filter((x) => !x.held).map((x) => x.id);
    rows.push({ name, status: c.held === c.total ? "pass" : "FAIL", result: `${c.held}/${c.total} controls held${broken.length ? `; broken: ${broken.join(", ")}` : ""}`, seconds: r.seconds });
  }
}

async function worldRun(name: string, seed: number, env: Record<string, string>, label: string) {
  const runId = `evals-${label}-s${seed}-${runTag}`;
  const r = await step(name, "src/evals/main.ts", ["--seed", String(seed), "--stores", "3", "--days", "14", "--run", runId], env);
  const file = path.join("var", "evals", `${runId}.json`);
  if (!fs.existsSync(file)) return crashed(name, r);
  const w = readJson<{ summary: { caught: number; planted: number; decoysCorrect: number; decoys: number; falseAlarmCount: number }; booksStatus: { status: string }; coverage: { unresolvedDocuments: number }; cost: { costUsd: number } }>(file);
  const s = w.summary;
  const modelOff = env.AGENT_LLM === "off";
  const status = s.caught === s.planted && s.falseAlarmCount === 0 && (w.booksStatus.status === "passed" || modelOff) ? "pass" : "FAIL";
  const books = w.booksStatus.status === "passed" ? "books correct" : `books ${w.booksStatus.status}${modelOff ? ` (expected with the model off: ${w.coverage.unresolvedDocuments} invoices unread)` : ""}`;
  rows.push({ name, status, result: `${s.caught}/${s.planted} planted errors caught, ${s.decoysCorrect}/${s.decoys} look-alikes left alone, ${s.falseAlarmCount} false alarms; ${books}`, seconds: r.seconds, costUsd: w.cost.costUsd });
}
await worldRun("World, seed 7, model off", 7, FREE, "free");

{
  const name = "Spreadsheet vs kernel benchmark (no model)";
  const dir = path.join(outRoot, "sheets-bench");
  const r = await step(name, "src/evals/spreadsheet/bench.ts", ["--out", dir], FREE);
  const file = path.join(dir, "spreadsheet-vs-kernel.json");
  if (!fs.existsSync(file)) crashed(name, r);
  else {
    const b = readJson<{ actions: Record<"kernel" | "spreadsheet", { actionsPerOp: number }>; timing: Record<string, { allOps: { medianMs: number } }>; injectedSummary: { cases: number; kernel: { missed: number }; spreadsheet: { prevented: number; detected: number; missed: number } } }>(file);
    const inj = b.injectedSummary;
    rows.push({ name, status: inj.kernel.missed === 0 ? "pass" : "FAIL", seconds: r.seconds,
      result: `tool calls per op ${b.actions.kernel.actionsPerOp} vs ${b.actions.spreadsheet.actionsPerOp}; median ${b.timing.kernel!.allOps.medianMs} vs ${b.timing.spreadsheet_saved!.allOps.medianMs} ms/op; bad ops: kernel stopped ${inj.cases - inj.kernel.missed}/${inj.cases}, workbook missed ${inj.spreadsheet.missed}` });
  }
}

type ExternalResult = { mode: string; benchmark: string; status: string; grade: { status: string; score: number | null; passed: boolean | null; judgeUsage: { costMicros: number } }; usage: { costMicros: number } };
function externalRows(dir: string, label: string, seconds: number) {
  const results = readJson<ExternalResult[]>(path.join(dir, "results.json"));
  for (const mode of [...new Set(results.map((x) => x.mode))]) {
    const rs = results.filter((x) => x.mode === mode);
    const graded = rs.filter((x) => x.grade.score !== null);
    const mean = graded.length ? graded.reduce((s, x) => s + x.grade.score!, 0) / graded.length : 0;
    const ungraded = rs.length - graded.length;
    const errors = rs.filter((x) => x.status === "error" || x.grade.status === "error").length;
    const cost = rs.reduce((s, x) => s + x.usage.costMicros + x.grade.judgeUsage.costMicros, 0) / 1e6;
    rows.push({ name: `${label}: ${mode}`, status: errors ? "FAIL" : "pass", seconds: seconds / ([...new Set(results.map((x) => x.mode))].length), costUsd: cost,
      result: `${rs.filter((x) => x.grade.passed).length}/${rs.length} fully correct; mean ${pct(mean)} over ${graded.length} graded${ungraded ? ` (${ungraded} APEX answers ungraded: judge off)` : ""}${errors ? `; ${errors} errors` : ""}` });
  }
}
{
  const name = "External benchmarks, rules only";
  const dir = path.join(outRoot, "external-rules");
  const r = await step(name, "src/evals/external/main.ts", ["run", "--tasks", ALL_EXTERNAL, "--modes", "rules-only", "--repeats", "1", "--judge", "off", "--run", dir], FREE);
  if (!fs.existsSync(path.join(dir, "results.json"))) crashed(name, r);
  else externalRows(dir, "External (15 tasks)", r.seconds);
}

// ---------- paid ----------
if (args.paid && shares && policyFile) {
  for (const seed of WORLD_SEEDS) {
    // AGENT_MAX_USD is a running total in var/agent-spend.json, so cap this run at what's spent so far plus its share.
    await worldRun(`World, seed ${seed}, model on`, seed, { AGENT_PROVIDER: "openai", AGENT_MAX_USD: String(spentUsd() + shares.worldPerSeed) }, "paid");
  }
  {
    const name = "Spreadsheet agent comparison (model)";
    const r = await step(name, "src/evals/spreadsheet/agent.ts", ["--confirm-usd", String(shares.sheetsAgent)], { AGENT_PROVIDER: "openai" });
    const file = /wrote (\S+report\.json)/.exec(r.log)?.[1];
    if (!file || !fs.existsSync(file)) crashed(name, r);
    else {
      const a = readJson<{ results: Record<"kernel" | "spreadsheet", { toolCalls: number; wallMs: number; costUsd: number; tasksWithErrors: number; score: { caught: number; planted: number } }> }>(file);
      const k = a.results.kernel, s = a.results.spreadsheet;
      rows.push({ name, status: k && s ? "pass" : "FAIL", seconds: r.seconds, costUsd: (k?.costUsd ?? 0) + (s?.costUsd ?? 0),
        result: k && s ? `kernel tools: ${k.score.caught}/${k.score.planted} caught, ${k.toolCalls} tool calls, $${k.costUsd.toFixed(2)}; spreadsheet tools: ${s.score.caught}/${s.score.planted} caught, ${s.toolCalls} tool calls, $${s.costUsd.toFixed(2)}` : "incomplete" });
    }
  }
  {
    const name = "External benchmarks, full team vs generalist";
    const dir = path.join(outRoot, "external-paid");
    const r = await step(name, "src/evals/external/main.ts", ["run", "--tasks", ALL_EXTERNAL, "--modes", "full-team,generalist", "--repeats", "1", "--max-turns", String(EXTERNAL_MAX_TURNS), "--judge", "llm", "--model-policy", policyFile, "--run", dir]);
    if (!fs.existsSync(path.join(dir, "results.json"))) crashed(name, r);
    else externalRows(dir, "External (15 tasks)", r.seconds);
  }
}

// ---------- summary ----------
const table = formatTable(rows);
const md = `# Eval summary ${stamp}

${args.paid ? `Free and paid evals (budget $${args.budgetUsd.toFixed(2)})` : "Free evals only (no model calls). Add `--paid --budget-usd N` for the model evals."}. Raw output: \`${outRoot}/\`.

${table}
`;
const summaryFile = path.join("var", "evals", `summary-${stamp}.md`);
fs.writeFileSync(summaryFile, md);
console.log(`\n${table}\n\nSummary: ${summaryFile}`);
if (rows.some((r) => r.status === "ERROR" || r.status === "FAIL")) process.exitCode = 1;
