// Create a scenario and play the outside world into it, day by day.
//   npm run world -- --run demo-1 --stores 3 --days 14 [--seed 7] [--clean] [--pace 2000] [--close]
import "../core/env";
import { AdminClient, api } from "../core/kernel-client";
import { emitDay, scenarioDays } from "./emitter";
import { createScenario, loadScenario } from "./scenario";
import { addDays } from "./rng";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const runId = flag("run", `run-${Date.now()}`)!;
const existing = args.includes("--resume");
const sc = existing
  ? loadScenario(runId)
  : await createScenario(runId, {
      seed: Number(flag("seed", "7")),
      storeCount: Number(flag("stores", "3")),
      start: flag("start", "2026-01-01")!,
      days: Number(flag("days", "14")),
      plantErrors: !args.includes("--clean"),
    });
console.log(`Scenario ${runId}: ${sc.events.length} events over ${sc.options.days} days, ${sc.options.storeCount} stores`);
const pace = Number(flag("pace", "0"));
const admin = new AdminClient();
for (const day of scenarioDays(sc)) {
  const r = await emitDay(sc, day, admin);
  console.log(`${day}: ${r.ingested} events`);
  if (pace) await new Promise((res) => setTimeout(res, pace));
}
if (args.includes("--close")) {
  const last = addDays(sc.options.start, sc.options.days - 1);
  await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "period.end", externalId: `period-end-${last.slice(0, 7)}`, occurredOn: last, payload: { period: last.slice(0, 7) },
  });
  console.log(`period.end ${last.slice(0, 7)} sent`);
}
