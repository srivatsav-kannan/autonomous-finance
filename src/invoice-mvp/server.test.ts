import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createInvoiceServer } from "./server";
import { InvoiceService, MAX_TEXT_BYTES } from "./service";
import { TestBackend } from "./test-backend";
import { demoBatch } from "./demo";
import { InvoiceError, ConvexInvoiceBackend } from "./backend";
import type { ConvexHttpClient } from "convex/browser";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }))); });
async function start() {
  const backend = new TestBackend(), service = new InvoiceService(backend);
  const server = createInvoiceServer(service, { port: 0, allowedOrigins: ["http://127.0.0.1:5173"], autoProcess: false });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const base = `http://127.0.0.1:${address.port}/api/invoice-mvp`;
  const workspace = await fetch(`${base}/workspace`);
  const cookie = workspace.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Origin: "http://127.0.0.1:5173", Cookie: cookie, "X-Invoice-MVP-Session": "1", "Content-Type": "application/json" };
  return { backend, service, base, headers, workspace };
}
describe("loopback HTTP application boundary (synthetic backend tests)", () => {
  it("bootstraps HttpOnly same-site session and exposes attestation without tokens", async () => {
    const { base, workspace } = await start();
    expect(workspace.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const runtime = await (await fetch(`${base}/runtime`)).json();
    expect(runtime).toMatchObject({ mode: "deterministic", fallbacks: false, retries: 0, usage: { available: true }, limits: { maxDocuments: 100 } });
    expect(JSON.stringify(runtime)).not.toMatch(/humanToken|investigatorToken|ANTHROPIC_API_KEY/);
  });
  it("rejects missing session, missing origin, cross-origin requests and privilege injection", async () => {
    const { base, headers } = await start();
    const post = (h: Record<string, string>, body = "{}") => fetch(`${base}/process`, { method: "POST", headers: h, body });
    expect((await post({ "Content-Type": "application/json", Origin: headers.Origin })).status).toBe(401);
    const { Origin, ...noOrigin } = headers;
    expect((await post(noOrigin)).status).toBe(403);
    expect((await post({ ...headers, Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await post(headers, JSON.stringify({ seatId: "admin", token: "fake" }))).status).toBe(400);
    expect((await fetch(`${base}/workspace`, { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
  });
  it("rejects DNS-rebinding Host headers", async () => {
    const { base } = await start();
    const response = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${base}/workspace`, { headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    expect(response).toBe(403);
  });
  it("imports through service, processes, then returns consistent stale-decision errors", async () => {
    const { base, headers, backend } = await start();
    const response = await fetch(`${base}/batches`, { method: "POST", headers, body: JSON.stringify({ label: "HTTP synthetic", documents: [demoBatch().documents[2]] }) });
    expect(response.status).toBe(202); expect(await response.json()).toHaveProperty("batchId");
    expect((await fetch(`${base}/process`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    const detail = [...backend.details.values()][0]!;
    expect((await fetch(`${base}/cases/${detail.case.caseId}`)).status).toBe(200);
    const decision = await fetch(`${base}/decisions`, { method: "POST", headers, body: JSON.stringify({ caseId: detail.case.caseId, proposalId: "stale", evidenceVersion: 1, idempotencyKey: "d1", action: "accept" }) });
    expect(decision.status).toBe(409); expect(await decision.json()).toEqual({ error: { code: "stale_proposal", message: "Proposal changed." } });
  });
  it("redacts unexpected backend errors", async () => {
    const { base, service } = await start();
    vi.spyOn(service, "workspace").mockRejectedValue(new Error("secret-token-example"));
    const response = await fetch(`${base}/workspace`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-token-example");
  });
});

describe("service import validation and authority separation", () => {
  it("preserves PDF original bytes and rejects missing originals, mismatched text and oversize UTF8", async () => {
    const backend = new TestBackend(), service = new InvoiceService(backend);
    const doc = { ...demoBatch().documents[2]!, mimeType: "application/pdf", contentBase64: Buffer.from("%PDF-synthetic-test-only").toString("base64") };
    const result = await service.ingestBatch({ label: "PDF extracted upstream", documents: [doc] });
    expect((await service.caseDetail(result.caseIds[0]!)).source.contentBase64).toBe(doc.contentBase64);
    await expect(service.ingestBatch({ label: "missing", documents: [{ ...doc, contentBase64: undefined }] })).rejects.toMatchObject({ code: "original_required" });
    await expect(service.ingestBatch({ label: "mismatch", documents: [{ ...doc, mimeType: "text/plain" }] })).rejects.toMatchObject({ code: "source_text_mismatch" });
    await expect(service.ingestBatch({ label: "oversize", documents: [{ ...doc, text: "文".repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1) }] })).rejects.toMatchObject({ code: "text_too_large" });
  });
  it("persists visible evidence-missing fallback after a processing failure", async () => {
    const backend = new TestBackend(), service = new InvoiceService(backend);
    await service.ingestBatch({ label: "failure", documents: [demoBatch().documents[2]!] });
    vi.spyOn(backend, "workspace").mockRejectedValueOnce(new Error("synthetic failure"));
    const result = await service.processPending();
    expect(result.errors).toHaveLength(1);
    expect([...backend.details.values()][0]!.case.status).toBe("evidence_missing");
    expect([...backend.details.values()][0]!.currentProposal?.conclusion.question).toContain("preserved source");
  });
  it("preserves CRLF original bytes with normalized text and retains unknown MIME as unresolved evidence", async () => {
    const backend = new TestBackend(), service = new InvoiceService(backend);
    const original = "UNFAMILIAR\r\nA preserved source\r\n";
    const result = await service.ingestBatch({ label: "Normalized UTF8", documents: [{ externalId: "crlf", name: "source.txt", mimeType: "text/plain", text: original.replaceAll("\r\n", "\n"), contentBase64: Buffer.from(original).toString("base64") }, { externalId: "mbox", name: "mail.mbox", mimeType: "application/mbox", text: "INVOICE\nEmail text is not a billing source", contentBase64: Buffer.from("INVOICE\nEmail text is not a billing source").toString("base64") }] });
    expect((await service.caseDetail(result.caseIds[0]!)).source.contentBase64).toBe(Buffer.from(original).toString("base64"));
    await service.processPending();
    expect((await service.caseDetail(result.caseIds[1]!)).case.status).toBe("evidence_missing");
  });
  it("authenticates human ingestion/decision separately from investigator actions", async () => {
    const received: Record<string, unknown>[] = [];
    const client = { mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => { received.push(args); return { ok: true, value: {} }; }) } as unknown as ConvexHttpClient;
    const human = { runId: "r", seatId: "human", token: "human-test-only" }, investigator = { runId: "r", seatId: "investigator", token: "investigator-test-only" };
    const backend = new ConvexInvoiceBackend(client, human, investigator);
    await backend.ingestBatch({ label: "test", documents: [], idempotencyKey: "test" });
    await backend.beginInvestigation("c");
    await backend.decide({ caseId: "c", proposalId: "p", evidenceVersion: 1, action: "exclude", idempotencyKey: "decision" });
    expect(received.map((a) => a.seatId)).toEqual(["human", "investigator", "human"]);
    expect(() => new ConvexInvoiceBackend(client, human, { ...investigator, runId: "other" })).toThrow(InvoiceError);
  });
});
