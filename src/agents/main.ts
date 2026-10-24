// Run the agent team for a scenario: npm run agents -- --run <runId>
import "../core/env";
import { llmAvailable, MODEL } from "./llm";
import { Team } from "./team";
import { installShutdown } from "./shutdown";

const args = process.argv.slice(2);
const runId = args[args.indexOf("--run") + 1];
if (!runId || args.indexOf("--run") < 0) {
  console.error("usage: npm run agents -- --run <runId> [--drain] [--drain-timeout-ms 300000]");
  process.exit(1);
}
console.log(`Agent team for ${runId} · Claude ${llmAvailable() ? `on (${MODEL})` : "off (deterministic paths only; set ANTHROPIC_API_KEY)"}`);
const team = new Team(runId, { log: (s) => console.log(s) });
const cleanup = installShutdown(team);
try {
  const timeoutIndex = args.indexOf("--drain-timeout-ms");
  if (args.includes("--drain")) await team.runUntilIdle({ timeoutMs: timeoutIndex < 0 ? undefined : Number(args[timeoutIndex + 1]) });
  else await team.runForever();
  console.log(`done: ${team.processed} tasks`);
} catch (error) {
  team.stop();
  console.error(error instanceof Error ? error.message : "agent worker failed");
  // A deadline may leave an in-flight handler; do not keep the CLI alive or print success.
  process.exit(Number(process.exitCode) || 1);
} finally { cleanup(); }
