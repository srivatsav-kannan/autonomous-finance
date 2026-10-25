import "../src/core/env";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { parseBankScope } from "../src/payments/domain/validation";
import { APCaseAgentWorker } from "../src/agents/ap-case-worker";
import { apDecisionConfigSchema, createAPModelDecisionAdapter } from "../src/agents/ap-case-decision";
import { workerFetch } from "../src/agents/control-plane";

const credential = z
  .object({ seatId: z.string().min(1), token: z.string().min(1) })
  .strict();
const configSchema = z
  .object({
    convexUrl: z.string().url(),
    scope: z.unknown(),
    apCredential: credential,
    paymentsCredential: credential,
    decision: apDecisionConfigSchema.optional(),
  })
  .strict();
const args = process.argv.slice(2),
  index = args.indexOf("--config"),
  file = index < 0 ? process.env.AP_CASE_AGENT_CONFIG : args[index + 1];
if (!file)
  throw Error(
    "Usage: npm run agents:ap -- --config <server-only JSON> [--once]",
  );
const load = () => {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw Error(
      "Cannot load AP agent configuration. Check the private JSON fields; credentials are never printed.",
    );
  }
};
const config = load(),
  scope = parseBankScope(config.scope);
if (scope.environment !== "local" && scope.environment !== "sandbox")
  throw Error("AP case agent supports local/sandbox only");
if (
  config.apCredential.seatId === config.paymentsCredential.seatId ||
  config.apCredential.token === config.paymentsCredential.token
)
  throw Error("Distinct AP and payments agent credentials required");
const client = new ConvexHttpClient(config.convexUrl, { fetch: workerFetch });
const decisionAdapter = config.decision ? createAPModelDecisionAdapter(config.decision) : undefined;
const worker = new APCaseAgentWorker(client, scope, [
  config.apCredential,
  config.paymentsCredential,
], decisionAdapter);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  if (args.includes("--inspect-decision")) {
    const caseIndex = args.indexOf("--case");
    const caseId = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
    if (!decisionAdapter || !caseId) throw Error("--inspect-decision requires model configuration and --case <id>");
    const { createAPCaseAgentTools } = await import("../src/agents/ap-case-tools");
    const inspection = await createAPCaseAgentTools(client, scope, config.apCredential).inspect_case({ caseId });
    const decision = await decisionAdapter.decide(inspection.detail, Date.now() + 30_000);
    console.log(JSON.stringify({ mode: "read_only_model_preview", writes: 0, decision }));
  } else if (args.includes("--once")) console.log(JSON.stringify(await worker.tick()));
  else
    await worker.run(stop.signal, (result) =>
      console.log(JSON.stringify(result)),
    );
} catch {
  console.error(
    "AP case agent stopped: inspect scoped worker state and server diagnostics. No automatic authorization or replacement payment was attempted.",
  );
  process.exitCode = 1;
}
