// End-to-end eval: build a world, run the live agent team through it day by day, score it.
//   npm run eval -- [--stores 3] [--days 14] [--seed 7] [--chaos 0.2] [--label x]
import fs from "node:fs";
import path from "node:path";
import "../core/env";
import { AdminClient, api } from "../core/kernel-client";
import { Team } from "../agents/team";
import { installShutdown } from "../agents/shutdown";
import { llmAvailable } from "../agents/llm";
import { emitDay, scenarioDays } from "../world/emitter";
import { createScenario } from "../world/scenario";
import { addDays } from "../world/rng";
import { formatReport, scoreRun } from "./score";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const seed = Number(flag("seed", "7"));
const runId = flag("run", `eval-${flag("label", "full")}-s${seed}-${Date.now().toString(36)}`);
const chaos = Number(flag("chaos", "0"));
const verbose = args.includes("--verbose");

const started = Date.now();
const sc = await createScenario(runId, {
  seed,
  storeCount: Number(flag("stores", "3")),
  start: flag("start", "2026-01-01"),
  days: Number(flag("days", "14")),
  plantErrors: !args.includes("--clean"),
}, `eval ${flag("label", "full")}`);
console.log(`${runId}: ${sc.events.length} events · Claude ${llmAvailable() ? "on" : "off"} · chaos ${chaos}`);

const admin = new AdminClient();
const team = new Team(runId, { log: verbose ? (s) => console.log(s) : undefined });
const cleanup = installShutdown(team);
const drain = async () => {
  try { await team.runUntilIdle({ timeoutMs: Number(flag("drain-timeout-ms", "300000")) }); }
  catch (error) {
    team.stop();
    console.error(error instanceof Error ? error.message : "evaluation drain failed");
    process.exit(Number(process.exitCode) || 1);
  }
};
for (const day of scenarioDays(sc)) {
  // Chaos: re-deliver a share of the world's events. Exactly-once ingestion must absorb it.
  const r = await emitDay(sc, day, admin, { duplicateRate: chaos });
  await drain();
  process.stdout.write(`${day} (${r.ingested} new, ${r.duplicates} dup) `);
}
const last = addDays(sc.options.start, sc.options.days - 1);
await admin.client.mutation(api.admin.ingestEvent, {
  secret: admin.secret, runId, type: "period.end", externalId: `period-end-${last.slice(0, 7)}`, occurredOn: last, payload: { period: last.slice(0, 7) },
});
await drain();
cleanup();
const wallSeconds = Math.round((Date.now() - started) / 1000);

const report = await scoreRun(runId);
const md = `${formatReport(report)}\n\nWall clock: ${wallSeconds}s for ${sc.options.days} simulated days (${team.processed} tasks).`;
fs.mkdirSync(path.join("var", "evals"), { recursive: true });
fs.writeFileSync(path.join("var", "evals", `${runId}.md`), md);
fs.writeFileSync(path.join("var", "evals", `${runId}.json`), JSON.stringify({ ...report, wallSeconds }, null, 2));
console.log(`\n\n${md}`);
