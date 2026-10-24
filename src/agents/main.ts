// Run the agent team for a scenario: npm run agents -- --run <runId>
import "../core/env";
import { llmAvailable, MODEL } from "./llm";
import { Team } from "./team";

const args = process.argv.slice(2);
const runId = args[args.indexOf("--run") + 1];
if (!runId || args.indexOf("--run") < 0) {
  console.error("usage: npm run agents -- --run <runId> [--drain]");
  process.exit(1);
}
console.log(`Agent team for ${runId} · Claude ${llmAvailable() ? `on (${MODEL})` : "off (deterministic paths only; set ANTHROPIC_API_KEY)"}`);
const team = new Team(runId, { log: (s) => console.log(s) });
process.on("SIGINT", () => team.stop());
if (args.includes("--drain")) await team.runUntilIdle();
else await team.runForever();
console.log(`done: ${team.processed} tasks`);
