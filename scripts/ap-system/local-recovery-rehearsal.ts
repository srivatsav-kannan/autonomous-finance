/** I3 rehearsal only. No production/provider configuration is read, and no financial rows are seeded. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION, caseDetailSchema, type APCaseDetail } from "../../src/ap-system/contracts";
import { PAYMENT_EXECUTOR_VERSION, type BankScope } from "../../src/payments/contracts";
import { canonicalJson } from "../../src/integrations/contracts";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { EvidenceWorker } from "../../src/payments/evidence";
import { createAPWorkspaceService } from "../../src/ap-system/service";
import { APHttpError, createAPSystemServer, type APWorkspaceService, type UploadDocument } from "../../src/ap-system/server";
import { createDurableAPIntake } from "../../src/ap-system/intake-requests";
import { combineUploads, renderPage } from "../../src/ap-system/ingestion";
import { PARSER_VERSION } from "../../src/ap-system/ingestion/provider";

const BASELINE = "433511e";
const RUN = "ap97-i3-20261025";
const URL = "http://127.0.0.1:3256";
const GATEWAY = "http://127.0.0.1:8827";
const ORIGIN = "http://127.0.0.1:5195";
const ISSUER = "https://ap-demo.invalid";
const SUBJECT = `${ISSUER}|ap97-i3-operator`;
const ACTOR = "local:i3-operator";
const ROOT = process.cwd();
const DIR = path.join(ROOT, "var", RUN);
const SOURCES = path.join(DIR, "sources");
const FIXTURE = path.join(ROOT, "fixtures/ap-system/golden-state-v1");
const BANK = path.join(DIR, "bank.sqlite");
const SCOPE: BankScope = { organizationId: "ap97-i3-synthetic-company", runId: RUN, provider: "fake", environment: "local", accountId: "ap97-i3-usd-operating" };
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const q = (name: string) => makeFunctionReference<"query">(name);
const m = (name: string) => makeFunctionReference<"mutation">(name);
const phase = z.enum(["serve", "exception", "prepare", "fault", "recover", "verify"]).parse(process.argv[2]);
if (process.argv.length !== 3) throw Error("Use exactly one phase: serve|exception|prepare|fault|recover|verify");
// Do not accidentally compose a live QBO client or load an external provider key from the parent shell.
if (Object.entries(process.env).some(([k, v]) => v && (/^(QBO_|INCREASE_|AUTH0_)/.test(k) || ["LLAMA_CLOUD_API_KEY", "AP_HUMAN_JWT", "CONVEX_DEPLOY_KEY"].includes(k))))
  throw Error("Run with a clean environment; external provider configuration is forbidden");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("git", ["merge-base", "--is-ancestor", BASELINE, sourceCommit]);
const harnessSha256 = hash(readFileSync(path.join(ROOT, "scripts/ap-system/local-recovery-rehearsal.ts")));
const deployment = z.object({ ports: z.object({ cloud: z.literal(3256), site: z.literal(3257) }), adminKey: z.string().min(1), deploymentName: z.string().min(1) }).parse(json(path.join(ROOT, ".convex/local/default/config.json")));
mkdirSync(DIR, { recursive: true, mode: 0o700 });
mkdirSync(SOURCES, { recursive: true, mode: 0o700 });
const runtimePath = path.join(DIR, "runtime.local.json");
const secret = () => randomBytes(32).toString("hex");
const runtimeSchema = z.object({ runId: z.literal(RUN), sourceCommit: z.string(), harnessSha256: z.string(), scope: z.custom<BankScope>(), admin: z.string().length(64), ap: z.string().length(64), payments: z.string().length(64), dispatcher: z.string().length(64), evidence: z.string().length(64), createdAt: z.string() }).strict();
if (!existsSync(runtimePath)) {
  assert.equal(phase, "serve", "Start the owned gateway before any rehearsal phase");
  writeFileSync(runtimePath, JSON.stringify({ runId: RUN, sourceCommit, harnessSha256, scope: SCOPE, admin: secret(), ap: secret(), payments: secret(), dispatcher: secret(), evidence: secret(), createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
}
assert.equal(statSync(runtimePath).mode & 0o077, 0, "Runtime secrets must be private");
const saved = runtimeSchema.parse(json(runtimePath));
assert.deepEqual(saved.scope, SCOPE, "Wrong local scope");
assert.equal(saved.sourceCommit, sourceCommit, "Source changed since rehearsal setup");
assert.equal(saved.harnessSha256, harnessSha256, "Harness changed since rehearsal setup");
assert.equal(new Set([saved.admin, saved.ap, saved.payments, saved.dispatcher, saved.evidence]).size, 5, "Credentials must remain distinct");
const instance = await fetch(URL + "/instance_name", { redirect: "error", signal: AbortSignal.timeout(5000) });
assert.equal(instance.ok, true, "Owned backend unavailable");
assert.equal(await instance.text(), deployment.deploymentName, "Owned backend identity differs");
const agent = new ConvexHttpClient(URL);
const human = new ConvexHttpClient(URL);
// Synthetic identity is confined to the exact fake/local backend above. No real login claim.
(human as unknown as { setAdminAuth(key: string, identity: Record<string, string>): void }).setAdminAuth(deployment.adminKey, { issuer: ISSUER, subject: "ap97-i3-operator", tokenIdentifier: SUBJECT });
const privateWrite = (file: string, data: unknown) => {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
};
const proofFile = (name: string) => path.join(DIR, `${name}.json`);
const proof = (name: string) => {
  const p = json(proofFile(name));
  assert.equal(p.status, "passed", "Required earlier phase did not pass");
  assert.equal(p.sourceCommit, sourceCommit, "Phase source differs");
  assert.equal(p.harnessSha256, harnessSha256, "Phase harness differs");
  return p;
};
const review = () => human.query(api.demoPayments.humanReview, { scope: SCOPE });
const evidence = () => human.query(api.demoEvidence.humanView, { scope: SCOPE });
const bank = () => openFakeBank({ path: BANK, scope: SCOPE, seed: 97, startTime: "2026-10-25T12:00:00.000Z", initialBalanceCents: 10_000_000 });
const names = [["invoice", "invoice"], ["purchase-order", "purchase_order"], ["receipt", "receipt"], ["contract", "contract"]] as const;
function inputs(missingReceipt = false, renamed = false, changed = false): UploadDocument[] {
  const manifest = json(path.join(FIXTURE, "manifest.json"));
  return names.filter(([n]) => !missingReceipt || n !== "receipt").map(([name, kind]) => {
    const actual = changed && name === "invoice" ? "invoice-quantity-discrepancy" : name;
    const bytes = readFileSync(path.join(FIXTURE, "input", actual + ".pdf"));
    assert.equal(hash(bytes), manifest.sources.find((s: any) => s.sourceId === "gs-" + actual)?.sha256, "Fixture original hash differs");
    return { bytes, name: `${renamed ? "renamed-" : ""}${name}.pdf`, mimeType: "application/pdf", kind };
  });
}
const ocr = { traineddataPath: "/opt/homebrew/share/tessdata/eng.traineddata", tesseractPath: "/opt/homebrew/bin/tesseract", pdfinfoPath: "/opt/homebrew/bin/pdfinfo", pdftoppmPath: "/opt/homebrew/bin/pdftoppm", timeoutMs: 20000, maxPages: 8 };
async function serve() {
  const configured = await fetch(URL + "/api/update_environment_variables", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Convex ${deployment.adminKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ changes: Object.entries({ KERNEL_ADMIN_SECRET: saved.admin, AP_DISPATCH_SECRET: saved.dispatcher, AP_EVIDENCE_SECRET: saved.evidence, AP_BANK_SCOPE: JSON.stringify(SCOPE), AP_HUMAN_AUTH_ISSUER: ISSUER, AP_HUMAN_AUTH_AUDIENCE: "ap-i3-local" }).map(([name, value]) => ({ name, value })) }) });
  assert.equal(configured.ok, true, "Local runtime configuration failed");
  const readyPath = proofFile("configured");
  if (!existsSync(readyPath)) {
    const created = await agent.mutation(m("admin:createRun"), { secret: saved.admin, runId: RUN, label: "I3 original-to-bank process recovery rehearsal", company: "Synthetic Golden State AP", simDate: "2026-10-25", periods: ["2026-10", "2026-11"], seats: [
      { seatId: "i3-ap", role: "ap_clerk", name: "I3 AP intake agent", kind: "agent", tokenHash: hash(saved.ap) },
      { seatId: "i3-payments", role: "payments", name: "I3 payment preparation agent", kind: "agent", tokenHash: hash(saved.payments) },
      { seatId: "i3-human", role: "human_cfo", name: "I3 simulated operator", kind: "human", tokenHash: hash(secret()) },
    ] });
    assert.equal(created.ok, true, "I3 requires a fresh run; an existing run is not reconfigured");
    await agent.mutation(m("demoPayments:configure"), { scope: SCOPE, secret: saved.admin, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, beneficiary: { vendor: "golden-state-produce", externalAccountId: "i3-golden-state-beneficiary", version: "i3-synthetic-v1" }, policyVersion: AP_POLICY_VERSION, controllerLimitCents: 5_000_000, humanSubjects: [{ subject: SUBJECT, seatId: "i3-human" }] });
    privateWrite(readyPath, { sourceCommit, harnessSha256, scope: SCOPE, configuredAt: new Date().toISOString() });
  }
  const r = await review();
  assert.equal(r.policyVersion, AP_POLICY_VERSION, "Policy differs");
  assert.equal(r.beneficiary.vendor, "golden-state-produce", "Supplier differs");
  assert.equal(r.beneficiary.externalAccountId, "i3-golden-state-beneficiary", "Beneficiary differs");
  assert.equal(r.beneficiary.version, "i3-synthetic-v1", "Beneficiary version differs");
  assert.equal(r.executionConfig.paymentExecutorVersion, PAYMENT_EXECUTOR_VERSION, "Executor differs");
  assert.equal(r.operator.seatId, "i3-human", "Human differs");
  const b = bank(); b.close();
  let forbiddenProviderCalls = 0;
  const runtime = () => ({ contractVersion: AP_CONTRACT_VERSION, policyVersion: AP_POLICY_VERSION, sourceCommit, harnessSha256, runId: RUN, scope: SCOPE, identityMode: "simulated_human", providerMode: "I3 isolated FakeBank", parser: "Cached genuine LlamaParse only", providerFileLoaded: false, forbiddenProviderCalls, paymentExecution: "separate_explicit_phase", practitionerReview: "not_claimed" });
  let service: APWorkspaceService;
  const parseUploads = createDurableAPIntake({ directory: DIR, loadCase: id => service.detail(id), parse: async input => {
    // Fail before parser entry on an incomplete cache; never create a provider submission.
    const cacheProof = input.uploads.map(u => {
      const prefix = hash(u.bytes) + "-";
      const dirs = readdirSync(path.join(SOURCES, "jobs")).filter(n => n.startsWith(prefix));
      assert.equal(dirs.length, 1, "Exactly one copied completed parser job is required per original");
      const f = path.join(SOURCES, "jobs", dirs[0]!, "state.json");
      const state = json(f);
      assert.equal(state.status, "complete", "Parser cache miss is forbidden");
      assert.equal(state.processor.version, PARSER_VERSION, "Parser version differs");
      return { file: f, sha256: hash(readFileSync(f)) };
    });
    const parsed = await combineUploads({ ...input, storageRoot: SOURCES, context: { supplier: { supplierId: "golden-state-produce", legalName: "Golden State Produce Co." }, coding: { account: "5000", store: "sf-hayes-valley", department: null, project: null, treatment: "expense" } }, options: { parserVersion: PARSER_VERSION, ocr, fetcher: async () => { forbiddenProviderCalls++; throw Error("i3_provider_network_forbidden"); } } });
    assert.equal(forbiddenProviderCalls, 0, "Parser attempted provider access");
    for (const p of cacheProof) assert.equal(hash(readFileSync(p.file)), p.sha256, "Copied parser job changed");
    assert.ok(parsed.candidate && parsed.extraction.status === "complete", "Cached result did not yield complete content; do not invent candidate values");
    assert.ok(parsed.documents.every(d => d.pageStatus.every(p => p.status === "complete")), "Missing or failed source page");
    return parsed;
  } });
  service = createAPWorkspaceService({ agent, human, scope: SCOPE, apCredential: { seatId: "i3-ap", token: saved.ap }, paymentsCredential: { seatId: "i3-payments", token: saved.payments }, parseUploads, renderPage: (source, page) => renderPage({ source, page, storageRoot: SOURCES, options: ocr }), runtime });
  const server = createAPSystemServer({ runtime }, { port: 8827, runId: RUN, storageRoot: SOURCES, allowedOrigins: [ORIGIN, GATEWAY], auth: {
    publicConfig: { mode: "local_simulation", actors: [{ id: "i3-operator", name: "I3 simulated operator" }] },
    authenticate: async token => {
      if (token !== ACTOR) throw new APHttpError("authentication_required", 401, "Choose the isolated I3 simulated operator");
      await review();
      return { subject: SUBJECT, issuer: ISSUER, approved: true, service };
    },
  } });
  await new Promise<void>(resolve => server.listen(8827, "127.0.0.1", resolve));
  console.log(JSON.stringify({ phase: "serve", status: "ready", gateway: GATEWAY, uiOrigin: ORIGIN, sourceCommit, harnessSha256, identityMode: "simulated_human", next: "exception" }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}

let cookie = "";
const httpHeaders = () => ({ Authorization: `Bearer ${ACTOR}`, Origin: ORIGIN, Cookie: cookie, "x-ap-system-session": "1" });
async function connect() {
  const runtime = await fetch(GATEWAY + "/api/ap-system/runtime", { redirect: "error" }).then(r => r.json());
  assert.equal(runtime.sourceCommit, sourceCommit, "Gateway source differs");
  assert.equal(runtime.harnessSha256, harnessSha256, "Gateway harness differs");
  assert.deepEqual(runtime.scope, SCOPE, "Gateway scope differs");
  const response = await fetch(GATEWAY + "/api/ap-system/cases", { headers: httpHeaders(), redirect: "error" });
  assert.equal(response.status, 200, "Local simulated session failed");
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie, "Session cookie missing");
}
async function request(route: string, data?: unknown) {
  const response = await fetch(GATEWAY + "/api/ap-system" + route, { method: data === undefined ? "GET" : "POST", headers: { ...httpHeaders(), ...(data instanceof FormData || data === undefined ? {} : { "Content-Type": "application/json" }) }, body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data), redirect: "error", signal: AbortSignal.timeout(120000) });
  const body = await response.json();
  return { status: response.status, body };
}
async function ok(route: string, data?: unknown) {
  const r = await request(route, data);
  assert.ok(r.status >= 200 && r.status < 300, `Expected successful local HTTP request: ${route}`);
  return r.body;
}
async function rejected(route: string, data: unknown, expectedCode?: string) {
  const r = await request(route, data);
  assert.ok(r.status >= 400 && r.status < 500, "Premature request must be rejected, not a server failure");
  if (expectedCode) assert.equal(r.body.error?.code ?? r.body.code, expectedCode, "Wrong rejection reason");
  return r;
}
async function upload(key: string, opts: { missing?: boolean; rename?: boolean; changed?: boolean; revisionOf?: string } = {}, expectRejected = false) {
  const form = new FormData();
  const docs = inputs(opts.missing, opts.rename, opts.changed);
  for (const d of docs) form.append("documents", new Blob([Buffer.from(d.bytes)], { type: d.mimeType }), d.name);
  form.set("kinds", JSON.stringify(docs.map(d => d.kind))); form.set("idempotencyKey", key);
  if (opts.revisionOf) form.set("explicitRevisionOf", opts.revisionOf);
  return expectRejected ? rejected("/intake", form, "intake_key_conflict") : ok("/intake", form);
}
const detail = async (id: string) => caseDetailSchema.parse(await ok(`/cases/${encodeURIComponent(id)}`));
const bind = (d: APCaseDetail) => ({ expectedRevision: d.revision, snapshotHash: d.snapshotHash });
const fieldRequest = (d: APCaseDetail, key: string) => ({ ...bind(d), sourceBindings: d.currentSourceBindings, idempotencyKey: key, outcome: "approved", reason: "Explicit synthetic I3 original comparison; not practitioner approval", evidenceIds: d.candidate!.evidence.map(e => e.evidenceId) });
const paymentRequest = (d: APCaseDetail, key: string) => ({ ...bind(d), idempotencyKey: key, executionDate: "2026-10-25" });
function verifyFields(d: APCaseDetail, missing = false) {
  // Evaluation is used only here after the actual HTTP parser result, never by the runtime parser.
  const expected = json(path.join(FIXTURE, "evaluation/expected-outcomes.json")).clean;
  assert.ok(d.candidate, "Candidate missing");
  const c = d.candidate;
  for (const [field, value] of Object.entries(expected.fields)) {
    let actual: unknown;
    if (field === "supplier") actual = c.extractedSupplierName;
    else if (field.startsWith("lines.")) {
      const [, lineId, prop] = field.split(".");
      const line = c.lines.find(l => l.lineId === lineId);
      assert.ok(line, "Expected line ID missing");
      actual = prop === "quantity" ? line.quantity.decimal : (line as any)[prop!];
    } else actual = (c as any)[field];
    assert.equal(actual, value, `Original-derived field mismatch: ${field}`);
  }
  const originals = inputs(missing);
  assert.equal(d.currentSourceBindings.length, originals.length, "Unexpected current source count");
  for (const u of originals) {
    const s = d.sources.find(s => s.sha256 === hash(u.bytes) && d.currentSourceBindings.some(b => b.sourceId === s.sourceId && b.revision === s.revision && b.sha256 === s.sha256));
    assert.ok(s && s.kind === u.kind && s.byteLength === u.bytes.byteLength, "Original binding differs");
    assert.equal(s.parser?.version, PARSER_VERSION, "Wrong cached parser version");
  }
  return { expectedFileSha256: hash(readFileSync(path.join(FIXTURE, "evaluation/expected-outcomes.json"))), fieldsChecked: Object.keys(expected.fields).length, manifestSha256: hash(readFileSync(path.join(FIXTURE, "manifest.json"))), originalHashes: originals.map(u => ({ kind: u.kind, sha256: hash(u.bytes) })), provenance: "Project-authored synthetic original PDFs; cached genuine provider output; simulated human decisions" };
}
async function verifyOriginalDownloads(d: APCaseDetail) {
  const downloads = [];
  for (const binding of d.currentSourceBindings) {
    const response = await fetch(`${GATEWAY}/api/ap-system/sources/${encodeURIComponent(binding.sourceId)}/revisions/${binding.revision}?sha256=${binding.sha256}`, { headers: httpHeaders(), redirect: "error" });
    assert.equal(response.status, 200, "Exact retained original must be downloadable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(hash(bytes), binding.sha256, "HTTP original bytes differ from source binding");
    assert.equal(response.headers.get("x-ap-source-sha256"), binding.sha256, "HTTP original hash header differs");
    downloads.push({ ...binding, byteLength: bytes.length });
  }
  return downloads;
}
async function assertNoPayment() {
  const r = await review(), e = await evidence();
  assert.equal(r.commands.length, 0, "No command may exist before payment authorization");
  assert.ok(r.bills.every(b => b.paidCents === 0), "No bill may be paid before settlement");
  assert.equal(e.transactions.length, 0, "No bank transaction may be imported before settlement");
  const b = bank(); try { assert.equal(b.harness.inspect().transfers.length, 0, "Bank must not execute before fault phase"); } finally { b.close(); }
}
async function exception() {
  assert.equal((await ok("/cases")).length, 0, "Exception phase requires an empty I3 workspace");
  const submittedAt = new Date().toISOString();
  const received = await upload("i3-missing-receipt", { missing: true });
  let d = await detail(received.caseId);
  const originalComparison = verifyFields(d, true);
  const originalDownloads = await verifyOriginalDownloads(d);
  assert.equal(d.sources.some(s => s.kind === "receipt"), false, "Future receipt must not appear in the earlier case");
  assert.equal(d.purchasingEvidence.some(e => e.kind === "receipt"), false, "Future receipt must not leak into earlier purchasing evidence");
  const receipt = json(path.join(FIXTURE, "manifest.json")).sources.find((s: any) => s.sourceId === "gs-receipt");
  assert.equal(JSON.stringify(d).includes(receipt.sha256), false, "Future receipt hash must not leak into earlier case");
  await ok(`/cases/${d.caseId}/review`, fieldRequest(d, "i3-missing-fields"));
  d = await detail(d.caseId);
  assert.ok(d.exceptions.some(e => e.code === "missing_receipt" && e.blocking && e.status === "open"), "Missing receipt must remain an owned blocking exception");
  const refusedBill = await rejected(`/cases/${d.caseId}/approve`, { ...fieldRequest(d, "i3-missing-bill-refused"), acceptedCents: d.candidate!.totalCents }, "policy_hold");
  const refusedPayment = await rejected(`/cases/${d.caseId}/payments`, paymentRequest(d, "i3-missing-payment-refused"));
  assert.equal(d.amounts.invoicedCents, 67860, "Exception must preserve gross invoice amount");
  assert.equal(d.links.billId, null, "Exception must not create a bill");
  await assertNoPayment();
  return { caseId: d.caseId, submittedAt, observedAt: new Date().toISOString(), originalComparison, originalDownloads, noFutureReceiptLeak: true, refusedBill, refusedPayment, detail: d, pause: "Inspect missing-receipt exception in the desktop UI before prepare" };
}
async function prepare() {
  const previous = proof("exception");
  const submittedAt = new Date().toISOString();
  assert.ok(Date.parse(submittedAt) >= Date.parse(previous.completedAt), "Full packet must arrive after the recorded exception phase");
  const received = await upload("i3-full-packet", { revisionOf: previous.caseId });
  assert.equal(received.caseId, previous.caseId, "Receipt must revise the same case");
  let d = await detail(received.caseId);
  assert.equal(d.revision, previous.detail.revision + 1, "Explicit receipt revision must advance revision");
  const originalComparison = verifyFields(d);
  const originalDownloads = await verifyOriginalDownloads(d);
  assert.ok(d.decisions.some(decision => decision.candidateRevision === previous.detail.revision && decision.kind === "field_review"), "Earlier review history must survive the receipt revision");
  assert.ok(d.timeline.some(event => event.kind === "source_revision" && event.at <= Date.parse(previous.completedAt)), "Earlier source revision must remain in case history");
  const refusedBeforeReview = await rejected(`/cases/${d.caseId}/approve`, { ...fieldRequest(d, "i3-before-fields-refused"), acceptedCents: d.candidate!.totalCents }, "field_review_required");
  const refusedBeforeBill = await rejected(`/cases/${d.caseId}/payments`, paymentRequest(d, "i3-before-bill-refused"));
  await ok(`/cases/${d.caseId}/review`, fieldRequest(d, "i3-full-fields"));
  d = await detail(d.caseId);
  await ok(`/cases/${d.caseId}/approve`, { ...fieldRequest(d, "i3-full-bill"), acceptedCents: d.candidate!.totalCents });
  d = await detail(d.caseId);
  assert.equal(d.states.accounting, "recognized", "Approved bill must be recognized");
  assert.equal(d.amounts.acceptedCents, 67860, "Full original amount must be accepted");
  const payment = await ok(`/cases/${d.caseId}/payments`, paymentRequest(d, "i3-payment"));
  await assertNoPayment();
  const refusedStaleAuthorization = await rejected(`/cases/${d.caseId}/payments/${payment.versionId}/authorize`, { ...bind(d), paymentSnapshotHash: "0".repeat(64) });
  await assertNoPayment();
  const authorized = await ok(`/cases/${d.caseId}/payments/${payment.versionId}/authorize`, { ...bind(d), paymentSnapshotHash: payment.snapshotHash });
  d = await detail(d.caseId);
  const r = await review();
  assert.equal(r.bills.length, 1, "Exactly one recognized bill");
  assert.equal(r.versions.length, 1, "Exactly one payment version");
  assert.equal(r.commands.length, 1, "Separate authorization creates exactly one command");
  const row = r.commands[0]!;
  assert.equal(row._id, authorized.commandId, "Command must be authorization result");
  assert.equal(row.command.commandId, payment.versionId, "Command/version link differs");
  assert.equal(row.command.amountCents, 67860, "Command amount differs from original");
  assert.equal(row.attemptCount, 0, "Prepare must not dispatch");
  assert.equal(row.posting, "unposted", "Prepare must not post cash");
  const b = bank(); try { assert.equal(b.harness.inspect().transfers.length, 0, "Prepare must not contact bank"); } finally { b.close(); }
  return { caseId: d.caseId, versionId: payment.versionId, commandId: authorized.commandId, frozenCommandSha256: hash(canonicalJson(row.command)), submittedAt, observedAt: new Date().toISOString(), originalComparison, originalDownloads, priorExceptionProofSha256: hash(readFileSync(proofFile("exception"))), refusedBeforeReview, refusedBeforeBill, refusedStaleAuthorization, detail: d, review: r, pause: "Inspect approved bill and separately authorized unexecuted payment before fault" };
}

type ChildProof = { exitCode: number | null; signal: NodeJS.Signals | null; acceptedCommandSha256?: string; lookupCommandSha256?: string; recoveredTransferId?: string | null; createTransferCalls?: number; checkpoint?: unknown };
async function dispatchChild(crash: boolean, prepared: any): Promise<ChildProof> {
  const configPath = proofFile("dispatcher.private");
  privateWrite(configPath, { url: URL, scope: SCOPE, token: saved.dispatcher, bankPath: BANK, seed: 97 });
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/testing/demo-dispatch-child.ts", configPath, ...(crash ? ["--crash-after-submit"] : [])], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let failed = false;
    const out: Omit<ChildProof, "exitCode" | "signal"> = {};
    const fail = () => { failed = true; proc.kill("SIGKILL"); };
    const timer = setTimeout(fail, 45000);
    proc.stdout?.resume(); proc.stderr?.resume();
    proc.on("error", () => { clearTimeout(timer); reject(Error("Owned dispatcher child could not start")); });
    proc.on("message", (data: any) => {
      void (async () => {
        if (data?.event === "dispatch-result") {
          assert.equal(crash, false, "Crash child must stop before a result");
          assert.equal(out.createTransferCalls, undefined, "Duplicate child result");
          assert.ok(Number.isSafeInteger(data.createTransferCalls), "Invalid child call count");
          out.createTransferCalls = data.createTransferCalls; out.recoveredTransferId = data.providerTransferId;
          return;
        }
        assert.ok(data?.event === "lookup-start" || data?.event === "accepted-before-record", "Unexpected child IPC event");
        assert.equal(data.commandSha256, prepared.frozenCommandSha256, "Child command hash changed");
        if (data.event === "lookup-start") {
          assert.equal(crash, false, "Initial worker must submit rather than recover");
          assert.equal(out.lookupCommandSha256, undefined, "Duplicate lookup checkpoint");
          out.lookupCommandSha256 = data.commandSha256; return;
        }
        assert.equal(crash, true, "Recovery must not create transfer");
        assert.equal(out.acceptedCommandSha256, undefined, "Duplicate acceptance checkpoint");
        out.acceptedCommandSha256 = data.commandSha256;
        const r = await review(), e = await evidence();
        const b = bank(); let state; try { state = b.harness.inspect(); } finally { b.close(); }
        assert.equal(state.transfers.length, 1, "External acceptance must be durable");
        const row = r.commands[0]!;
        assert.equal(r.commands.length, 1, "Only one command");
        assert.equal(row.execution, "in_flight", "Local completion must still be absent");
        assert.equal(row.posting, "unposted", "Local cash must remain unposted");
        assert.equal(row.providerTransferId, undefined, "Provider ID must not yet be recorded");
        assert.equal(row.attemptCount, 1, "Exactly one attempt at crash");
        assert.equal(hash(canonicalJson(row.command)), prepared.frozenCommandSha256, "Frozen command changed");
        assert.ok(r.bills.every(bill => bill.paidCents === 0), "Bill cannot be paid at acceptance");
        assert.equal(e.transactions.length, 0, "No evidence import before settlement");
        out.checkpoint = { review: r, evidence: e, bank: state, observedAt: new Date().toISOString() };
        privateWrite(proofFile("accepted-before-record"), { sourceCommit, harnessSha256, ...out.checkpoint as object });
        proc.kill("SIGKILL"); // Only the exact child created above. Never a service/process group.
      })().catch(fail);
    });
    proc.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (failed || (crash ? signal !== "SIGKILL" || !out.checkpoint : exitCode !== 0 || !out.lookupCommandSha256 || out.createTransferCalls === undefined)) reject(Error("Required process checkpoint failed; inspect private phase evidence"));
      else resolve({ ...out, exitCode, signal });
    });
  });
}
async function fault() {
  const p = proof("prepare"), r = await review();
  assert.equal(r.commands[0]?.attemptCount, 0, "Fault phase cannot repeat a submitted attempt");
  const b = bank(); try { assert.equal(b.harness.inspect().transfers.length, 0, "Bank must start empty"); b.harness.scheduleFault({ operation: "createTransfer", call: 1, kind: "accept_then_lost_response" }); } finally { b.close(); }
  const child = await dispatchChild(true, p);
  const d = await detail(p.caseId);
  assert.equal(d.amounts.settledCents, 0, "Killed worker cannot mark paid");
  return { caseId: p.caseId, child, detail: d, review: await review(), evidence: await evidence(), pause: "Inspect durable bank acceptance versus unposted/unpaid local state before recover" };
}
async function recover() {
  proof("fault"); const p = proof("prepare");
  const start = Date.now(), maxWait = 59000;
  for (;;) {
    const row = (await review()).commands[0]!;
    assert.equal(hash(canonicalJson(row.command)), p.frozenCommandSha256, "Command changed during lease wait");
    const remaining = Math.max(row.leaseExpiresAt ?? 0, row.nextAttemptAt ?? 0) + 1000 - Date.now();
    if (remaining <= 0) break;
    assert.ok(Date.now() - start + remaining < maxWait, "Lease wait exceeds the bounded rehearsal");
    await delay(Math.min(remaining, 1000));
  }
  const child = await dispatchChild(false, p);
  assert.equal(child.createTransferCalls, 0, "Restart must use lookup without another create");
  const r = await review();
  assert.equal(r.commands[0]?.execution, "pending", "Recovered acceptance is pending, not settled");
  assert.equal(r.commands[0]?.posting, "unposted", "Recovery alone cannot post cash");
  assert.ok(r.bills.every(b => b.paidCents === 0), "Recovery alone cannot mark paid");
  const b = bank();
  try {
    const before = b.harness.inspect(), original = before.transfers[0]!;
    assert.equal(before.transfers.length, 1, "Exactly one accepted transfer");
    assert.equal(child.recoveredTransferId, original.id, "Recovery must find original transfer");
    assert.equal(r.commands[0]?.providerTransferId, original.id, "Local transfer link differs");
    b.harness.settle(original.id);
    const generatedNotifications = b.harness.inspect().events.length;
    assert.ok(generatedNotifications > 0, "Expected simulated bank notifications");
    const delivered = b.harness.drainNotifications({ drop: true });
    assert.equal(delivered.length, 0, "All bank notifications must be deliberately dropped");
    const worker = new EvidenceWorker(agent, SCOPE, saved.evidence, b.provider);
    const first = await worker.tick(); assert.deepEqual(first.errors, [], "Evidence scan errors"); assert.equal(first.posted, 1, "Polling must post one debit");
    const repeated = [await worker.tick(), await worker.tick()];
    for (const pass of repeated) { assert.deepEqual(pass.errors, [], "Repeated evidence scan errors"); assert.equal(pass.posted, 0, "Repeated evidence cannot repost"); }
    return { caseId: p.caseId, child, waitedMs: Date.now() - start, pendingReview: r, originalTransferId: original.id, generatedNotifications, deliveredNotifications: delivered.length, first, repeated, bank: b.harness.inspect(), detail: await detail(p.caseId), review: await review(), evidence: await evidence() };
  } finally { b.close(); }
}
async function verify() {
  const p = proof("prepare"), recovered = proof("recover");
  const before = await detail(p.caseId);
  const renamed = await upload("i3-renamed-replay", { rename: true });
  assert.equal(renamed.caseId, p.caseId, "Renamed originals must resolve to the existing case");
  const conflict = await upload("i3-full-packet", { revisionOf: p.caseId, changed: true }, true);
  const d = await detail(p.caseId), r = await review(), e = await evidence();
  verifyFields(d);
  assert.equal(d.revision, before.revision, "Duplicate/conflict must not change current revision");
  assert.deepEqual(d.amounts, before.amounts, "Duplicate/conflict must not change amounts");
  assert.equal((await ok("/cases")).length, 1, "Exactly one AP case");
  assert.equal(r.bills.length, 1, "Exactly one bill"); assert.equal(r.commands.length, 1, "Exactly one command"); assert.equal(r.versions.length, 1, "Exactly one version");
  const row = r.commands[0]!;
  assert.equal(hash(canonicalJson(row.command)), p.frozenCommandSha256, "Final frozen command differs");
  assert.equal(row.execution, "settled", "Final execution must be settled"); assert.equal(row.posting, "posted", "Final posting must be posted"); assert.equal(row.reconciliation, "matched", "Final reconciliation must be matched");
  assert.equal(r.bills[0]!.paidCents, 67860, "Exactly full original paid once");
  assert.equal(d.amounts.settledCents, 67860, "Case settled amount differs"); assert.equal(d.amounts.outstandingCents, 0, "No unpaid remainder");
  const txs = e.transactions.filter(t => t.transaction.commandId === p.versionId && t.transaction.purpose === "debit" && t.transaction.status === "posted");
  assert.equal(txs.length, 1, "Exactly one posted bank debit");
  const tx = txs[0]!;
  assert.equal(tx.transaction.transferId, recovered.originalTransferId, "Bank debit must belong to original transfer");
  assert.equal(tx.transaction.amountCents, -67860, "Bank debit must equal original invoice");
  assert.ok(tx.entryId && d.links.settlementJournalIds.includes(tx.entryId), "Bank debit must bind settlement journal");
  assert.deepEqual(d.links.bankTransactionIds, [tx.transaction.id], "Case bank link differs");
  const expected = json(path.join(FIXTURE, "evaluation/expected-outcomes.json")).clean;
  const sum = (lines: { account: string; debit: number; credit: number }[]) => Object.values(lines.reduce<Record<string, { account: string; debit: number; credit: number }>>((acc, l) => { const row = acc[l.account] ??= { account: l.account, debit: 0, credit: 0 }; row.debit += l.debit; row.credit += l.credit; return acc; }, {})).sort((a, b) => a.account.localeCompare(b.account));
  assert.equal(d.journals.filter(j => j.kind === "recognition").length, 1, "Exactly one recognition journal");
  assert.equal(d.journals.filter(j => j.kind === "settlement").length, 1, "Exactly one settlement journal");
  assert.deepEqual(sum(d.journals.find(j => j.kind === "recognition")!.lines), sum(expected.recognition), "Recognition GL differs");
  assert.deepEqual(sum(d.journals.find(j => j.kind === "settlement")!.lines), sum(expected.settlement), "Settlement must reduce AP without duplicating expense");
  const b = bank(); let bankState; try { bankState = b.harness.inspect(); assert.equal(bankState.transfers.length, 1, "No duplicate bank transfer"); assert.equal(bankState.calls.createTransfer, 1, "Only original worker may create"); } finally { b.close(); }
  const runtime = await fetch(GATEWAY + "/api/ap-system/runtime").then(r => r.json());
  assert.equal(runtime.forbiddenProviderCalls, 0, "No parser provider calls allowed");
  return { caseId: p.caseId, renamed, conflict, lineage: { originalHashes: p.originalComparison.originalHashes, billId: d.links.billId, recognitionJournalId: d.links.recognitionJournalId, paymentVersionId: p.versionId, commandId: p.commandId, frozenCommandSha256: p.frozenCommandSha256, providerTransferId: recovered.originalTransferId, bankTransactionId: tx.transaction.id, settlementJournalId: tx.entryId }, detail: d, review: r, evidence: e, bank: bankState, parserProviderCalls: 0, scopeOfProof: "Local cached-parser HTTP and real child-process FakeBank rehearsal; not real login, live bank/QBO or practitioner acceptance" };
}

if (phase === "serve") {
  try { await serve(); }
  catch { console.error(JSON.stringify({ phase, status: "failed", reason: "Owned gateway setup failed; raw configuration and errors withheld" })); process.exitCode = 1; }
}
else {
  const attemptFile = path.join(DIR, `${phase}-attempt-${Date.now()}.json`);
  const base = { phase, sourceBaseline: BASELINE, sourceCommit, harnessSha256, scope: SCOPE, startedAt: new Date().toISOString() };
  privateWrite(attemptFile, { ...base, status: "started" });
  try {
    assert.ok(!existsSync(proofFile(phase)), "Completed phase is immutable; inspect its proof rather than repeat it");
    await connect();
    const result = await ({ exception, prepare, fault, recover, verify }[phase])();
    const record = { ...base, status: "passed", completedAt: new Date().toISOString(), ...result };
    privateWrite(attemptFile, record);
    writeFileSync(proofFile(phase), JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ phase, status: "passed", caseId: result.caseId, proof: proofFile(phase), next: ({ exception: "prepare", prepare: "fault", fault: "recover", recover: "verify", verify: "complete" } as const)[phase] }));
  } catch (error) {
    privateWrite(attemptFile, { ...base, status: "failed", completedAt: new Date().toISOString(), failureKind: error instanceof assert.AssertionError ? "invariant" : "runtime", invariant: error instanceof assert.AssertionError && !error.generatedMessage ? error.message : "Inspect phase and owned backend evidence; raw errors are not printed" });
    console.error(JSON.stringify({ phase, status: "failed", proof: attemptFile })); process.exitCode = 1;
  }
}
