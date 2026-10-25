/** Import and verify the complete available World 9 invoice corpus through the real local gateway.
 * No bill approval, payment request, authorization, settlement, or external provider call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { caseDetailSchema, type APCaseDetail } from "../../src/ap-system/contracts";
import { buildApexCorpus, corpusEntryForCase, type ApexCorpusEntry } from "../../src/ap-system/replay/apex-corpus";
import { APEX_SOURCE, loadApexWorld } from "../../src/ap-system/replay/apex-sources";

const RUN = process.env.APEX_RUN_ID ?? "apex107-replay-20261025", GATEWAY = "http://127.0.0.1:8847", ORIGIN = "http://127.0.0.1:5192";
const mode = process.argv[2] ?? "verify";
assert.ok(["inventory", "import", "verify", "reimport"].includes(mode), "Usage: tsx scripts/ap-system/apex-corpus.ts inventory|import|verify|reimport");
const worldRoot = path.resolve(process.env.APEX_WORLD_ROOT ?? "var/benchmarks/finance-eight/private/raw/apex-world");
const world = await loadApexWorld(worldRoot);
const corpus = await buildApexCorpus(world, process.env.PDFTOTEXT_PATH ?? "pdftotext");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reportDir = path.resolve("var", RUN);
const report = (data: object) => {
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const file = path.join(reportDir, `corpus-${mode}.json`), tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ recordedAt: new Date().toISOString(), runId: RUN, mode, dataset: APEX_SOURCE, corpus, ...data }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  console.log(JSON.stringify({ mode, ...Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value !== "object")), report: path.relative(process.cwd(), file) }));
};

if (mode === "inventory") {
  report({ totalInvoices: corpus.totalInvoices, parsedInvoices: corpus.parsedInvoices, sourcePaidInvoices: corpus.sourcePaidInvoices, openInvoices: corpus.openInvoices, unresolvedInvoices: corpus.unresolvedInvoices, supplierCount: corpus.supplierCount, reconciledHistoricalInvoices: corpus.reconciledHistoricalInvoices });
} else {
  const runtime = await (await fetch(GATEWAY + "/api/ap-system/runtime", { redirect: "error", signal: AbortSignal.timeout(5000) })).json();
  assert.equal(runtime.runId, RUN, "Wrong runtime; corpus import is restricted to the isolated APEX local run");
  assert.equal(runtime.identityMode, "simulated_human");
  assert.equal(runtime.scope?.provider, "fake"); assert.equal(runtime.scope?.environment, "local");
  assert.equal(runtime.scope?.organizationId, "apex107-synthetic-sterling-marsh");
  assert.equal(runtime.scope?.accountId, "apex107-usd-operating"); assert.equal(runtime.scope?.runId, RUN);
  assert.equal(runtime.corpus?.totalInvoices, corpus.totalInvoices, "Restart the gateway with full corpus support before importing");
  assert.deepEqual(runtime.corpus.entries.map((e: ApexCorpusEntry) => [e.file, e.sha256]).sort(), corpus.entries.map(e => [e.file, e.sha256]).sort(), "Gateway corpus differs from local original files");
  const authorization = "Bearer local:ap-reviewer";
  const opened = await fetch(GATEWAY + "/api/ap-system/cases", { headers: { authorization }, redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(opened.status, 200, "The simulated AP reviewer cannot open the workspace");
  const cookie = opened.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie, "Gateway session cookie is missing");
  const before = caseDetailSchema.array().parse(await opened.json());
  const request = (route: string, data?: FormData) => fetch(GATEWAY + "/api/ap-system" + route, { method: data ? "POST" : "GET", headers: { authorization, cookie, ...(data ? { origin: ORIGIN, "X-AP-System-Session": "1" } : {}) }, body: data, redirect: "error", signal: AbortSignal.timeout(120000) });
  const upload = async (entry: ApexCorpusEntry, renamed = false) => {
    const bytes = readFileSync(world.invoicePath(entry.file));
    assert.equal(digest(bytes), entry.sha256, "Original changed after inventory");
    const form = new FormData();
    form.append("documents", new Blob([bytes], { type: "application/pdf" }), (renamed ? "reimport-" : "") + entry.file);
    form.set("kinds", JSON.stringify(["invoice"]));
    form.set("idempotencyKey", `apex107-corpus-${renamed ? "reimport" : "original"}-${entry.sha256}`);
    const response = await request("/intake", form);
    return { status: response.status, body: await response.json() };
  };
  const beforeMap = new Map(before.map(d => [corpusEntryForCase(d, corpus)?.sha256, d]));
  const imported: string[] = [], replayResults: object[] = [];
  if (mode === "import") {
    for (const entry of corpus.entries) {
      if (beforeMap.has(entry.sha256)) continue;
      const result = await upload(entry);
      assert.ok(result.status >= 200 && result.status < 300, `Import ${entry.file}: ${result.status} ${JSON.stringify(result.body)}`);
      assert.ok(typeof result.body.caseId === "string", "Import did not return a case id");
      imported.push(result.body.caseId);
      console.log(JSON.stringify({ imported: entry.file, caseId: result.body.caseId, sourceClassification: entry.classification }));
    }
  } else if (mode === "reimport") {
    assert.equal(corpus.entries.filter(e => beforeMap.has(e.sha256)).length, corpus.totalInvoices, "Import the whole corpus before testing reimport");
    for (const entry of corpus.entries) {
      const result = await upload(entry, true), expected = beforeMap.get(entry.sha256)!;
      const duplicate = result.status >= 200 && result.status < 300 && result.body.caseId === expected.caseId;
      const refusedRevision = result.status === 409 && result.body?.error?.code === "explicit_revision_required";
      assert.ok(duplicate || refusedRevision, `Reimport ${entry.file} did not resolve to its existing case or a required explicit revision: ${JSON.stringify(result)}`);
      replayResults.push({ file: entry.file, caseId: expected.caseId, status: result.status, duplicate, reason: result.body.error?.code ?? null });
    }
  }
  const response = await request("/cases"); assert.equal(response.status, 200);
  const after = caseDetailSchema.array().parse(await response.json());
  const verified: { file: string; caseId: string; parsed: boolean; supplierBound: boolean; originalHashVerified: boolean; historicalGuard: boolean | null; exceptions: string[] }[] = [];
  for (const entry of corpus.entries) {
    const matches = after.filter(d => corpusEntryForCase(d, corpus)?.sha256 === entry.sha256);
    assert.equal(matches.length, 1, `${entry.file} must have exactly one current imported case`);
    const d = matches[0]!;
    assert.equal(d.candidate?.invoiceNumber, entry.invoiceNumber, `${entry.file} invoice number differs from original`);
    assert.equal(d.candidate?.totalCents, entry.totalCents, `${entry.file} total differs from original`);
    assert.equal(d.candidate?.supplierId, entry.supplierId, `${entry.file} is bound to the wrong supplier`);
    const source = d.sources.find(s => s.kind === "invoice" && s.sha256 === entry.sha256)!;
    const original = await request(`/sources/${encodeURIComponent(source.sourceId)}/revisions/${source.revision}?sha256=${source.sha256}`);
    assert.equal(original.status, 200, `${entry.file} original cannot be downloaded through its authenticated source route`);
    assert.equal(digest(new Uint8Array(await original.arrayBuffer())), entry.sha256, `${entry.file} downloaded original hash differs`);
    const historical = entry.classification === "historical_paid";
    if (historical) {
      assert.equal(d.sourceOutcome?.status, "historical_paid", `${entry.file} is missing the retained historical-payment guard`);
      assert.equal(d.sourceOutcome?.amountCents, entry.totalCents);
      assert.equal(d.sourceOutcome?.sourceReference, entry.billId);
      assert.equal(d.payments.length, 0, `${entry.file}: historical source must not create a new payment`);
      assert.equal(d.journals.length, 0, `${entry.file}: historical source must not create a new journal`);
    }
    if (imported.includes(d.caseId)) { assert.equal(d.payments.length, 0); assert.equal(d.journals.length, 0); }
    verified.push({ file: entry.file, caseId: d.caseId, parsed: d.extraction.status === "complete", supplierBound: d.candidate?.supplierId === entry.supplierId, originalHashVerified: true, historicalGuard: historical ? true : null, exceptions: d.exceptions.map(e => e.code) });
  }
  const activity = (cases: APCaseDetail[]) => ({ payments: cases.reduce((n, c) => n + c.payments.length, 0), journals: cases.reduce((n, c) => n + c.journals.length, 0) });
  assert.deepEqual(activity(after), activity(before), "Corpus intake/reimport must not create financial activity");
  if (mode === "reimport" || mode === "verify") assert.equal(after.length, before.length, "Verification/reimport must not add a case");
  report({ imported: imported.length, casesBefore: before.length, casesAfter: after.length, importedOriginals: verified.length, parsedOriginals: verified.filter(v => v.parsed).length, supplierBindings: verified.filter(v => v.supplierBound).length, historicalGuards: verified.filter(v => v.historicalGuard).length, originalDownloadsVerified: verified.length, financialActivity: activity(after), verified, replayResults });
}
