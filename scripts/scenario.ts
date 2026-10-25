// A fixed situation anyone can query: run `scenario-1` (seed 7, 3 stores, 14 days, planted
// errors, period close) end to end with no pacing, then print a briefing.
//   npm run scenario [-- --run scenario-1]
// With OPENAI_API_KEY (or ANTHROPIC_API_KEY) the agents use the model; without one they run
// their deterministic paths and the briefing says so. Rerunning is safe: a finished scenario
// prints its briefing again, an interrupted one resumes (event delivery is exactly-once).
import "../src/core/env";
import fs from "node:fs";
import path from "node:path";
import { api, convex } from "../src/core/kernel-client";
import { checkBackend } from "./lib/backend";
import { llmAvailable, MODEL, PROVIDER } from "../src/agents/llm";
import { Team } from "../src/agents/team";
import { installShutdown } from "../src/agents/shutdown";
import { emitDay, scenarioDays } from "../src/world/emitter";
import { createScenario, loadScenario, memoryDir, runDir, type Scenario } from "../src/world/scenario";
import { addDays } from "../src/world/rng";
import { formatReport, scoreRun, type ScoreReport } from "../src/evals/score";
import { EXAMPLE_QUESTIONS, SCENARIO_OPTIONS, SCENARIO_RUN } from "./lib/scenario-fixture";

const args = process.argv.slice(2);
const runId = args.includes("--run") ? args[args.indexOf("--run") + 1]! : SCENARIO_RUN;
const fail = (msg: string): never => { console.error(`scenario stopped: ${msg}`); process.exit(1); };
const doneFile = path.join(runDir(runId), "scenario-complete.json");
const mode = llmAvailable() ? `model on (${PROVIDER} ${MODEL})`
  : `model off (${process.env.AGENT_LLM === "off" ? "AGENT_LLM=off" : "no OPENAI_API_KEY in .env.local"}): agents run their deterministic paths only`;

const backend = await checkBackend();
const admin = backend.ok ? backend.admin : fail(backend.reason);

const inKernel = (await convex().query(api.seats.list, { runId })).length > 0;
const local = fs.existsSync(path.join(runDir(runId), "options.json"));
let sc: Scenario;
if (inKernel && !local) fail(`${runId} exists in this backend but its local files (${runDir(runId)}) are missing. Use another id: npm run scenario -- --run scenario-2`);
if (!inKernel && local) {
  // The backend was reset; the local files belong to a run that no longer exists. Keep them aside.
  const stamp = Date.now().toString(36);
  for (const dir of [runDir(runId), memoryDir(runId)]) if (fs.existsSync(dir)) fs.renameSync(dir, `${dir}.stale-${stamp}`);
  console.log(`${runId}: backend has no such run; moved its old local files aside (*.stale-${stamp}).`);
}
const started = Date.now();
if (inKernel && local) {
  sc = loadScenario(runId);
  console.log(fs.existsSync(doneFile) ? `${runId} already ran; showing its briefing. (A new run: npm run scenario -- --run scenario-2)` : `${runId}: resuming an interrupted run · ${mode}`);
} else {
  sc = await createScenario(runId, SCENARIO_OPTIONS, `Scenario 1: seed ${SCENARIO_OPTIONS.seed}, ${SCENARIO_OPTIONS.storeCount} stores, ${SCENARIO_OPTIONS.days} days`);
  console.log(`${runId}: ${sc.events.length} events over ${SCENARIO_OPTIONS.days} days, ${SCENARIO_OPTIONS.storeCount} stores, planted errors on · ${mode}`);
}

if (!fs.existsSync(doneFile)) {
  const team = new Team(runId);
  const cleanup = installShutdown(team);
  const drain = async () => {
    try { await team.runUntilIdle({ timeoutMs: 600_000 }); }
    catch (error) { team.stop(); fail(`agents did not finish (${error instanceof Error ? error.message : error}). Rerun npm run scenario to resume.`); }
  };
  for (const day of scenarioDays(sc)) {
    const r = await emitDay(sc, day, admin);
    await drain();
    process.stdout.write(`${day.slice(5)} (${r.ingested}) `);
  }
  const last = addDays(sc.options.start, sc.options.days - 1);
  await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "period.end", externalId: `period-end-${last.slice(0, 7)}`, occurredOn: last, payload: { period: last.slice(0, 7) },
  });
  await drain();
  cleanup();
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  // Score against the answer key (which the agents never see) and save where the console's Evals view looks.
  const report = await scoreRun(runId);
  fs.mkdirSync(path.join("var", "evals"), { recursive: true });
  fs.writeFileSync(path.join("var", "evals", `${runId}.md`), `${formatReport(report)}\n\nWall clock: ${wallSeconds}s (${team.processed} tasks, ${mode}).`);
  fs.writeFileSync(path.join("var", "evals", `${runId}.json`), JSON.stringify({ ...report, wallSeconds }, null, 2));
  fs.writeFileSync(doneFile, JSON.stringify({ completedAt: new Date().toISOString(), wallSeconds, tasks: team.processed, model: llmAvailable() ? `${PROVIDER} ${MODEL}` : "off" }, null, 2));
  console.log(`\ndone in ${wallSeconds}s, ${team.processed} agent tasks`);
}

