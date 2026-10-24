/** Explicitly authorized capped baseline; importing this file never initiates a call. */
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing; no model call made");
  // Preparation seal remains a separate immutable input record.
  const resultDir = path.join(out, "live-output"); fs.mkdirSync(resultDir);
  configureCappedTransport({ authorization, ledger, runId, python, explicitLive: true });
  const config = { system: "A-capped", liveModel: "AUTHORIZED_NOT_STARTED", model: approved.model, maxTurns: approved.maxCalls, effort: "high", maxTokensPerCall: 64000, fallbacks: false, retries: 0, cache: "disabled", authorizationId: auth.approvalReference, runEnvelopeMicros: approved.maxCostMicros, aggregateEnvelopeMicros: auth.aggregateMaxCostMicros, sourceAccess: "unchanged historical A Workspace", deviations: ["persistent pre-request reservations", "no caching, fallbacks or SDK retries", "conservative token bound may stop before historical accrued-spend cap"] };
  fs.writeFileSync(path.join(resultDir, "configuration.json"), JSON.stringify(config, null, 2));
  let result: unknown;
  try { result = await runSystemA({ runId, ws: new Workspace(workspace, textCache), outDir: resultDir, effort: "high", maxTurns: approved.maxCalls, runCapUsd: approved.maxCostMicros / 1e6 }); }
  catch { result = { status: "error", detail: "Provider or accounting failure; no retries; unresolved reservations remain charged" }; }
  fs.writeFileSync(path.join(resultDir, "final-status.json"), JSON.stringify(result, null, 2));
  execFileSync(python, ["-c", "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from core import seal;seal(Path(sys.argv[2]))", here, out]);
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Baseline failed"); process.exitCode = 1; });
