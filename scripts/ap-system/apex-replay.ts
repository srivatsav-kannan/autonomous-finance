/** Issue #107: replay APEX World 9 contract-attorney invoices through the AP system on an isolated local backend.
 * FakeBank and simulated local identities only. No provider, parser, model, QuickBooks, Increase or Auth0 call. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { AP_CONTRACT_VERSION, AP_POLICY_VERSION, caseDetailSchema, type APCaseDetail } from "../../src/ap-system/contracts";
import type { BusinessAcceptance, BusinessPolicy } from "../../src/ap-system/domain-contracts";
import { PAYMENT_EXECUTOR_VERSION, type BankScope } from "../../src/payments/contracts";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { createEvidenceWorker, createPaymentDispatcher } from "../../src/payments/bootstrap";
import { createAPWorkspaceService } from "../../src/ap-system/service";
import { APHttpError, createAPSystemServer, type APWorkspaceService } from "../../src/ap-system/server";
import { createDurableAPIntake } from "../../src/ap-system/intake-requests";
import { renderPage } from "../../src/ap-system/ingestion";
import { apexTextLayerIntake, simplePdf } from "../../src/ap-system/replay/apex-intake";
import { mapContractAttorneyInvoice } from "../../src/ap-system/replay/apex-invoice";
import { APEX_FILES, APEX_SOURCE, cents, historicalPaymentChecks, loadApexWorld } from "../../src/ap-system/replay/apex-sources";
import { popplerVersion, readTextLayer, TEXT_LAYER_IMPLEMENTATION } from "../../src/ap-system/replay/text-layer";

const RUN = "apex107-replay-20261025";
const CONVEX = "http://127.0.0.1:3460";
const GATEWAY_PORT = 8847, GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`, ORIGIN = "http://127.0.0.1:5197";
const ISSUER = "https://ap-demo.invalid";
const ROOT = process.cwd();
const DIR = path.join(ROOT, "var", RUN);
const SOURCES = path.join(DIR, "sources");
const BANK = path.join(DIR, "fakebank.sqlite");
const APEX_ROOT = path.resolve(process.env.APEX_WORLD_ROOT ?? path.join(ROOT, "var/benchmarks/finance-eight/private/raw/apex-world"));
const SCOPE: BankScope = { organizationId: "apex107-synthetic-sterling-marsh", runId: RUN, provider: "fake", environment: "local", accountId: "apex107-usd-operating" };
const POLICY_VERSION = "apex107-simulated-services-policy-v1";
const SUPPLIER = { supplierId: "apex-v041", vendorId: "V-041" };
const BENEFICIARY = "apex107-simulated-avila-beneficiary";
const CODING = { account: "6000", treatment: "expense" as const };
const CASES = {
  case1: { file: "Avila_AVILA-202412-A6.pdf", invoiceNumber: "AVILA-202412-A6", billId: "BILL-2024-00332", amountCents: 300000, sourceStatus: "Open" },
  case2: { file: "Avila_AVILA-202403-A1.pdf", invoiceNumber: "AVILA-202403-A1", billId: "BILL-2024-00327", amountCents: 350000, sourceStatus: "Paid", bankTransactionId: "OBT-000200", reference: "CHK-2024327", statement: "2024-04_operating_bank_statement.pdf" },
} as const;
const ACTORS = [
  { id: "ap-reviewer", name: "SIMULATED AP field reviewer" },
  { id: "verifier", name: "SIMULATED supplier verifier" },
  { id: "governor", name: "SIMULATED policy and supplier governor" },
  { id: "matter-owner", name: "SIMULATED matter owner (service acceptance)" },
  { id: "finance", name: "SIMULATED finance approver" },
  { id: "treasury", name: "SIMULATED payment authorizer" },
].map(a => ({ ...a, subject: `${ISSUER}|apex107-${a.id}` }));
const OCR = { pdfinfoPath: "/opt/homebrew/bin/pdfinfo", pdftoppmPath: "/opt/homebrew/bin/pdftoppm", timeoutMs: 20000, maxPages: 8 };
const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const m = (name: string) => makeFunctionReference<"mutation">(name);
const q = (name: string) => makeFunctionReference<"query">(name);
const phase = z.enum(["serve", "inventory", "case1-intake", "governance", "case1-hold", "case1-evidence", "case1-approve", "case1-pay", "worker", "case2", "reimport", "report"]).parse(process.argv[2]);
// Fail closed if the parent shell carries any external provider or model configuration.
if (Object.entries(process.env).some(([k, v]) => v && (/^(QBO_|INCREASE_|AUTH0_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(k) || ["LLAMA_CLOUD_API_KEY", "AP_HUMAN_JWT", "CONVEX_DEPLOY_KEY"].includes(k))))
  throw Error("Run with a clean environment; external provider and model configuration is forbidden");
if (process.env.AGENT_LLM && process.env.AGENT_LLM !== "off") throw Error("AGENT_LLM must be off");
mkdirSync(SOURCES, { recursive: true, mode: 0o700 });
const privateWrite = (file: string, data: unknown) => { const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, file); };
const proofFile = (name: string) => path.join(DIR, `${name}.json`);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const runtimePath = path.join(DIR, "runtime.local.json");
const secret = () => randomBytes(32).toString("hex");
if (!existsSync(runtimePath)) writeFileSync(runtimePath, JSON.stringify({ runId: RUN, admin: secret(), ap: secret(), controller: secret(), payments: secret(), dispatcher: secret(), evidence: secret(), createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
assert.equal(statSync(runtimePath).mode & 0o077, 0, "Runtime secrets must be private");
const saved = z.object({ runId: z.literal(RUN), admin: z.string().length(64), ap: z.string().length(64), controller: z.string().length(64), payments: z.string().length(64), dispatcher: z.string().length(64), evidence: z.string().length(64), createdAt: z.string() }).strict().parse(json(runtimePath));
const deployment = z.object({ ports: z.object({ cloud: z.literal(3460), site: z.literal(3461) }), adminKey: z.string().min(1), deploymentName: z.string().min(1) }).parse(json(path.join(ROOT, ".convex/local/default/config.json")));
const agent = new ConvexHttpClient(CONVEX);
const humanFor = (actorId: string) => {
  const actor = ACTORS.find(a => a.id === actorId);
  if (!actor) throw Error("Unknown simulated actor");
  const human = new ConvexHttpClient(CONVEX);
  // Synthetic identity confined to this exact local backend. No real login claim.
  (human as unknown as { setAdminAuth(key: string, identity: Record<string, string>): void }).setAdminAuth(deployment.adminKey, { issuer: ISSUER, subject: `apex107-${actorId}`, tokenIdentifier: actor.subject });
  return human;
};
const bank = () => openFakeBank({ path: BANK, scope: SCOPE, seed: 107, startTime: "2026-10-25T12:00:00.000Z", initialBalanceCents: 10_000_000 });
const runtimeInfo = { contractVersion: AP_CONTRACT_VERSION, legacyPolicyVersion: AP_POLICY_VERSION, businessPolicyVersion: POLICY_VERSION, runId: RUN, scope: SCOPE, identityMode: "simulated_human", providerMode: "Isolated local Convex + FakeBank", parser: `Local poppler pdftotext text layer (${TEXT_LAYER_IMPLEMENTATION}); no LlamaParse`, dataset: APEX_SOURCE, externalProviders: { increase: "blocked: needs JJ's sandbox credentials", quickbooks: "blocked: needs JJ's sandbox credentials", auth0: "blocked: needs JJ's sandbox credentials" }, practitionerReview: "not_claimed" };

async function configureBackend() {
  const instance = await fetch(CONVEX + "/instance_name", { redirect: "error", signal: AbortSignal.timeout(5000) });
  assert.equal(await instance.text(), deployment.deploymentName, "Owned backend identity differs");
  const configured = await fetch(CONVEX + "/api/update_environment_variables", { method: "POST", redirect: "error", headers: { Authorization: `Convex ${deployment.adminKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ changes: Object.entries({ KERNEL_ADMIN_SECRET: saved.admin, AP_DISPATCH_SECRET: saved.dispatcher, AP_EVIDENCE_SECRET: saved.evidence, AP_BANK_SCOPE: JSON.stringify(SCOPE), AP_HUMAN_AUTH_ISSUER: ISSUER, AP_HUMAN_AUTH_AUDIENCE: "ap-apex107-local" }).map(([name, value]) => ({ name, value })) }) });
  assert.equal(configured.ok, true, "Local runtime configuration failed");
  const created = await agent.mutation(m("admin:createRun"), { secret: saved.admin, runId: RUN, label: "APEX World 9 AP replay (issue #107)", company: "Sterling, Marsh & Associates LLP (APEX synthetic dataset)", simDate: "2026-10-25", periods: ["2024-03", "2024-04", "2024-12", "2025-01", "2026-10", "2026-11"], seats: [
    { seatId: "apex107-ap", role: "ap_clerk", name: "APEX replay intake agent", kind: "agent", tokenHash: hash(saved.ap) },
    { seatId: "apex107-controller", role: "controller", name: "APEX replay controller proposals", kind: "agent", tokenHash: hash(saved.controller) },
    { seatId: "apex107-payments", role: "payments", name: "APEX replay payment preparation", kind: "agent", tokenHash: hash(saved.payments) },
    ...ACTORS.map(a => ({ seatId: `apex107-${a.id}`, role: "human_cfo", name: a.name, kind: "human", tokenHash: hash(secret()) })),
  ] });
  if (created.ok) await agent.mutation(m("demoPayments:configure"), { scope: SCOPE, secret: saved.admin, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, beneficiary: { vendor: SUPPLIER.supplierId, externalAccountId: BENEFICIARY, version: "apex107-simulated-v1" }, policyVersion: AP_POLICY_VERSION, controllerLimitCents: 5_000_000, humanSubjects: ACTORS.map(a => ({ subject: a.subject, seatId: `apex107-${a.id}` })) });
  else assert.equal(created.code, "exists", "Run creation failed");
}

async function serve() {
  await configureBackend();
  const world = await loadApexWorld(APEX_ROOT);
  const vendor = world.vendors.find(v => v["Vendor ID"] === SUPPLIER.vendorId);
  assert.ok(vendor, "APEX vendor master row missing");
  const supplier = { supplierId: SUPPLIER.supplierId, legalName: vendor["Vendor Name"]! };
  const poppler = await popplerVersion(PDFTOTEXT);
  const services = new Map<string, APWorkspaceService>();
  const serviceFor = (actorId: string) => {
    const existing = services.get(actorId);
    if (existing) return existing;
    let service: APWorkspaceService;
    const parseUploads = createDurableAPIntake({ directory: DIR, loadCase: id => service.detail(id), parse: input => apexTextLayerIntake({ ...input, storageRoot: SOURCES, supplier, coding: CODING, options: { pdftotextPath: PDFTOTEXT, popplerVersion: poppler, ocr: OCR } }) });
    service = createAPWorkspaceService({ agent, human: humanFor(actorId), scope: SCOPE, apCredential: { seatId: "apex107-ap", token: saved.ap }, paymentsCredential: { seatId: "apex107-payments", token: saved.payments }, controllerCredential: { seatId: "apex107-controller", token: saved.controller }, parseUploads, renderPage: (source, page) => renderPage({ source, page, storageRoot: SOURCES, options: OCR }), runtime: () => runtimeInfo });
    services.set(actorId, service);
    return service;
  };
  const server = createAPSystemServer({ runtime: () => runtimeInfo }, { port: GATEWAY_PORT, runId: RUN, storageRoot: SOURCES, allowedOrigins: [ORIGIN, GATEWAY, "http://127.0.0.1:5192"], auth: {
    publicConfig: { mode: "local_simulation", actors: ACTORS.map(({ id, name }) => ({ id, name })) },
    authenticate: async token => {
      const actor = token.startsWith("local:") ? ACTORS.find(a => a.id === token.slice(6)) : undefined;
      if (!actor) throw new APHttpError("authentication_required", 401, "Choose a configured APEX replay simulated actor.");
      let approved = false;
      try { await humanFor(actor.id).query(q("apIdentity:workspaceAccess"), { scope: SCOPE }); approved = true; } catch { approved = false; }
      return { subject: actor.subject, issuer: ISSUER, approved, service: serviceFor(actor.id) };
    },
  } });
  await new Promise<void>(resolve => server.listen(GATEWAY_PORT, "127.0.0.1", resolve));
  console.log(JSON.stringify({ phase: "serve", status: "ready", gateway: GATEWAY, uiOrigin: ORIGIN, runId: RUN, identityMode: "simulated_human", provider: "fake" }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}

// ---------- HTTP client acting as one simulated actor through the real gateway ----------
async function session(actorId: string) {
  const authorization = `Bearer local:${actorId}`;
  const opened = await fetch(GATEWAY + "/api/ap-system/cases", { headers: { authorization }, redirect: "error" });
  assert.equal(opened.status, 200, `Simulated actor ${actorId} has no workspace access`);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  return async (route: string, data?: unknown) => {
    const post = data !== undefined;
    const response = await fetch(GATEWAY + "/api/ap-system" + route, { method: post ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(120000), headers: { authorization, cookie, ...(post ? { origin: ORIGIN, "X-AP-System-Session": "1", ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }) } : {}) }, body: post ? (data instanceof FormData ? data : JSON.stringify(data)) : undefined });
    return { status: response.status, body: await response.json() as any };
  };
}
type Call = Awaited<ReturnType<typeof session>>;
const ok = async (call: Call, route: string, data?: unknown) => { const r = await call(route, data); assert.ok(r.status >= 200 && r.status < 300, `${route} failed: ${r.status} ${r.body?.error?.code ?? ""} ${r.body?.error?.reason ?? ""}`); return r.body; };
const refused = async (call: Call, route: string, data: unknown) => { const r = await call(route, data); assert.ok(r.status >= 400 && r.status < 500, `${route} must be refused, got ${r.status}`); return { status: r.status, code: r.body?.error?.code ?? null, reason: r.body?.error?.reason ?? null }; };
const detail = async (call: Call, id: string) => caseDetailSchema.parse(await ok(call, `/cases/${encodeURIComponent(id)}`));
const bind = (d: APCaseDetail) => ({ expectedRevision: d.revision, snapshotHash: d.snapshotHash });
const record = (name: string, data: Record<string, unknown>) => { privateWrite(proofFile(name), { phase: name, runId: RUN, sourceCommit, recordedAt: new Date().toISOString(), ...data }); console.log(JSON.stringify({ phase: name, status: "passed", ...Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== "object" || v === null)) })); };
const proof = (name: string) => json(proofFile(name));

function simulatedContract(matter: string) {
  return simplePdf([
    "SIMULATED SERVICE AGREEMENT - NOT PART OF THE APEX DATASET",
    "Generated by the APEX replay adapter for issue #107 to exercise AP controls.",
    "APEX World 9 contains no contract-attorney rate agreement for this supplier.",
    "Reference: SIM-AGREEMENT-AVILA-" + matter,
    "Supplier: Marcus Avila, Esq.",
    "Supplier ID: " + SUPPLIER.supplierId,
    "Service item: " + matter,
    "Unit: hour",
    "Rate: $200.00",
    "Not-to-exceed hours: 20",
  ]);
}
function simulatedAcceptance(invoiceNumber: string, matter: string, hours: string) {
  return simplePdf([
    "SIMULATED SERVICE ACCEPTANCE - NOT PART OF THE APEX DATASET",
    "Generated by the APEX replay adapter for issue #107. No real person accepted these services.",
    "Reference: SIM-ACCEPTANCE-" + invoiceNumber,
    "Supplier ID: " + SUPPLIER.supplierId,
    "Invoice: " + invoiceNumber,
    "Service item: " + matter,
    "Unit: hour",
    "Accepted hours: " + hours,
    "Accepted by: SIMULATED matter owner",
    "Accepted at: 2024-12-12T17:00:00Z",
  ]);
}
async function upload(call: Call, key: string, docs: { bytes: Uint8Array; name: string; kind: string }[], revisionOf?: string) {
  const form = new FormData();
  for (const d of docs) form.append("documents", new Blob([Buffer.from(d.bytes)], { type: "application/pdf" }), d.name);
  form.set("kinds", JSON.stringify(docs.map(d => d.kind)));
  form.set("idempotencyKey", key);
  if (revisionOf) form.set("explicitRevisionOf", revisionOf);
  return call("/intake", form);
}
const invoiceBytes = (file: string) => new Uint8Array(readFileSync(path.join(APEX_ROOT, APEX_FILES.invoices, file)));
async function fieldReview(call: Call, d: APCaseDetail, key: string) {
  assert.ok(d.candidate, "Candidate required for field review");
  return ok(call, `/cases/${d.caseId}/review`, { ...bind(d), sourceBindings: d.currentSourceBindings, idempotencyKey: key, outcome: "approved", reason: "SIMULATED reviewer compared each field to the original APEX PDF; not practitioner approval", evidenceIds: d.candidate.evidence.map(e => e.evidenceId) });
}
/** Compares the parsed candidate with the APEX ledger. Used only after parsing, never by the parser. */
async function ledgerComparison(d: APCaseDetail, billId: string) {
  const world = await loadApexWorld(APEX_ROOT);
  const row = world.apLedger.find(r => r.bill_id === billId)!;
  const c = d.candidate!;
  const checks = {
    supplier: c.extractedSupplierName === row.vendor_name, invoiceNumber: c.invoiceNumber === row.docnumber, invoiceDate: c.invoiceDate === row.txndate,
    dueDate: c.dueDate === row.due_date, terms: c.terms === row.payment_terms, totalCents: c.totalCents === cents(row.bill_amount),
    matter: c.lines.every(l => l.sku === row.matter_number), descriptionContainsLedgerText: c.lines.some(l => l.description.endsWith(row.description ?? "\u0000")),
  };
  return { billId, ledgerStatus: row.payment_status, checks, allMatch: Object.values(checks).every(Boolean) };
}
const caseIdFor = (key: "case1" | "case2") => proof(key === "case1" ? "case1-intake" : "case2").caseId as string;

