/** Real local HTTP + deployed Convex source preservation check; no PDF extraction/model claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServiceFromEnv } from "../src/invoice-mvp/service";
import { createInvoiceServer } from "../src/invoice-mvp/server";

const service = createServiceFromEnv();
assert.equal(service.mode, "deterministic");
const origin = "http://127.0.0.1:8793";
const server = createInvoiceServer(service, { port: 8793, allowedOrigins: [origin], autoProcess: false });
await new Promise<void>((resolve) => server.listen(8793, "127.0.0.1", resolve));
try {
  const base = `${origin}/api/invoice-mvp`;
  const workspace = await fetch(`${base}/workspace`);
  assert.equal(workspace.status, 200);
  const cookie = workspace.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Origin: origin, Cookie: cookie, "X-Invoice-MVP-Session": "1", "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/process`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/workspace`, { headers: { Origin: "https://untrusted.example" } })).status, 403);
  const original = Buffer.alloc(900_000, 80);
  Buffer.from("%PDF-synthetic-storage-test-not-a-renderable-document\n").copy(original);
  const source = { externalId: "public-storage-smoke", name: "synthetic-original-storage-test.pdf", mimeType: "application/pdf", text: "UNSUPPORTED STORAGE FIXTURE\nThis test only verifies original bytes and HTTP import, not PDF extraction.", contentBase64: original.toString("base64") };
  const response = await fetch(`${base}/batches`, { method: "POST", headers, body: JSON.stringify({ label: "Public synthetic original-byte storage check", documents: [source] }) });
  assert.equal(response.status, 202);
  const processed = await fetch(`${base}/process`, { method: "POST", headers, body: "{}" });
  assert.equal(processed.status, 200);
  assert.deepEqual((await processed.json() as { errors: unknown[] }).errors, []);
  const current = await service.workspace();
  const c = current.cases.find((c) => c.externalId === source.externalId)!;
  const detail = await (await fetch(`${base}/cases/${encodeURIComponent(c.caseId)}`)).json() as { source: { contentBase64: string }; case: { status: string } };
  const restored = Buffer.from(detail.source.contentBase64, "base64");
  assert.deepEqual(restored, original);
  assert.equal(detail.case.status, "evidence_missing");
  const runtime = await (await fetch(`${base}/runtime`)).json();
  console.log(JSON.stringify({ result: "PASS", sourceCommit: runtime.sourceCommit, backend: "deployed Convex through loopback HTTP", originalBytes: restored.length, sha256: createHash("sha256").update(restored).digest("hex"), sessionWithoutCookie: 401, forbiddenOrigin: 403, sourceStatus: detail.case.status, modelCalls: 0, pdfExtraction: "NOT RUN — synthetic opaque bytes only", liveEvaluation: "NOT RUN" }, null, 2));
} finally {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
