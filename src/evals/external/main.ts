import "../../core/env";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { emptyUsage } from "../../agents/llm";
import { DEFAULT_MODEL_POLICY, loadModelPolicy, assertPaidPolicy, PaidBudget, createModels } from "./models";
import { DEFAULT_DATA, DEFAULT_EXTRA_DATA, evidencePath, python, sha256 } from "./evidence";
import { runAdapter } from "./adapters";
import { gradeAnswer, createRubricJudge } from "./score";
import { formatComparison, summarize } from "./report";
import { ANSWER_TYPES, BENCHMARKS, MODES, type BenchmarkTask, type Gold, type Mode, type Result } from "./types";

const taskSchema = z.object({
  id: z.string(), benchmark: z.enum(BENCHMARKS), sourceId: z.string(), label: z.string(), role: z.string(),
  prompt: z.string().min(1), evidence: z.string(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  answerType: z.enum(ANSWER_TYPES).optional(), decimals: z.number().int().min(0).max(14).optional(),
}).strict();

/**
 * Pinned batches. The eight-task batch is the default matrix; the extra batch is opt-in through
 * --tasks (IDs or a benchmark name), so the default eight-task run and its provenance are unchanged.
 */
const BATCHES = [
  { id: "finance-eight-v1", key: "eight", manifest: "benchmarks/finance-eight.json", script: "scripts/external-bench/prepare.py", byDefault: true },
  { id: "finance-extra-v1", key: "extra", manifest: "benchmarks/finance-extra.json", script: "scripts/external-bench/prepare_extra.py", byDefault: false },
] as const;
type Batch = (typeof BATCHES)[number];
type Loaded = { batch: Batch; root: string; tasks: BenchmarkTask[]; gold: Record<string, Gold>; provenanceSha256: string };

function manifestTasks(batch: Batch): { id: string; benchmark: string; role: string }[] {
  return JSON.parse(fs.readFileSync(batch.manifest, "utf8")).tasks;
}
function loadBatch(batch: Batch, root: string): Loaded {
  const manifest = manifestTasks(batch);
  if (!fs.existsSync(path.join(root, "provenance.json"))) throw new Error(`${batch.id} is not prepared in ${root}; run npm run bench:prepare${batch.byDefault ? "" : ` -- --batch ${batch.key}`}`);
  const provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
  if (provenance.manifestSha256 !== sha256(batch.manifest)) throw new Error(`Batch manifest ${batch.manifest} changed; rerun bench:prepare`);
  if (provenance.tasksSha256 !== sha256(path.join(root, "tasks.json")) || provenance.goldSha256 !== sha256(path.join(root, "private", "gold.json"))) throw new Error("Prepared prompts or grading keys changed; rerun bench:prepare");
  const saved = JSON.parse(fs.readFileSync(path.join(root, "tasks.json"), "utf8"));
  const tasks = z.array(taskSchema).parse(saved.tasks) as BenchmarkTask[];
  if (tasks.length !== manifest.length || new Set(tasks.map((t) => t.id)).size !== tasks.length || tasks.some((t) => !manifest.some((m) => m.id === t.id && m.benchmark === t.benchmark && m.role === t.role))) throw new Error(`Prepared tasks do not match the pinned ${batch.id} manifest`);
  const gold = JSON.parse(fs.readFileSync(path.join(root, "private", "gold.json"), "utf8")) as Record<string, Gold>;
  return { batch, root, tasks, gold, provenanceSha256: sha256(path.join(root, "provenance.json")) };
}
/** --tasks accepts task IDs and benchmark names (apex, dabstep, invoice-sandbox, finbalance). */
function resolveTaskIds(selector: string | undefined): string[] {
  const all = BATCHES.flatMap((b) => manifestTasks(b).map((t) => ({ ...t, batch: b })));
  if (!selector) return all.filter((t) => t.batch.byDefault).map((t) => t.id);
  const ids = selector.split(",").map((s) => s.trim()).flatMap((token) => (BENCHMARKS as readonly string[]).includes(token) ? all.filter((t) => t.benchmark === token).map((t) => t.id) : [token]);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !all.some((t) => t.id === id))) throw new Error("--tasks contains unknown or duplicate IDs; use bench:list");
  return ids;
}
function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
}
function saveReport(dir: string, results: Result[], expectedRuns: number) {
  writeJson(path.join(dir, "results.json"), results);
  writeJson(path.join(dir, "comparison.json"), summarize(results, expectedRuns));
  fs.writeFileSync(path.join(dir, "comparison.md"), formatComparison(results, expectedRuns));
}