async function inventory() {
  const world = await loadApexWorld(APEX_ROOT);
  const rows: any[] = [];
  for (const file of world.invoiceFiles) {
    const { pages } = await readTextLayer(world.invoicePath(file), PDFTOTEXT);
    const r = pages.length === 1 ? mapContractAttorneyInvoice(pages[0]!) : { ok: false as const, reason: "unsupported_page_count" };
    if (!r.ok) { rows.push({ file, parsed: false, reason: r.reason }); continue; }
    const i = r.invoice, ledger = world.apLedger.filter(x => x.docnumber === i.invoiceNumber);
    const l = ledger[0];
    const vendor = l ? world.vendors.find(v => v["Vendor ID"] === l.vendorref_value) : undefined;
    const arithmeticExact = i.lines.every(x => Math.round(Number(x.hours) * x.rateCents) === x.amountCents) && i.lines.reduce((n, x) => n + x.amountCents, 0) === i.subtotalCents && i.subtotalCents === i.totalCents;
    const bank = l?.payment_status === "Paid" ? world.bank.filter(b => b.type === "ap_payment" && b.payor_payee === l.vendor_name && b.txn_date === l.payment_date && cents(b.amount_out) === cents(l.bill_amount)) : [];
    rows.push({ file, sha256: world.hashes[`${APEX_FILES.invoices}/${file}`], parsed: true, invoiceNumber: i.invoiceNumber, supplierPrinted: i.supplierName, vendorMasterName: vendor?.["Vendor Name"] ?? null, supplierNameMatchesMaster: vendor?.["Vendor Name"] === i.supplierName, ledgerRows: ledger.length, billId: l?.bill_id ?? null, ledgerStatus: l?.payment_status ?? null, totalMatchesLedger: !!l && cents(l.bill_amount) === i.totalCents, dateMatchesLedger: l?.txndate === i.invoiceDate, hours: i.lines.map(x => x.hours), rateCents: i.lines.map(x => x.rateCents), totalCents: i.totalCents, arithmeticExact, bankCandidates: bank.map(b => b.transaction_id) });
  }
  const parsed = rows.filter(r => r.parsed);
  record("inventory", { invoices: rows.length, parsed: parsed.length, ledgerMatched: parsed.filter(r => r.ledgerRows === 1 && r.totalMatchesLedger && r.dateMatchesLedger).length, paid: parsed.filter(r => r.ledgerStatus === "Paid").length, open: parsed.filter(r => r.ledgerStatus === "Open").length, paidWithOneBankCandidate: parsed.filter(r => r.ledgerStatus === "Paid" && r.bankCandidates.length === 1).length, arithmeticExact: parsed.filter(r => r.arithmeticExact).length, supplierNameMatchesMaster: parsed.filter(r => r.supplierNameMatchesMaster).length, rows, fileHashes: world.hashes, dataset: APEX_SOURCE });
}