// ---------- briefing, read back from the record ----------
const report = JSON.parse(fs.readFileSync(path.join("var", "evals", `${runId}.json`), "utf8")) as ScoreReport & { wallSeconds: number };
const done = JSON.parse(fs.readFileSync(doneFile, "utf8")) as { model: string };
const k = convex();
const [asks, bills, intents] = await Promise.all([
  k.query(api.asks.list, { runId, status: "open" }),
  k.query(api.ap.bills, { runId }),
  k.query(api.payments.intents, { runId }),
]);
const period = addDays(sc.options.start, sc.options.days - 1).slice(0, 7);
const close = await k.query(api.ledger.closeReadiness, { runId, period });
const countBy = (xs: string[]) => [...new Set(xs)].map((x) => `${xs.filter((y) => y === x).length} ${x}`).join(", ") || "none";
const $ = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const s = report.summary;
const caught = report.errors.filter((e) => e.caught);
const missed = report.errors.filter((e) => !e.caught);
const held = bills.filter((b) => b.status === "held");
// Urgent first, then decisions; each group oldest first so related items read in order.
const decisions = asks.filter((a) => a.severity !== "info").sort((a, b) => (a.severity === b.severity ? a.createdAt - b.createdAt : a.severity === "urgent" ? -1 : 1));
const lines = [
  "",
  `BRIEFING: ${runId} (Sweetgreen, simulated: ${sc.options.storeCount} stores, ${sc.options.start} + ${sc.options.days} days, seed ${sc.options.seed})`,
  `Model: ${done.model === "off" ? "off. Agents ran deterministic paths only; invoices in unfamiliar formats stay unread and block the close. Add OPENAI_API_KEY and use a new --run id to see the model path." : done.model}`,
  "",
  "What happened",
  `  ${sc.events.length} outside events (invoices, bank lines, sales, payroll) processed in ${report.cost.tasks} agent tasks, ${Math.round(report.cost.deterministicShare * 100)}% of them plain code.`,
  `  ${report.coverage.billsRecorded} bills recorded from ${report.coverage.invoiceDocuments} invoice documents; ${report.coverage.unresolvedDocuments} documents unresolved; ${report.coverage.parsersLearned} parsers learned.`,
  `  ${bills.filter((b) => b.status === "approved" || b.status === "paid").length} bills approved or paid, ${held.length} held; ${intents.length} payment requests (${countBy(intents.map((i) => i.status.replace("_", " ")))}). This profile requests payments; it never moves money.`,
  `  Books vs independent truth: ${report.booksStatus.status}${report.booksStatus.status !== "passed" && report.coverage.unresolvedDocuments ? ` (${report.coverage.unresolvedDocuments} invoices were never read, so their bills are missing${done.model === "off" ? "; reading them needs the model" : ""})` : ""}.`,
  "",
  `Planted errors caught: ${s.caught} of ${s.planted} (${$(s.dollarsCaught)} of ${$(s.dollarsAtRisk)} at risk); look-alikes left alone ${s.decoysCorrect}/${s.decoys}; false alarms ${s.falseAlarmCount}`,
  ...caught.map((e) => `  caught  ${e.type}: ${e.how}`),
  ...missed.map((e) => `  missed  ${e.type}: ${e.how}`),
  "",
  `Waiting for a human: ${decisions.length} decision(s), plus ${asks.length - decisions.length} info notes (digests, audit), in the console inbox`,
  ...decisions.slice(0, 12).map((a) => `  - ${a.title}`),
  ...(decisions.length > 12 ? [`  ... and ${decisions.length - 12} more`] : []),
  "",
  `Close ${period}: ${close.ready ? "ready to sign" : `blocked by ${close.blockers.length} item(s)`}`,
  ...close.blockers.slice(0, 6).map((b) => `  - ${b.reason}`),
  ...(close.blockers.length > 6 ? [`  ... and ${close.blockers.length - 6} more`] : []),
  "",
  "Ask it (answers come from git memory and the ledger, with commit SHAs):",
  ...EXAMPLE_QUESTIONS.map((q) => `  npm run ask -- "${q}"`),
  "",
  `Browse it: npm run gateway and npm run console, then open http://127.0.0.1:5173/?view=inbox#${runId}`,
  `Scored report: var/evals/${runId}.md`,
];
console.log(lines.join("\n"));
