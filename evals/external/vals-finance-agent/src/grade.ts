// Grades a run's submitted answers with the LLM judge.
// Usage: npx tsx evals/external/vals-finance-agent/src/grade.ts --run-id main [--samples 1|3] [--concurrency 6] [--ids q001,q002] [--force]
// Judgments go to var/evals/vals-finance-agent/runs/<run>/judge-<tag>/ (tag defaults to s<samples>).
import { parseArgs, num } from "./args";
import { loadQuestions } from "./dataset";
import { judgeQuestion } from "./judge";
import { httpStats } from "./env";
import { appendLedger, judgmentPath, ledgerTotal, readJson, readRecords, writeJson } from "./store";
import type { QuestionJudgment } from "./judge";

const args = parseArgs(process.argv.slice(2));
const runId = typeof args["run-id"] === "string" ? args["run-id"] : "";
if (!runId) throw new Error("--run-id is required");
const samples = num(args.samples, 1);
const tag = typeof args.tag === "string" ? args.tag : `s${samples}`;
const concurrency = num(args.concurrency, 6);
const hardBudget = num(args["hard-budget"], 60);
const force = args.force === true;
const only = typeof args.ids === "string" ? new Set(args.ids.split(",")) : undefined;

const byId = new Map(loadQuestions().map((q) => [q.id, q]));
const records = readRecords(runId).filter((r) => !only || only.has(r.id));
const queue = records.filter((r) => force || !readJson<QuestionJudgment>(judgmentPath(runId, tag, r.id)));
console.log(`grading ${queue.length}/${records.length} records of ${runId} with ${samples} sample(s) per check (tag ${tag}); ledger $${ledgerTotal().toFixed(2)}`);

let spent = 0;
let graded = 0;
async function worker() {
  for (;;) {
    const r = queue.shift();
    if (!r) return;
    const q = byId.get(r.id);
    if (!q) throw new Error(`record ${r.id} has no matching question`);
    const est = graded ? spent / graded : 0.3 * samples;
    if (ledgerTotal() + est > hardBudget) {
      console.log(`budget guard: not grading ${r.id}`);
      return;
    }
    const j = await judgeQuestion(r.id, q.question, r.final_answer, q.rubric, samples);
    writeJson(judgmentPath(runId, tag, r.id), j);
    appendLedger({ phase: "judge", run_id: runId, id: r.id, usd: j.cost.total, note: `tag ${tag}` });
    spent += j.cost.total;
    graded++;
    const fails = j.checks.filter((c) => c.verdict === "fail").map((c) => `${c.operator}#${c.index}`);
    console.log(`${r.id} ${j.all_pass ? "CORRECT" : "wrong"} ${j.passed}/${j.total} $${j.cost.total.toFixed(3)}${fails.length ? ` fails: ${fails.join(", ")}` : ""}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`graded ${graded}, judge cost $${spent.toFixed(2)}, ledger $${ledgerTotal().toFixed(2)}; API HTTP statuses ${JSON.stringify(httpStats.byStatus)}`);
