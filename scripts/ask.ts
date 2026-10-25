// Ask the record a question, without the gateway or console running.
//   npm run ask -- "Why was INV-1002 held?" [--run scenario-1]
// Same logic as the console's "Ask why" (src/human/why.ts). With a model key it runs the
// cited-answer tool loop; without one it ranks decision commits in git memory by keyword.
import "../src/core/env";
import fs from "node:fs";
import { llmAvailable, MODEL, PROVIDER } from "../src/agents/llm";
import { why } from "../src/human/why";
import { memoryDir } from "../src/world/scenario";
import { EXAMPLE_QUESTIONS, SCENARIO_RUN } from "./lib/scenario-fixture";

const args = process.argv.slice(2);
const runAt = args.indexOf("--run");
const runId = runAt >= 0 ? args[runAt + 1] : SCENARIO_RUN;
const question = (runAt >= 0 ? args.filter((_, i) => i !== runAt && i !== runAt + 1) : args).join(" ").trim();
if (!question || !runId) {
  console.error(`usage: npm run ask -- "question" [--run ${SCENARIO_RUN}]\n\nTry:\n${EXAMPLE_QUESTIONS.map((q) => `  npm run ask -- "${q}"`).join("\n")}`);
  process.exit(1);
}
if (!fs.existsSync(memoryDir(runId))) {
  console.error(`No company memory for ${runId} (${memoryDir(runId)}). Run npm run scenario first${runId === SCENARIO_RUN ? "" : ", or pass the --run id of an existing run"}.`);
  process.exit(1);
}
console.error(llmAvailable() ? `[${runId} · answering with ${PROVIDER} ${MODEL}, citing the record]` : `[${runId} · ${process.env.AGENT_LLM === "off" ? "AGENT_LLM=off" : "no model key"}: keyword search over decision commits; add OPENAI_API_KEY for written answers]`);
const result = await why(runId, question);
console.log(result.answer);