async function case1Intake() {
  const reviewer = await session("ap-reviewer");
  const r = await upload(reviewer, "apex107-case1-invoice", [{ bytes: invoiceBytes(CASES.case1.file), name: CASES.case1.file, kind: "invoice" }]);
  assert.equal(r.status, 201, `Case 1 intake failed: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 300)}`);
  let d = await detail(reviewer, r.body.caseId);
  const comparison = await ledgerComparison(d, CASES.case1.billId);
  assert.ok(comparison.allMatch, "Parsed case 1 fields differ from the APEX ledger");
  const holdsBeforeReview = d.exceptions.map(e => e.code);
  await fieldReview(reviewer, d, "apex107-case1-fields-r1");
  d = await detail(reviewer, d.caseId);
  const paymentBeforeBill = await refused(reviewer, `/cases/${d.caseId}/payments`, { ...bind(d), idempotencyKey: "apex107-case1-pay-before-bill", executionDate: "2026-10-25" });
  record("case1-intake", { caseId: d.caseId, revision: d.revision, ledgerComparison: comparison, holdsBeforeReview, states: d.states, paymentBeforeBill, candidate: d.candidate, sources: d.sources.map(s => ({ sourceId: s.sourceId, revision: s.revision, sha256: s.sha256, name: s.name, kind: s.kind, parser: s.parser?.provider, pageStatus: s.pageStatus })) });
}

