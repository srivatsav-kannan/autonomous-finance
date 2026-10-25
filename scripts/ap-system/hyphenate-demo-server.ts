/** Isolated teaching runtime. All identities/history are synthetic; no provider writes or workers. */
import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { prepareLocalB3Runtime } from "../../src/ap-system/local-b3-runtime";
import { createAPLocalSimulationAuthentication } from "../../src/ap-system/local-simulation-auth";
import { createAPSystemServer, APHttpError } from "../../src/ap-system/server";
import { createAPWorkspaceService } from "../../src/ap-system/service";
import { APCaseAgentWorker } from "../../src/agents/ap-case-worker";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION, intakeSchema, sourceDocumentSchema } from "../../src/ap-system/contracts";
import { businessPolicySchema } from "../../src/ap-system/domain-contracts";
import { PRECEDENT_DEMO_CASES } from "../../src/ap-system/precedent-contracts";
const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) throw Error("Usage: tsx scripts/ap-system/hyphenate-demo-server.ts --config <private JSON> [--walkthrough]");
const configPath = path.resolve(process.argv[configIndex + 1]!);
if (statSync(configPath).mode & 0o077) throw Error("Private helper config must have mode0600");
const config = z.object({ localRoot: z.string().min(1), kernelAdminSecret: z.string().min(1), runId: z.string().regex(/^ap97-b3-hyphenate-[a-zA-Z0-9-]+$/) }).strict().parse(JSON.parse(readFileSync(configPath, "utf8")));
process.env.KERNEL_ADMIN_SECRET = config.kernelAdminSecret;
process.env.AP_B3_RUN_ID = config.runId;
// prepareLocalB3Runtime rejects anything except the isolated FakeBank backend3254/site3255.
const local = await prepareLocalB3Runtime(path.resolve(config.localRoot));
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
  for (const item of PRECEDENT_DEMO_CASES) await governor.mutation(makeFunctionReference<"mutation">("apPrecedents:evaluate"), { scope: local.scope, context: item.context, idempotencyKey: `hyphenate-walkthrough-${item.key}-v1` });
}
const workSummaryPath = path.join(local.directory, "hyphenate-work-demo-summary.json");
const workSummarySchema = z.object({ caseId: z.string(), inputPacketKey: z.string(), before: z.unknown(), after: z.unknown(), caseApprovalsPerformed: z.literal(false), supplierGovernance: z.literal("simulated_independent"), verification: z.object({ missingReceiptObserved: z.boolean(), resumedToFieldReview: z.boolean() }) });
// Historical first-run evidence is immutable across server restarts.
let workDemo: z.infer<typeof workSummarySchema> | null = existsSync(workSummaryPath) ? workSummarySchema.parse(JSON.parse(readFileSync(workSummaryPath, "utf8"))) : null;
const packetIndex = process.argv.indexOf("--work-packet");
if (packetIndex >= 0) {
  const file = process.argv[packetIndex + 1];
  if (!file) throw Error("--work-packet requires a private typed intake JSON path");
  const complete = intakeSchema.parse(JSON.parse(readFileSync(path.resolve(file), "utf8")));
  if (!complete.candidate || complete.documents.some(d => d.provenance.kind !== "synthetic")) throw Error("Work demo requires a complete explicitly synthetic packet");
  if (workDemo && workDemo.inputPacketKey !== complete.idempotencyKey) throw Error("Existing work proof belongs to another packet; choose a fresh isolated runId");
  if (!workDemo) {
  // Supplier authority is established through the normal independent simulated-human workflow.
  const supplierId = complete.candidate.supplierId;
  if (!supplierId || complete.candidate.lines.some(line => !line.sku)) throw Error("Work demo requires a supplier identity and explicit supplier SKUs");
  const catalog = [...new Map(complete.candidate.lines.map(line => [line.sku!, { sku: line.sku!, unit: line.quantity.unit, unitPriceCents: line.unitPriceCents }])).values()];
  const phone = "+14155550123";
  const sourceText = `SYNTHETIC INDEPENDENT SUPPLIER DIRECTORY. Not an invoice or payment request. Supplier ${supplierId}: ${complete.candidate.extractedSupplierName}. Pre-held directory contact ${phone}. Authorized test catalog ${JSON.stringify(catalog)}. Supplied local test fixture; no real callback performed.`;
  const sourceId = `hyphenate-independent-directory-${supplierId}`;
  const source = sourceDocumentSchema.parse({ sourceId, revision: 1, sha256: createHash("sha256").update(sourceText).digest("hex"), deliveryId: sourceId, name: "Synthetic independent supplier directory.txt", kind: "other", mimeType: "text/plain", originalRef: `synthetic:${sourceId}`, byteLength: Buffer.byteLength(sourceText), originalBase64: Buffer.from(sourceText).toString("base64"), extractedText: sourceText, provenance: { kind: "synthetic", description: "Separately retained local supplier-directory fixture, independent of the invoice", license: "Synthetic demonstration", originalFilename: `${sourceId}.txt` }, replaces: null, pageCount: 1, pageStatus: [{ page: 1, status: "complete", reason: null }], parser: null });
  const binding = await local.agent.mutation(makeFunctionReference<"mutation">("apClose:retainEvidence"), { scope: local.scope, ...local.apCredential, source });
  const verifier = local.humanForActor("verifier");
  const state = await governor.query(makeFunctionReference<"query">("apBusinessConfig:view"), { scope: local.scope });
  const current = state.suppliers.find((s: { supplierId: string }) => s.supplierId === supplierId);
  if (!current?.activeRevision) {
    const contact = await verifier.mutation(makeFunctionReference<"mutation">("apBusinessConfig:registerTrustedContact"), { scope: local.scope, idempotencyKey: `hyphenate-contact:${supplierId}`, supplierId, phone, evidence: [binding], mode: "simulated", origin: { kind: "preexisting_vendor_master", acquiredAt: Date.parse("2026-10-01T00:00:00Z"), description: "Synthetic pre-held supplier contact directory, independently retained before the work-case invoice" } });
    const proposed = await local.agent.mutation(makeFunctionReference<"mutation">("apBusinessConfig:proposeSupplier"), { scope: local.scope, ...local.apCredential, idempotencyKey: `hyphenate-supplier:${supplierId}`, proposal: { supplierId, legalName: complete.candidate.extractedSupplierName, aliases: [], contactId: contact.contactId, expectedRevision: 0, externalAccountId: "ap97-b3-golden-state-beneficiary", currency: "USD", catalog, evidence: [binding], reason: "Synthetic local supplier onboarding through distinct proposer, verifier and governor; no real provider contact" } });
    const beforeVerify = await governor.query(makeFunctionReference<"query">("apBusinessConfig:view"), { scope: local.scope });
    const revision = beforeVerify.revisions.find((r: { _id: string }) => r._id === proposed.revisionId);
    if (revision.status === "proposed") await verifier.mutation(makeFunctionReference<"mutation">("apBusinessConfig:verifySupplier"), { scope: local.scope, revisionId: proposed.revisionId, verification: { contactId: contact.contactId, method: "callback_previously_held_contact", result: "confirmed", performedAt: revision.createdAt, evidence: [binding], mode: "simulated", reason: "Explicitly simulated directory callback for the isolated local demonstration; no actual call" } });
    await governor.mutation(makeFunctionReference<"mutation">("apBusinessConfig:approveSupplier"), { scope: local.scope, revisionId: proposed.revisionId, expectedHash: revision.hash, reason: "Independent simulated governor checks directory evidence, catalog and exact synthetic beneficiary; does not approve any bill or payment" });
  }
  const omitted = new Set([...complete.documents.filter(d => d.kind === "receipt").map(d => d.sourceId), ...complete.purchasingEvidence.filter(e => e.kind === "receipt" || e.kind === "service_acceptance").map(e => e.source.sourceId)]);
  if (!omitted.size) throw Error("Work demo packet must include a receipt or service acceptance source");
  const initial = structuredClone(complete);
  initial.idempotencyKey = `hyphenate-work-missing:${complete.idempotencyKey}`;
  initial.explicitRevisionOf = null;
  initial.documents = initial.documents.filter(d => !omitted.has(d.sourceId));
  initial.purchasingEvidence = initial.purchasingEvidence.filter(e => !omitted.has(e.source.sourceId));
  initial.extraction.evidence = initial.extraction.evidence.filter(e => !omitted.has(e.source.sourceId));
  initial.candidate!.revision = 1;
  initial.candidate!.sources = initial.candidate!.sources.filter(b => !omitted.has(b.sourceId));
  initial.candidate!.evidence = initial.candidate!.evidence.filter(e => !omitted.has(e.source.sourceId));
  const retainedEvidence = new Set(initial.candidate!.evidence.map(e => e.evidenceId));
  initial.candidate!.lines.forEach(line => { line.evidenceIds = line.evidenceIds.filter(id => retainedEvidence.has(id)); });
  const args = { scope: local.scope, ...local.apCredential };
  const ingested = await local.agent.mutation(makeFunctionReference<"mutation">("apCases:ingest"), { ...args, input: intakeSchema.parse(initial) });
  // This deterministic transition check never starts a payments worker or approves a bill.
  const worker = new APCaseAgentWorker(local.agent, local.scope, [local.apCredential]);
  await worker.tick();
  const before = await local.agent.query(makeFunctionReference<"query">("apCaseAgent:inspect"), { ...args, caseId: ingested.caseId });
  const resumed = structuredClone(complete);
  resumed.explicitRevisionOf = ingested.caseId;
  resumed.idempotencyKey = `hyphenate-work-receipt:${complete.idempotencyKey}`;
  resumed.candidate!.revision = 2;
  await local.agent.mutation(makeFunctionReference<"mutation">("apCases:ingest"), { ...args, input: intakeSchema.parse(resumed) });
  await worker.tick();
  const after = await local.agent.query(makeFunctionReference<"query">("apCaseAgent:inspect"), { ...args, caseId: ingested.caseId });
  const compact = (state: typeof before) => ({ revision: state.detail.revision, snapshotHash: state.detail.snapshotHash, work: state.detail.work, states: state.detail.states, exceptionCodes: state.detail.exceptions.filter((e: { blocking: boolean; status: string }) => e.blocking && e.status !== "resolved").map((e: { code: string }) => e.code) });
  workDemo = { caseId: ingested.caseId, inputPacketKey: complete.idempotencyKey, before: compact(before), after: compact(after), caseApprovalsPerformed: false, supplierGovernance: "simulated_independent", verification: { missingReceiptObserved: before.detail.work?.stage === "missing_evidence" && before.detail.exceptions.some((e: { code: string; blocking: boolean; status: string }) => e.code === "missing_receipt" && e.blocking && e.status !== "resolved"), resumedToFieldReview: after.detail.work?.stage === "field_review" } };
  writeFileSync(workSummaryPath, JSON.stringify(workDemo, null, 2), { mode: 0o600, flag: "wx" });
  if (!workDemo.verification.missingReceiptObserved || !workDemo.verification.resumedToFieldReview) throw Error("Synthetic work scenario did not reach its expected missing-evidence then field-review states; inspect retained summary, no approval was performed");
  }
}
const runtime = () => ({ contractVersion: AP_CONTRACT_VERSION, policyVersion: AP_POLICY_VERSION, runId: local.scope.runId, scope: local.scope, identityMode: local.identityMode, providerMode: "Isolated synthetic learning demonstration / FakeBank", paymentExecution: "disabled_no_worker", providerFileLoaded: false, practitionerReview: "not_performed", modelInference: "deterministic_demo" });
const auth = createAPLocalSimulationAuthentication({ ...local, authorizeActor: async id => { await local.humanForActor(id).query(makeFunctionReference<"query">("apIdentity:workspaceAccess"), { scope: local.scope }); }, serviceForActor: id => createAPWorkspaceService({ ...local, human: local.humanForActor(id), runtime, parseUploads: async () => { throw new APHttpError("learning_demo_only", 403, "This isolated teaching runtime accepts historical learning evidence only; use the existing AP sandbox for payable uploads."); } }) });
const server = createAPSystemServer({ runtime }, { port: 8827, runId: local.scope.runId, storageRoot: local.storageRoot, allowedOrigins: ["http://127.0.0.1:5196"], auth });
const summary = { scope: local.scope, identityMode: local.identityMode, inferenceMode: "deterministic_demo", gateway: "http://127.0.0.1:8827", frontend: "http://127.0.0.1:5196/ap-system?apWorkspace=learning", candidateId: seeded.candidateId, historyId: seeded.historyId, walkthrough: process.argv.includes("--walkthrough"), workCaseId: workDemo?.caseId ?? null, agentConfigPath: path.join(local.directory, "ap-agent.json"), providersCalled: false, paymentWorkersStarted: false };
mkdirSync(local.directory, { recursive: true, mode: 0o700 });
writeFileSync(path.join(local.directory, "hyphenate-demo-summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
server.listen(8827, "127.0.0.1", () => console.log(JSON.stringify(summary)));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
