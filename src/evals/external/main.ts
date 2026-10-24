import "../../core/env";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { llmAvailable, MODEL } from "../../agents/llm";
import { DEFAULT_DATA, evidencePath, python, sha256 } from "./evidence";
import { runAdapter } from "./adapters";
import { gradeAnswer } from "./score";
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
    judge: { type: "string", default: "llm" }, run: { type: "string" }, "dry-run": { type: "boolean", default: false },
  } });
  if (command === "help") {
    console.log("Commands: prepare | list | run | score\nOptions: --data PATH --modes full-team,generalist,rules-only --tasks apex-13,dabstep-1273 --repeats 3 --max-turns 12 --judge llm|off --dry-run\nscore requires --run PATH (an existing result directory). See docs/EXTERNAL_EVALS.md.");
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
  const gold = JSON.parse(fs.readFileSync(path.join(root, "private", "gold.json"), "utf8")) as Record<string, Gold>;
  if (command === "score") {
    if (!values.run) throw new Error("score requires --run PATH");
    const dir = path.resolve(values.run);
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    if (config.provenanceSha256 !== sha256(path.join(root, "provenance.json"))) throw new Error("Scoring data does not match the run's pinned provenance");
    const results = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")) as Result[];
    if (values.judge === "llm" && results.some((r) => r.benchmark === "apex" && r.status === "answered") && !llmAvailable()) throw new Error("APEX judging needs Claude credentials. Configure .env.local or use --judge off.");
    for (const result of results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task || !gold[task.id]) throw new Error(`Unknown case ${result.taskId}`);
      result.grade = await gradeAnswer(task, result, gold[task.id]!, values.judge === "llm");
      saveReport(dir, results, config.expectedRuns);
    }
    writeJson(path.join(dir, "rescoring.json"), { at: new Date().toISOString(), judge: values.judge, judgeModel: process.env.EXTERNAL_JUDGE_MODEL ?? MODEL });
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
  const config = { batch: "finance-eight-v1", tasks: ids, modes, repeats, maxTurns, model: MODEL, modelFallbacksEnabled: process.env.AGENT_FALLBACKS !== "0", judge: values.judge, judgeModel: process.env.EXTERNAL_JUDGE_MODEL ?? MODEL, provenanceSha256: sha256(path.join(root, "provenance.json")), evidence: Object.fromEntries(selected.map((t) => [t.id, t.evidenceSha256])), expectedRuns: selected.length*modes.length*repeats, startedAt: new Date().toISOString() };
  console.log(`${selected.length} cases × ${modes.length} modes × ${repeats} repeats = ${config.expectedRuns} runs; ${maxTurns} total model turns per case/mode; judge ${values.judge}`);
  if (values["dry-run"]) { console.log(JSON.stringify(config, null, 2)); return; }
  if (!llmAvailable() && (modes.some((m) => m !== "rules-only") || (values.judge === "llm" && selected.some((t) => t.benchmark === "apex")))) throw new Error("Claude is unavailable. Configure credentials in .env.local; for a free smoke run use --modes rules-only --judge off.");
  const dir = values.run ? path.resolve(values.run) : path.resolve("var/evals/external", `${Date.now()}-${randomUUID().slice(0,8)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // Exclusive: never silently overwrite previous results.
  fs.mkdirSync(path.join(dir, "traces"));
  writeJson(path.join(dir, "config.json"), config);
  const results: Result[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of selected) {
    // Rotate execution order between repeats without changing task inputs.
    const order = [...modes.slice((repeat-1)%modes.length), ...modes.slice(0,(repeat-1)%modes.length)];
    for (const mode of order) {
      if (!gold[task.id]) throw new Error(`No grading key for ${task.id}`);
      const started = Date.now();
      const answer = await runAdapter(mode, task, evidence.get(task.id)!, maxTurns);
      const wallSeconds = (Date.now()-started)/1000;
      const grade = await gradeAnswer(task, answer, gold[task.id]!, values.judge === "llm");
      const result: Result = { ...answer, taskId: task.id, benchmark: task.benchmark, mode, repeat, wallSeconds, grade };
      results.push(result);
      writeJson(path.join(dir, "traces", `${task.id}-${mode}-${repeat}.json`), result);
      saveReport(dir, results, config.expectedRuns);
      console.log(`${task.id} / ${mode} / ${repeat}: ${answer.status}; ${grade.score === null ? grade.status : (grade.score*100).toFixed(1)+"%"}${answer.reason ? ` (${answer.reason})` : ""}`);
    }
  }
  writeJson(path.join(dir, "complete.json"), { completedAt: new Date().toISOString(), expectedRuns: config.expectedRuns, actualRuns: results.length });
  console.log(`Report: ${path.join(dir, "comparison.md")}`);
  if (results.some((r) => r.status === "error" || r.grade.status === "error")) process.exitCode = 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