async function governance() {
  const governor = await session("governor"), verifier = await session("verifier"), controller = governor;
  const d = await detail(governor, caseIdFor("case1"));
  // The trusted contact cannot come from the invoice. The only non-invoice original is the SIMULATED agreement.
  const contractBinding = d.currentSourceBindings.find(b => d.sources.find(s => s.sourceId === b.sourceId)?.kind === "contract");
  assert.ok(contractBinding, "Run case1-evidence first: governance needs the SIMULATED agreement as non-invoice evidence");
  const subject = (id: string) => ACTORS.find(a => a.id === id)!.subject;
  const policy: BusinessPolicy = { version: POLICY_VERSION, groups: [{ groupId: "verify", members: [subject("verifier")] }, { groupId: "govern", members: [subject("governor")] }, { groupId: "matter-owner", members: [subject("matter-owner")] }, { groupId: "finance", members: [subject("finance")] }], supplierVerificationGroup: "verify", supplierApprovalGroup: "govern", varianceApprovalGroup: "finance", bands: [{ upToCents: Number.MAX_SAFE_INTEGER, steps: [{ groupId: "matter-owner", quorum: 1, escalateAfterMs: 86_400_000, escalationGroupId: null }, { groupId: "finance", quorum: 1, escalateAfterMs: 86_400_000, escalationGroupId: null }] }], accounts: [{ account: CODING.account, treatment: CODING.treatment }], stores: [], taxCodes: [{ code: "NONE", mode: "none" }], maxPriceVarianceBps: 0, maxDelegationMs: 86_400_000 };
  let view = await ok(governor, "/business");
  let p = view.policies.find((x: any) => x.version === POLICY_VERSION);
  if (!p) { await ok(controller, "/business/proposePolicy", { idempotencyKey: "apex107-policy-v1", policy }); view = await ok(governor, "/business"); p = view.policies.find((x: any) => x.version === POLICY_VERSION); }
  if (p.status !== "active") await ok(governor, "/business/activatePolicy", { policyId: p._id, expectedHash: p.hash, reason: "SIMULATED demo policy for APEX service invoices: matter owner then finance, account 6000 expense, no tax. Not a real firm policy." });
  view = await ok(governor, "/business");
  let contact = view.contacts.find((c: any) => c.supplierId === SUPPLIER.supplierId);
  if (!contact) { await ok(verifier, "/business/registerTrustedContact", { idempotencyKey: "apex107-contact-v1", supplierId: SUPPLIER.supplierId, phone: "+15555550107", evidence: [contractBinding], mode: "simulated" }); view = await ok(governor, "/business"); contact = view.contacts.find((c: any) => c.supplierId === SUPPLIER.supplierId); }
  const proposal = { supplierId: SUPPLIER.supplierId, legalName: d.candidate!.extractedSupplierName, aliases: [], contactId: contact._id, expectedRevision: 0, externalAccountId: BENEFICIARY, currency: "USD", catalog: [{ sku: "M-2024-0013", unit: "hour", unitPriceCents: 20000 }], evidence: [contractBinding], reason: "SIMULATED supplier master mirroring APEX vendor master V-041. The beneficiary account is simulated because APEX has no bank details for this supplier." };
  let supplier = view.revisions.find((r: any) => r.supplierId === SUPPLIER.supplierId && r.revision === 1);
  if (!supplier) { await ok(governor, "/business/proposeSupplier", { idempotencyKey: "apex107-supplier-v1", proposal }); view = await ok(governor, "/business"); supplier = view.revisions.find((r: any) => r.supplierId === SUPPLIER.supplierId && r.revision === 1); }
  if (!supplier.verification) await ok(verifier, "/business/verifySupplier", { revisionId: supplier._id, verification: { contactId: contact._id, method: "callback_previously_held_contact", result: "confirmed", performedAt: Date.now(), evidence: [contractBinding], mode: "simulated", reason: "SIMULATED callback. No real call was made." } });
  view = await ok(governor, "/business"); supplier = view.revisions.find((r: any) => r.supplierId === SUPPLIER.supplierId && r.revision === 1);
  if (supplier.status !== "approved") await ok(governor, "/business/approveSupplier", { revisionId: supplier._id, expectedHash: supplier.hash, reason: "SIMULATED governor approval of supplier revision 1." });
  view = await ok(governor, "/business");
  record("governance", { policyVersion: POLICY_VERSION, policyStatus: view.policies.find((x: any) => x.version === POLICY_VERSION)?.status, supplierStatus: view.revisions.find((r: any) => r.supplierId === SUPPLIER.supplierId && r.revision === 1)?.status, beneficiary: BENEFICIARY, simulated: ["policy", "trusted contact", "supplier verification callback", "beneficiary account", "all approving identities"], governance: view });
}

