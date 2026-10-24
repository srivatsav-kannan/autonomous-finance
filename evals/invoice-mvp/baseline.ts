/** Explicitly authorized capped baseline; importing this file never initiates a call. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSystemA } from "./baseline-agent";
import { configureCappedTransport } from "./capped-llm";
import { Workspace } from "../external/invoice-sandbox/lib/workspace";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name: string): string { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} required`); return args[i + 1]!; }
async function main() {
  if (!args.includes("--allow-live")) throw new Error("Live baseline disabled: explicit --allow-live and recorded authorization required");
  const authorization = arg("--authorization"), ledger = arg("--ledger"), runId = arg("--run-id"), out = path.resolve(arg("--out"));
  const python = arg("--python"), upstream = path.resolve(arg("--upstream")), workspace = path.resolve(arg("--workspace")), textCache = path.resolve(arg("--text-cache"));
  const validated = JSON.parse(execFileSync(python, ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from budget import authorization;print(json.dumps(authorization(sys.argv[2])))", here, authorization], { encoding: "utf8" }));
  if (path.resolve(validated.ledgerPath) !== path.resolve(ledger)) throw new Error("Use the single approved shared ledger path");
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out);
  // Reuse evaluator validation and input manifests. It cannot read a grading key into the agent workspace.
  execFileSync(python, [path.join(here, "run.py"), "prepare", "--upstream", upstream, "--workspace", workspace, "--text-cache", textCache, "--out", path.join(out, "input-preparation")], { stdio: "inherit" });
  const auth = JSON.parse(fs.readFileSync(authorization, "utf8"));
  const approved = auth.runs[runId];
  if (!approved || approved.kind !== "baseline") throw new Error("Approved baseline run required");
  const credential = approved.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[credential]) throw new Error(`${credential} missing; no model call made`);
  // Preparation seal remains a separate immutable input record.
  const resultDir = path.join(out, "live-output"); fs.mkdirSync(resultDir);
  configureCappedTransport({ authorization, ledger, runId, python, explicitLive: true });
  const config = { authorizationSha256: createHash("sha256").update(JSON.stringify(auth)).digest("hex"), pricingProvenance: auth.pricingProvenance, system: "A-capped", liveModel: "AUTHORIZED_NOT_STARTED", model: approved.model, maxTurns: approved.maxCalls, effort: "high", maxTokensPerCall: 64000, fallbacks: false, retries: 0, cache: "disabled", authorizationId: auth.approvalReference, runEnvelopeMicros: approved.maxCostMicros, aggregateEnvelopeMicros: auth.aggregateMaxCostMicros, sourceAccess: "unchanged historical A Workspace", deviations: ["persistent pre-request reservations", "no caching, fallbacks or SDK retries", "conservative token bound may stop before historical accrued-spend cap"] };
  if (approved.provider === "openai") Object.assign(config, { provider: "openai", api: "responses", serviceTier: "default", store: false, reasoningContext: "all_turns", promptCacheMode: "explicit_without_breakpoints", deviations: [...config.deviations, "OpenAI Responses wire translation; native output including encrypted reasoning preserved", "input bound capped at 250000 to exclude long-context rate uplift"] });
  fs.writeFileSync(path.join(resultDir, "configuration.json"), JSON.stringify(config, null, 2));
  let result: unknown;
  try { result = await runSystemA({ runId, ws: new Workspace(workspace, textCache), outDir: resultDir, effort: "high", maxTurns: approved.maxCalls, runCapUsd: approved.maxCostMicros / 1e6 }); }
  catch { result = { status: "error", detail: "Provider or accounting failure; no retries; unresolved reservations remain charged" }; }
  fs.writeFileSync(path.join(resultDir, "final-status.json"), JSON.stringify(result, null, 2));
  const state = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) : { runs: {} };
  const requests = Object.values(state.runs[runId]?.requests ?? {}) as { status: string; chargedCostMicros: number; usage?: { inputTokens: number; outputTokens: number } }[];
  const complete = requests.every((r) => r.status === "settled");
  fs.writeFileSync(path.join(resultDir, "usage.json"), JSON.stringify({ reservedRequests: requests.length, completedRequests: requests.filter((r) => r.status === "settled").length, modelCalls: complete ? requests.length : null, inputTokens: complete ? requests.reduce((n, r) => n + r.usage!.inputTokens, 0) : null, outputTokens: complete ? requests.reduce((n, r) => n + r.usage!.outputTokens, 0) : null, costUsd: complete ? requests.reduce((n, r) => n + r.chargedCostMicros, 0) / 1e6 : null, coverage: complete ? "complete_provider_usage" : "incomplete_retained_reservation" }, null, 2));
  config.liveModel = requests.length ? "PROVIDER_REQUESTS_RESERVED" : "NO_MODEL_CALLS";
  fs.writeFileSync(path.join(resultDir, "configuration.json"), JSON.stringify(config, null, 2));
  execFileSync(python, ["-c", "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from core import seal;seal(Path(sys.argv[2]))", here, out]);
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Baseline failed"); process.exitCode = 1; });