async function main() {
  const command = process.argv[2] ?? "help";
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, options: {
    data: { type: "string", default: DEFAULT_DATA }, "extra-data": { type: "string", default: DEFAULT_EXTRA_DATA },
    batch: { type: "string", default: "all" }, modes: { type: "string", default: MODES.join(",") },
    tasks: { type: "string" }, repeats: { type: "string", default: "3" }, "max-turns": { type: "string", default: "12" },
    "model-policy": { type: "string", default: DEFAULT_MODEL_POLICY },
    judge: { type: "string", default: "llm" }, run: { type: "string" }, "dry-run": { type: "boolean", default: false },
  } });
  if (command === "help") {
    console.log("Commands: prepare | list | run | score\nOptions: --data PATH --extra-data PATH --batch all|eight|extra (prepare) --modes full-team,generalist,rules-only --tasks apex-13,dabstep-1273,finbalance,invoice-sandbox --repeats 3 --max-turns 12 --judge llm|off --model-policy PATH --dry-run\nThe default matrix is the eight APEX/DABstep tasks; Invoice Sandbox and FinBalance cases run only when named in --tasks.\nscore requires --run PATH (an existing result directory). See docs/EXTERNAL_EVALS.md.");
    return;
  }
  if (!["prepare", "list", "run", "score"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const roots: Record<Batch["key"], string> = { eight: path.resolve(values.data), extra: path.resolve(values["extra-data"]) };
  if (command === "prepare") {
    if (!["all", "eight", "extra"].includes(values.batch)) throw new Error("--batch must be all, eight or extra");
    for (const batch of BATCHES.filter((b) => values.batch === "all" || values.batch === b.key)) {
      const result = spawnSync(python(), [batch.script, "--manifest", batch.manifest, "--data", roots[batch.key]], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${batch.id} preparation failed. Install scripts/external-bench/requirements.txt or set EXTERNAL_BENCH_PYTHON.`);
    }
    return;
  }
  if (command === "list") {
    for (const batch of BATCHES) {
      if (!fs.existsSync(path.join(roots[batch.key], "provenance.json"))) { console.log(`${batch.id}: not prepared (npm run bench:prepare -- --batch ${batch.key})`); continue; }
      for (const task of loadBatch(batch, roots[batch.key]).tasks) console.log(`${task.id.padEnd(32)} ${task.label} → ${task.role}${batch.byDefault ? "" : " (opt-in)"}`);
    }
    return;
  }
  if (!["llm", "off"].includes(values.judge)) throw new Error("--judge must be llm or off");
  const policy = loadModelPolicy(values["model-policy"]);
  if (command === "score") {
    if (!values.run) throw new Error("score requires --run PATH");
    const dir = path.resolve(values.run);
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    // Runs made before batches were added record only the eight-task provenance hash.
    const pinned: Record<string, string> = config.provenance ?? { "finance-eight-v1": config.provenanceSha256 };
    const loaded = BATCHES.filter((b) => b.id in pinned).map((b) => loadBatch(b, roots[b.key]));
    if (!loaded.length || loaded.some((l) => pinned[l.batch.id] !== l.provenanceSha256)) throw new Error("Scoring data does not match the run's pinned provenance");
    const tasks = loaded.flatMap((l) => l.tasks), gold = Object.assign({}, ...loaded.map((l) => l.gold)) as Record<string, Gold>;
    const results = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")) as Result[];
    const needsJudge = values.judge === "llm" && results.some((r) => r.benchmark === "apex" && r.status === "answered");
    if (values["dry-run"]) { console.log(JSON.stringify({ command, needsJudge, modelPolicy: policy, paidExecution: policy.approval ? "approval-present" : "disabled" }, null, 2)); return; }
    if (needsJudge) assertPaidPolicy(policy, ["judge"]);
    const budget = needsJudge ? new PaidBudget(policy, values["model-policy"], dir) : undefined;
    const judgeModel = budget ? createModels(policy, budget, ["judge"]).judge : undefined;
    const rubricJudge = judgeModel ? createRubricJudge(judgeModel) : undefined;
    writeJson(path.join(dir, "rescoring.json"), { at: new Date().toISOString(), judge: values.judge, modelPolicy: policy, budgetLedger: budget?.ledgerPath, status: "started" });
    // A failed/interrupted rescore must not leave old grades mixed with new ones.
    for (const result of results) result.grade = { status: "ungraded", score: null, passed: null, method: "pending-rescore", judgeUsage: emptyUsage() };
    saveReport(dir, results, config.expectedRuns);
    for (const result of results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task || !gold[task.id]) throw new Error(`Unknown case ${result.taskId}`);
      result.grade = await gradeAnswer(task, result, gold[task.id]!, values.judge === "llm", rubricJudge);
      saveReport(dir, results, config.expectedRuns);
      if (budget?.stopped || result.grade.status === "error") { budget?.stop(); throw new Error("Rescoring stopped; inspect saved grades and budget ledger"); }
    }
    budget?.complete();
    writeJson(path.join(dir, "rescoring.json"), { at: new Date().toISOString(), judge: values.judge, modelPolicy: policy, budgetLedger: budget?.ledgerPath, status: "complete" });
    console.log(path.join(dir, "comparison.md"));
    if (results.some((r) => r.grade.status === "error")) process.exitCode = 1;
    return;
  }
  const modes = values.modes.split(",") as Mode[];
  if (!modes.length || new Set(modes).size !== modes.length || modes.some((m) => !MODES.includes(m))) throw new Error(`--modes must be unique values from ${MODES.join(",")}`);
  const ids = resolveTaskIds(values.tasks);
  // Load only the batches the selected tasks come from, so either can be prepared on its own.
  const loaded = BATCHES.filter((b) => manifestTasks(b).some((t) => ids.includes(t.id))).map((b) => loadBatch(b, roots[b.key]));
  const tasks = loaded.flatMap((l) => l.tasks), gold = Object.assign({}, ...loaded.map((l) => l.gold)) as Record<string, Gold>;
  const selected = ids.map((id) => tasks.find((t) => t.id === id)!);
  const repeats = Number(values.repeats), maxTurns = Number(values["max-turns"]);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("--repeats must be an integer from 1 to 100");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 4 || maxTurns > 100) throw new Error("--max-turns must be an integer from 4 to 100");
  const evidence = new Map(selected.map((t) => [t.id, evidencePath(loaded.find((l) => l.tasks.includes(t))!.root, t)]));
  const roles: ("agent" | "judge")[] = [];
  if (modes.some((mode) => mode !== "rules-only")) roles.push("agent");
  if (values.judge === "llm" && selected.some((task) => task.benchmark === "apex")) roles.push("judge");
  const provenance = Object.fromEntries(loaded.map((l) => [l.batch.id, l.provenanceSha256]));
  const config = { batch: loaded.map((l) => l.batch.id).join("+"), tasks: ids, modes, repeats, maxTurns, modelPolicy: policy, modelFallbacksEnabled: false, judge: values.judge, paidExecution: policy.approval ? "approval-present" : "disabled", provenanceSha256: loaded.length === 1 ? loaded[0]!.provenanceSha256 : null, provenance, evidence: Object.fromEntries(selected.map((t) => [t.id, t.evidenceSha256])), expectedRuns: selected.length*modes.length*repeats, startedAt: new Date().toISOString() };
  console.log(`${selected.length} cases × ${modes.length} modes × ${repeats} repeats = ${config.expectedRuns} runs; ${maxTurns} total model turns per case/mode; judge ${values.judge}`);
  if (values["dry-run"]) { console.log(JSON.stringify(config, null, 2)); return; }
  if (roles.length) assertPaidPolicy(policy, roles, maxTurns);
  const dir = values.run ? path.resolve(values.run) : path.resolve("var/evals/external", `${Date.now()}-${randomUUID().slice(0,8)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // Exclusive: never silently overwrite previous results.
  fs.mkdirSync(path.join(dir, "traces"));
  const budget = roles.length ? new PaidBudget(policy, values["model-policy"], dir) : undefined;
  const models = budget ? createModels(policy, budget, roles) : {};
  const rubricJudge = models.judge ? createRubricJudge(models.judge) : undefined;
  writeJson(path.join(dir, "config.json"), { ...config, budgetLedger: budget?.ledgerPath });
  const results: Result[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of selected) {
    // Rotate execution order between repeats without changing task inputs.
    const order = [...modes.slice((repeat-1)%modes.length), ...modes.slice(0,(repeat-1)%modes.length)];
    for (const mode of order) {
      if (!gold[task.id]) throw new Error(`No grading key for ${task.id}`);
      const started = Date.now();
      const answer = await runAdapter(mode, task, evidence.get(task.id)!, maxTurns, models.agent);
      const wallSeconds = (Date.now()-started)/1000;
      const grade = await gradeAnswer(task, answer, gold[task.id]!, values.judge === "llm", rubricJudge);
      const result: Result = { ...answer, taskId: task.id, benchmark: task.benchmark, mode, repeat, wallSeconds, grade };
      results.push(result);
      writeJson(path.join(dir, "traces", `${task.id}-${mode}-${repeat}.json`), result);
      saveReport(dir, results, config.expectedRuns);
      console.log(`${task.id} / ${mode} / ${repeat}: ${answer.status}; ${grade.score === null ? grade.status : (grade.score*100).toFixed(1)+"%"}${answer.reason ? ` (${answer.reason})` : ""}`);
      if (budget && (budget.stopped || answer.status === "error" || grade.status === "error")) { budget.stop(); throw new Error("Paid evaluation stopped; partial results and budget ledger retained"); }
    }
  }
  budget?.complete();
  writeJson(path.join(dir, "complete.json"), { completedAt: new Date().toISOString(), expectedRuns: config.expectedRuns, actualRuns: results.length });
  console.log(`Report: ${path.join(dir, "comparison.md")}`);
  if (results.some((r) => r.status === "error" || r.grade.status === "error")) process.exitCode = 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