function acceptanceFor(d: APCaseDetail, withEvidence: boolean): BusinessAcceptance {
  const c = d.candidate!, line = c.lines[0]!;
  const contract = d.purchasingEvidence.find(p => p.kind === "contract"), accepted = d.purchasingEvidence.find(p => p.kind === "service_acceptance");
  return {
    lines: [{ lineId: line.lineId, quantity: line.quantity.decimal, netCents: line.amountCents, taxCents: 0, taxCode: "NONE", allocations: [{ account: CODING.account, amountCents: line.amountCents, store: null, department: null, project: null, period: c.invoiceDate.slice(0, 7), treatment: CODING.treatment }], procurement: "non_po",
      agreement: withEvidence && contract ? { source: contract.source, lineId: contract.lines[0]!.lineId } : null,
      receipts: withEvidence && accepted ? [{ source: accepted.source, lineId: accepted.lines[0]!.lineId, quantity: line.quantity.decimal }] : [] }],
    freightCents: 0, freightAllocations: [], discountCents: 0, discountAllocations: [], resolutions: [],
    reason: withEvidence ? "Accept all invoiced hours against the SIMULATED agreement and SIMULATED service acceptance." : "Attempt to accept the APEX invoice with only the original invoice and no contract or service acceptance.",
  };
}
async function case1Hold() {
  const governor = await session("ap-reviewer");
  const d = await detail(governor, caseIdFor("case1"));
  const r = await governor("/business/propose", { caseId: d.caseId, ...bind(d), idempotencyKey: "apex107-case1-propose-without-evidence", policyVersion: POLICY_VERSION, supplierRevision: 1, acceptance: acceptanceFor(d, false) });
  const after = await detail(governor, d.caseId);
  const proposals = (await ok(governor, "/business/proposals")).filter((p: any) => p.caseId === d.caseId);
  assert.equal(after.journals.length, 0, "Missing evidence must not recognize a bill");
  record("case1-hold", { caseId: d.caseId, proposeStatus: r.status, proposeResult: r.body, exceptions: after.exceptions, domain: after.domain, proposals, missingEvidence: ["contract or rate agreement for the matter", "service acceptance by a matter owner", "supplier bank/beneficiary details", "firm AP approval policy for contract-attorney invoices", "W-9 / 1099 vendor tax documentation (not modeled by this AP system)"] });
}
async function case1Evidence() {
  const reviewer = await session("ap-reviewer");
  const before = await detail(reviewer, caseIdFor("case1"));
  const line = before.candidate!.lines[0]!;
  const docs = [
    { bytes: invoiceBytes(CASES.case1.file), name: CASES.case1.file, kind: "invoice" },
    { bytes: simulatedContract(line.sku!), name: "SIMULATED-agreement-avila-" + line.sku + ".pdf", kind: "contract" },
    { bytes: simulatedAcceptance(CASES.case1.invoiceNumber, line.sku!, line.quantity.decimal), name: "SIMULATED-service-acceptance-" + CASES.case1.invoiceNumber + ".pdf", kind: "receipt" },
  ];
  const r = await upload(reviewer, "apex107-case1-with-simulated-evidence", docs, before.caseId);
  assert.ok(r.status === 201 || r.status === 200, `Revision intake failed: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 300)}`);
  assert.equal(r.body.caseId, before.caseId, "Evidence must revise the same case");
  let d = await detail(reviewer, before.caseId);
  if (!d.decisions.some(x => x.kind === "field_review" && x.candidateRevision === d.revision)) await fieldReview(reviewer, d, `apex107-case1-fields-r${d.revision}`);
  d = await detail(reviewer, d.caseId);
  record("case1-evidence", { caseId: d.caseId, revision: d.revision, purchasingEvidence: d.purchasingEvidence, simulatedDocuments: docs.slice(1).map(x => ({ name: x.name, kind: x.kind, sha256: hash(x.bytes), label: "SIMULATED, generated by the replay adapter, not APEX data" })), sources: d.sources.map(s => ({ sourceId: s.sourceId, revision: s.revision, sha256: s.sha256, name: s.name, kind: s.kind })) });
}
async function vote(actorId: string, caseId: string, key: string) {
  const call = await session(actorId);
  const p = (await ok(call, "/business/proposals")).find((x: any) => x.caseId === caseId && x.status === "pending");
  if (!p) return null;
  return ok(call, "/business/vote", { proposalId: p._id, proposalHash: p.hash, idempotencyKey: key, outcome: "approved", reason: `SIMULATED ${actorId} approval of the exact proposal hash` });
}
async function case1Approve() {
  const proposer = await session("ap-reviewer");
  let d = await detail(proposer, caseIdFor("case1"));
  if (!d.journals.length) {
    const existing = (await ok(proposer, "/business/proposals")).find((x: any) => x.caseId === d.caseId && x.status === "pending");
    if (!existing) await ok(proposer, "/business/propose", { caseId: d.caseId, ...bind(d), idempotencyKey: `apex107-case1-propose-r${d.revision}`, policyVersion: POLICY_VERSION, supplierRevision: 1, acceptance: acceptanceFor(d, true) });
    await vote("matter-owner", d.caseId, "apex107-case1-vote-matter-owner");
    await vote("finance", d.caseId, "apex107-case1-vote-finance");
  }
  d = await detail(proposer, d.caseId);
  assert.equal(d.states.accounting, "recognized", "Approved bill must be recognized");
  assert.equal(d.amounts.acceptedCents, CASES.case1.amountCents, "Accepted amount differs from the original invoice");
  record("case1-approve", { caseId: d.caseId, states: d.states, amounts: d.amounts, links: d.links, journals: d.journals, proposals: (await ok(proposer, "/business/proposals")).filter((x: any) => x.caseId === d.caseId) });
}
async function case1Pay() {
  const payments = await session("ap-reviewer"), treasury = await session("treasury");
  let d = await detail(treasury, caseIdFor("case1"));
  let versionId = d.payments.find(p => p.status !== "cancelled")?.versionId;
  let requested: any = null;
  if (!versionId) { requested = await ok(payments, `/cases/${d.caseId}/payments`, { ...bind(d), idempotencyKey: "apex107-case1-payment", executionDate: "2026-10-25" }); versionId = requested.versionId; d = await detail(treasury, d.caseId); }
  const pay = d.payments.find(p => p.versionId === versionId)!;
  let authorized: any = null, staleRefused: any = null;
  if (!pay.commandId) {
    const paymentView = await ok(treasury, `/payments/${encodeURIComponent(versionId!)}`);
    staleRefused = await refused(treasury, `/cases/${d.caseId}/payments/${versionId}/authorize`, { ...bind(d), paymentSnapshotHash: "0".repeat(64) });
    authorized = await ok(treasury, `/cases/${d.caseId}/payments/${versionId}/authorize`, { ...bind(d), paymentSnapshotHash: requested?.snapshotHash ?? paymentView.snapshotHash ?? paymentView.version?.snapshotHash });
    d = await detail(treasury, d.caseId);
  }
  const b = bank(); let transfers; try { transfers = b.harness.inspect().transfers.length; } finally { b.close(); }
  record("case1-pay", { caseId: d.caseId, versionId, requested, authorized, staleRefused, payments: d.payments, states: d.states, transfersBeforeWorker: transfers });
}
async function worker() {
  const b = bank();
  try {
    const dispatcher = createPaymentDispatcher(agent, SCOPE, saved.dispatcher, b.provider, "apex107-dispatcher");
    const evidence = createEvidenceWorker(agent, SCOPE, saved.evidence, b.provider, "apex107-evidence");
    const dispatched = await dispatcher.tick();
    const settled: string[] = [];
    for (const t of b.harness.inspect().transfers) if (t.status === "pending") { b.harness.settle(t.id); settled.push(t.id); }
    const observed = await evidence.tick(), repeated = [await evidence.tick(), await dispatcher.tick()];
    const snapshot = b.harness.inspect();
    record("worker", { dispatched, simulatedSettlement: settled, observed, repeated, transfers: snapshot.transfers, transactions: snapshot.transactions, calls: snapshot.calls, note: "FakeBank settlement is explicitly simulated by the harness. These are new local observations, not APEX bank rows." });
  } finally { b.close(); }
}
async function case2() {
  const reviewer = await session("ap-reviewer"), treasury = await session("treasury");
  const world = await loadApexWorld(APEX_ROOT);
  const c = CASES.case2;
  const statementText = execFileSync(PDFTOTEXT, ["-layout", world.statementPath(c.statement), "-"], { encoding: "utf8" });
  const historical = historicalPaymentChecks(world, { billId: c.billId, bankTransactionId: c.bankTransactionId, reference: c.reference, statementText });
  assert.ok(historical.passed, "Historical reconciliation checks failed: " + historical.checks.filter(x => !x.passed).map(x => x.check).join("; "));
  const r = await upload(reviewer, "apex107-case2-invoice", [{ bytes: invoiceBytes(c.file), name: c.file, kind: "invoice" }]);
  assert.equal(r.status, 201, "Case 2 intake failed");
  let d = await detail(reviewer, r.body.caseId);
  const comparison = await ledgerComparison(d, c.billId);
  assert.ok(comparison.allMatch, "Parsed case 2 fields differ from the APEX ledger");
  if (!d.decisions.some(x => x.kind === "field_review")) await fieldReview(reviewer, d, "apex107-case2-fields-r1");
  d = await detail(reviewer, d.caseId);
  // The importer never proposes approval or payment for a source-paid invoice. The backend independently refuses payment without an approved bill.
  const sourcePaidGuard = { sourceStatus: c.sourceStatus, importerAction: "historical_reference_only", proposed: false };
  const paymentRefused = await refused(treasury, `/cases/${d.caseId}/payments`, { ...bind(d), idempotencyKey: "apex107-case2-second-payment-attempt", executionDate: "2026-10-25" });
  const b = bank(); let snapshot; try { snapshot = b.harness.inspect(); } finally { b.close(); }
  assert.ok(!snapshot.transfers.some(t => t.amountCents === c.amountCents), "No FakeBank transfer may exist for the source-paid case");
  assert.equal(d.journals.length, 0, "Source-paid case must not post new journals");
  assert.equal(d.payments.length, 0, "Source-paid case must not have a payment version");
  record("case2", { caseId: d.caseId, revision: d.revision, ledgerComparison: comparison, historicalSourceOutcome: historical, sourcePaidGuard, paymentRefused, states: d.states, amounts: d.amounts, exceptions: d.exceptions.map(e => e.code), fakeBankTransfers: snapshot.transfers.length });
}
async function counts() {
  const call = await session("treasury");
  const cases = await ok(call, "/cases");
  const ids = [caseIdFor("case1"), caseIdFor("case2")];
  const details = await Promise.all(ids.map(id => detail(call, id)));
  const review = await humanFor("treasury").query(q("demoPayments:humanReview"), { scope: SCOPE });
  const evidence = await humanFor("treasury").query(q("demoEvidence:humanView"), { scope: SCOPE });
  const b = bank(); let snapshot; try { snapshot = b.harness.inspect(); } finally { b.close(); }
  return { cases: cases.length, bills: review.bills.length, paymentVersions: review.versions.length, commands: review.commands.length, journals: details.reduce((n, x) => n + x.journals.length, 0), bankTransactionsPosted: evidence.transactions.length, fakeBankTransfers: snapshot.transfers.length, fakeBankCreateCalls: snapshot.calls.createTransfer, perCase: details.map(x => ({ caseId: x.caseId, revision: x.revision, journals: x.journals.length, payments: x.payments.length, states: x.states })) };
}
async function reimport() {
  const reviewer = await session("ap-reviewer"), treasury = await session("treasury");
  const before = await counts();
  const replays = [];
  for (const [key, c] of Object.entries(CASES) as ["case1" | "case2", (typeof CASES)[keyof typeof CASES]][]) {
    const same = await upload(reviewer, `apex107-${key}-invoice`, [{ bytes: invoiceBytes(c.file), name: c.file, kind: "invoice" }]);
    const renamed = await upload(reviewer, `apex107-${key}-reimport-renamed`, [{ bytes: invoiceBytes(c.file), name: "reimport-" + c.file, kind: "invoice" }]);
    replays.push({ case: key, expectedCaseId: caseIdFor(key), sameKey: { status: same.status, caseId: same.body?.caseId ?? null, error: same.body?.error?.code ?? null }, newKeyRenamed: { status: renamed.status, caseId: renamed.body?.caseId ?? null, error: renamed.body?.error?.code ?? null } });
  }
  const d1 = await detail(treasury, caseIdFor("case1"));
  const resubmitPayment = await treasury(`/cases/${d1.caseId}/payments`, { ...bind(d1), idempotencyKey: "apex107-case1-payment", executionDate: "2026-10-25" });
  const secondPayment = await treasury(`/cases/${d1.caseId}/payments`, { ...bind(d1), idempotencyKey: "apex107-case1-second-payment", executionDate: "2026-10-25" });
  const after = await counts();
  for (const r of replays) for (const k of ["sameKey", "newKeyRenamed"] as const) assert.ok(r[k].caseId === r.expectedCaseId || (r[k].status >= 400 && r[k].status < 500), "A re-import must resolve to the existing case or be refused");
  for (const k of ["cases", "bills", "paymentVersions", "commands", "journals", "bankTransactionsPosted", "fakeBankTransfers", "fakeBankCreateCalls"] as const) assert.equal(after[k], before[k], `Re-import changed ${k}`);
  record("reimport", { replays, resubmitPayment: { status: resubmitPayment.status, body: resubmitPayment.body }, secondPayment: { status: secondPayment.status, error: secondPayment.body?.error ?? null }, before, after });
}
async function report() {
  const call = await session("treasury");
  const d1 = await detail(call, caseIdFor("case1")), d2 = await detail(call, caseIdFor("case2"));
  const finalCounts = await counts();
  const poppler = await popplerVersion(PDFTOTEXT);
  const world = await loadApexWorld(APEX_ROOT);
  const pay = proof("case1-pay"), work = proof("worker");
  const out = {
    issue: 107, runId: RUN, recordedAt: new Date().toISOString(), sourceCommit,
    versions: { code: sourceCommit, apContract: AP_CONTRACT_VERSION, legacyPolicy: AP_POLICY_VERSION, businessPolicy: POLICY_VERSION, paymentExecutor: PAYMENT_EXECUTOR_VERSION, parser: { provider: "local-poppler-pdftotext", poppler, implementation: TEXT_LAYER_IMPLEMENTATION }, convexBackend: "precompiled-2026-10-10-72ce13c" },
    data: { ...APEX_SOURCE, files: Object.fromEntries(Object.entries(world.hashes).filter(([k]) => [CASES.case1.file, CASES.case2.file, CASES.case2.statement].some(f => k.endsWith(f)) || !k.includes(".pdf"))) },
    providerModes: { bank: "FakeBank (local, explicitly simulated settlement)", identity: "simulated local actors", parser: "local text layer, zero paid parser calls", models: "none (AGENT_LLM=off)", increase: "blocked: needs JJ's sandbox credentials", quickbooks: "blocked: needs JJ's sandbox credentials", auth0: "blocked: needs JJ's sandbox credentials" },
    case1: { caseId: d1.caseId, invoice: CASES.case1.invoiceNumber, billId: CASES.case1.billId, revision: d1.revision, states: d1.states, amounts: d1.amounts, links: d1.links, journals: d1.journals, payments: d1.payments, sources: d1.sources.map(s => ({ name: s.name, kind: s.kind, revision: s.revision, sha256: s.sha256 })), decisions: d1.decisions.map(x => ({ kind: x.kind, actor: x.actor, actorKind: x.actorKind, outcome: x.outcome, candidateRevision: x.candidateRevision })), localIds: { versionId: pay.versionId, commandId: pay.authorized?.commandId ?? d1.payments[0]?.commandId ?? null, fakeBankTransferIds: work.transfers.map((t: any) => t.id), fakeBankTransactionIds: work.transactions.map((t: any) => t.id) } },
    case2: { caseId: d2.caseId, invoice: CASES.case2.invoiceNumber, billId: CASES.case2.billId, states: d2.states, amounts: d2.amounts, journals: d2.journals.length, payments: d2.payments.length, historicalSourceOutcome: proof("case2").historicalSourceOutcome, paymentRefused: proof("case2").paymentRefused },
    reimport: proof("reimport"), finalCounts, inventory: (({ rows, fileHashes, ...rest }) => rest)(proof("inventory")), externalIds: "none: no external provider was called",
  };
  const target = path.join(ROOT, "docs/ap-orchestration/evidence/apex-107");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "run.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(path.join(target, "inventory.json"), JSON.stringify({ dataset: APEX_SOURCE, rows: proof("inventory").rows }, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "report", status: "written", file: "docs/ap-orchestration/evidence/apex-107/run.json", finalCounts }));
}

if (phase === "serve") await serve();
else {
  try {
    await ({ inventory, "case1-intake": case1Intake, governance, "case1-hold": case1Hold, "case1-evidence": case1Evidence, "case1-approve": case1Approve, "case1-pay": case1Pay, worker, case2, reimport, report }[phase])();
  } catch (error) {
    console.error(JSON.stringify({ phase, status: "failed", reason: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  }
}
