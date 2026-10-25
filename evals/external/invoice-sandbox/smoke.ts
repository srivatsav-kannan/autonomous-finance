// Smoke test: free token counts, then two tiny paid calls (structured output + one tool turn)
// to confirm the request shape (fallbacks beta, effort, strict tools) is accepted.
//   npx tsx evals/external/invoice-sandbox/smoke.ts <run-id>
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { runPaths } from "./lib/config";
import { agentTurn, countTokens, spent, structured, USE_FALLBACKS } from "./lib/llm";
import { Workspace } from "./lib/workspace";

const runId = process.argv[2] ?? "pilot-001";
const p = runPaths(runId);
const ws = new Workspace(p.workspace, p.textCache);
const full = ws.readText("invoices/INV-2025-1017_C009.pdf");
const page1 = full.split(/\n(?==== Page 2 of)/)[0]!;

console.log("fallbacks enabled:", USE_FALLBACKS);
console.log("tokens: full PDF text =", await countTokens("x", full), "| page 1 =", await countTokens("x", page1));

const Probe = z.object({ document_id: z.string(), total: z.string() });
const r = await structured(
  { system: "Extract the invoice id and the Total exactly as printed.", user: page1, schema: Probe, effort: "low", maxTokens: 2000 },
  { runId: "smoke", system: "smoke", purpose: "structured-probe" },
);
console.log("structured:", r.value, r.error, r.entry.models_served, r.entry.stop_reason, `$${r.entry.cost_usd.toFixed(5)}`, r.entry.input_tokens, r.entry.output_tokens);

const tool = {
  name: "list_dir",
  description: "List a directory in the workspace.",
  input_schema: zodOutputFormat(z.object({ path: z.string() }) as never).schema as never,
  strict: true,
};
const t = await agentTurn(
  {
    system: "You are a test agent.",
    tools: [tool],
    messages: [{ role: "user", content: "Call list_dir on the workspace root ('.')." }],
    effort: "low",
    maxTokens: 4000,
  },
  { runId: "smoke", system: "smoke", purpose: "tool-probe" },
);
console.log(
  "tool turn:",
  t.message.stop_reason,
  JSON.stringify(t.message.content.filter((b) => b.type === "tool_use")),
  `$${t.entry.cost_usd.toFixed(5)}`,
);
console.log("ledger total so far: $" + spent().toFixed(4));
