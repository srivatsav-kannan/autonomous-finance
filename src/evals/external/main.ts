import "../../core/env";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { emptyUsage } from "../../agents/llm";
import { DEFAULT_MODEL_POLICY, loadModelPolicy, assertPaidPolicy, PaidBudget, createModels } from "./models";
import { DEFAULT_DATA, evidencePath, python, sha256 } from "./evidence";
import { runAdapter } from "./adapters";
import { gradeAnswer, createRubricJudge } from "./score";
import { formatComparison, summarize } from "./report";
import { MODES, type BenchmarkTask, type Gold, type Mode, type Result } from "./types";

const taskSchema = z.object({
  id: z.string(), benchmark: z.enum(["apex", "dabstep"]), sourceId: z.string(), label: z.string(), role: z.string(),
  prompt: z.string().min(1), evidence: z.string(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  answerType: z.enum(["number", "integer-set"]).optional(), decimals: z.number().int().min(0).max(14).optional(),
}).strict();

function loadTasks(root: string): BenchmarkTask[] {
  const manifest = JSON.parse(fs.readFileSync("benchmarks/finance-eight.json", "utf8"));
  const provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance.json"), "utf8"));
  if (provenance.manifestSha256 !== sha256("benchmarks/finance-eight.json")) throw new Error("Batch manifest changed; rerun bench:prepare");
  if (provenance.tasksSha256 !== sha256(path.join(root, "tasks.json")) || provenance.goldSha256 !== sha256(path.join(root, "private", "gold.json"))) throw new Error("Prepared prompts or grading keys changed; rerun bench:prepare");
  const saved = JSON.parse(fs.readFileSync(path.join(root, "tasks.json"), "utf8"));
  const tasks = z.array(taskSchema).parse(saved.tasks) as BenchmarkTask[];
  if (tasks.length !== manifest.tasks.length || new Set(tasks.map((t) => t.id)).size !== tasks.length || tasks.some((t) => !manifest.tasks.some((m: BenchmarkTask) => m.id === t.id && m.benchmark === t.benchmark && m.role === t.role))) throw new Error("Prepared tasks do not match the pinned eight-task manifest");
  return tasks;
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
    data: { type: "string", default: DEFAULT_DATA }, modes: { type: "string", default: MODES.join(",") },
    tasks: { type: "string" }, repeats: { type: "string", default: "3" }, "max-turns": { type: "string", default: "12" },
    "model-policy": { type: "string", default: DEFAULT_MODEL_POLICY },
    judge: { type: "string", default: "llm" }, run: { type: "string" }, "dry-run": { type: "boolean", default: false },
  } });
  if (command === "help") {
    console.log("Commands: prepare | list | run | score\nOptions: --data PATH --modes full-team,generalist,rules-only --tasks apex-13,dabstep-1273 --repeats 3 --max-turns 12 --judge llm|off --model-policy PATH --dry-run\nscore requires --run PATH (an existing result directory). See docs/EXTERNAL_EVALS.md.");
    return;
  }
  if (!["prepare", "list", "run", "score"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const root = path.resolve(values.data);
  if (command === "prepare") {
    const result = spawnSync(python(), ["scripts/external-bench/prepare.py", "--data", root], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Fixture preparation failed. Install scripts/external-bench/requirements.txt or set EXTERNAL_BENCH_PYTHON.");
    return;
  }
  const tasks = loadTasks(root);
  if (command === "list") {
    for (const task of tasks) console.log(`${task.id.padEnd(14)} ${task.label} → ${task.role}`);
    return;
  }
  if (!["llm", "off"].includes(values.judge)) throw new Error("--judge must be llm or off");
  const policy = loadModelPolicy(values["model-policy"]);
  const gold = JSON.parse(fs.readFileSync(path.join(root, "private", "gold.json"), "utf8")) as Record<string, Gold>;
  if (command === "score") {
    if (!values.run) throw new Error("score requires --run PATH");
    const dir = path.resolve(values.run);
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    if (config.provenanceSha256 !== sha256(path.join(root, "provenance.json"))) throw new Error("Scoring data does not match the run's pinned provenance");
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
  const ids = values.tasks?.split(",") ?? tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !tasks.some((t) => t.id === id))) throw new Error("--tasks contains unknown or duplicate IDs; use bench:list");
  const selected = ids.map((id) => tasks.find((t) => t.id === id)!);
  const repeats = Number(values.repeats), maxTurns = Number(values["max-turns"]);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("--repeats must be an integer from 1 to 100");
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 4 || maxTurns > 100) throw new Error("--max-turns must be an integer from 4 to 100");
  const evidence = new Map(selected.map((t) => [t.id, evidencePath(root, t)]));
  const roles: ("agent" | "judge")[] = [];
  if (modes.some((mode) => mode !== "rules-only")) roles.push("agent");
  if (values.judge === "llm" && selected.some((task) => task.benchmark === "apex")) roles.push("judge");
  const config = { batch: "finance-eight-v1", tasks: ids, modes, repeats, maxTurns, modelPolicy: policy, modelFallbacksEnabled: false, judge: values.judge, paidExecution: policy.approval ? "approval-present" : "disabled", provenanceSha256: sha256(path.join(root, "provenance.json")), evidence: Object.fromEntries(selected.map((t) => [t.id, t.evidenceSha256])), expectedRuns: selected.length*modes.length*repeats, startedAt: new Date().toISOString() };
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
