/** Isolated teaching runtime. All identities/history are synthetic; no provider writes or workers. */
import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { prepareGuidanceRuntime } from "../../src/ap-system/guidance-demo-runtime";
import { createAPLocalSimulationAuthentication } from "../../src/ap-system/local-simulation-auth";
import { createAPSystemServer, APHttpError } from "../../src/ap-system/server";
import { createAPWorkspaceService } from "../../src/ap-system/service";
import { createDurableAPIntake } from "../../src/ap-system/intake-requests";
import { parseGuidancePdf } from "../../src/ap-system/guidance-pdf-intake";
import { renderPage } from "../../src/ap-system/ingestion";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION, intakeSchema, sourceDocumentSchema } from "../../src/ap-system/contracts";
import { businessPolicySchema } from "../../src/ap-system/domain-contracts";
import { PRECEDENT_DEMO_CASES } from "../../src/ap-system/precedent-contracts";
const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) throw Error("Usage: tsx scripts/ap-system/hyphenate-demo-server.ts --config <private JSON> [--walkthrough]");
const configPath = path.resolve(process.argv[configIndex + 1]!);
if (statSync(configPath).mode & 0o077) throw Error("Private helper config must have mode0600");
const config = z.object({ localRoot: z.string().min(1), kernelAdminSecret: z.string().min(1), runId: z.string().regex(/^ap97-b3-guidance-[a-zA-Z0-9-]+$/) }).strict().parse(JSON.parse(readFileSync(configPath, "utf8")));
process.env.KERNEL_ADMIN_SECRET = config.kernelAdminSecret;
process.env.AP_B3_RUN_ID = config.runId;
// prepareGuidanceRuntime rejects anything except the isolated FakeBank backend3254/site3255.
const local = await prepareGuidanceRuntime(path.resolve(config.localRoot));
// Credentials stay server-only; the model worker can use this exact scoped config later.
writeFileSync(path.join(local.directory, "ap-agent.json"), JSON.stringify({ convexUrl: local.convexUrl, scope: local.scope, apCredential: local.apCredential, paymentsCredential: local.paymentsCredential }, null, 2), { mode: 0o600 });
const governor = local.humanForActor("governor");
const subject = (id: string) => local.actors.find(a => a.id === id)!.subject;
const policy = businessPolicySchema.parse({ version: "hyphenate-local-governance-v1", groups: [{ groupId: "verify", members: [subject("verifier")] }, { groupId: "govern", members: [subject("governor")] }, { groupId: "owner", members: [subject("owner-a"), subject("owner-b")] }, { groupId: "finance", members: [subject("finance")] }], supplierVerificationGroup: "verify", supplierApprovalGroup: "govern", varianceApprovalGroup: "finance", bands: [{ upToCents: Number.MAX_SAFE_INTEGER, steps: [{ groupId: "owner", quorum: 1, escalateAfterMs: 60000, escalationGroupId: "finance" }] }], accounts: [{ account: "5000", treatment: "expense" }, { account: "1200", treatment: "inventory" }, { account: "1500", treatment: "fixed_asset" }], stores: ["sf-hayes-valley"], taxCodes: [{ code: "NONE", mode: "none" }], maxPriceVarianceBps: 0, maxDelegationMs: 86400000 });
const policyView = await governor.query(makeFunctionReference<"query">("apBusinessConfig:view"), { scope: local.scope });
if (policyView.policies.some((p: { status: string; version: string }) => p.status === "active" && p.version !== policy.version)) throw Error("This isolated run already has another active policy; choose a fresh runId");
if (!policyView.policies.some((p: { status: string }) => p.status === "active")) {
  const proposed = await local.agent.mutation(makeFunctionReference<"mutation">("apBusinessConfig:proposePolicy"), { scope: local.scope, ...local.controllerCredential, idempotencyKey: "hyphenate-local-policy-v1", policy });
  const after = await governor.query(makeFunctionReference<"query">("apBusinessConfig:view"), { scope: local.scope });
  const row = after.policies.find((p: { _id: string }) => p._id === proposed.policyId);
  await governor.mutation(makeFunctionReference<"mutation">("apBusinessConfig:activatePolicy"), { scope: local.scope, policyId: proposed.policyId, expectedHash: row.hash, reason: "Synthetic local simulation: independent governor approves the explicit teaching policy; not a real human business sign-off" });
}
const seeded = await local.agent.mutation(makeFunctionReference<"mutation">("apPrecedents:seedDemo"), { scope: local.scope, ...local.apCredential, idempotencyKey: "hyphenate-history-demo-v1" });
if (process.argv.includes("--walkthrough")) {
  const view = await governor.query(makeFunctionReference<"query">("apPrecedents:overview"), { scope: local.scope });
  if (view.candidates.find((c: { id: string; status: string }) => c.id === seeded.candidateId)?.status === "proposed") {
    await governor.mutation(makeFunctionReference<"mutation">("apPrecedents:reviewRule"), { scope: local.scope, candidateId: seeded.candidateId, expectedHash: seeded.hash, outcome: "accept", reason: "Synthetic local governor walkthrough: source A supports routine cleaning expense5000 in SF Hayes Valley during Q42026; capital renovation remains outside scope. No real human sign-off or model inference." });
  }

}

const runtime = () => ({ contractVersion: AP_CONTRACT_VERSION, policyVersion: AP_POLICY_VERSION, runId: local.scope.runId, scope: local.scope, identityMode: local.identityMode, providerMode: "Synthetic PDF guidance / isolated FakeBank", paymentExecution: "disabled_no_worker", providerFileLoaded: false, practitionerReview: "not_performed", modelInference: "deterministic_demo" });
const auth=createAPLocalSimulationAuthentication({...local,authorizeActor:async id=>{await local.humanForActor(id).query(makeFunctionReference<"query">("apIdentity:workspaceAccess"),{scope:local.scope});},serviceForActor:id=>{
 const service=createAPWorkspaceService({...local,human:local.humanForActor(id),runtime,parseUploads:createDurableAPIntake({directory:local.directory,loadCase:caseId=>service.detail(caseId),parse:parseGuidancePdf}),renderPage:(source,page)=>renderPage({source,page,storageRoot:local.storageRoot})});
 return service;
}});
const server=createAPSystemServer({runtime},{port:8830,runId:local.scope.runId,storageRoot:local.storageRoot,allowedOrigins:["http://127.0.0.1:5198"],auth});
server.listen(8830,"127.0.0.1",()=>console.log("PDF guidance demo ready: http://127.0.0.1:5198/ap-system; synthetic A; no payment worker"));
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
