import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtures from "../fixtures/increase/lifecycle.json";
import { buildIncreaseRequestBody, commandRequestHash, type BankCommand, type BankScope } from "../contracts.js";
import { IncreaseSandboxBank, increaseRequestBody } from "./increase.js";

// Real Prism validating HTTP proxy: both requests and fixture responses traverse the pinned schema.
// Fixture server models only contracts; behavioral/recovery assertions live in the other suites.
describe("Prism pinned Increase HTTP contract", () => {
  let server: Server;
  let prism: ChildProcess;
  let origin: string;
  let mode: "valid" | "invalid-response" | "rate-limit" = "valid";
  const scope: BankScope = { organizationId: "org", runId: "run", provider: "increase", environment: "sandbox", accountId: "account_demo" };
  let command: BankCommand;
  let provider: IncreaseSandboxBank;
  const headers = { Authorization: "Bearer contract-only", "Content-Type": "application/json", "Idempotency-Key": "ap-demo-key-1" };
  beforeAll(async () => {
    command = { scope, commandId: "cmd_demo", amountCents: 2500, currency: "USD", destination: { externalAccountId: "external_account_vendor", version: "v1" }, approvalVersion: "approved-v1", idempotencyKey: "ap-demo-key-1", requestHash: "" };
    command.providerRequest = buildIncreaseRequestBody(command);
    command.requestHash = await commandRequestHash(command);
    server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");
      if (mode === "rate-limit") { response.statusCode = 429; response.setHeader("retry-after", "2"); response.end(JSON.stringify(fixtures.error)); return; }
      const pathname = new URL(request.url!, "http://fixture").pathname;
      let body: unknown = pathname.startsWith("/transactions/") ? fixtures.debit : pathname === "/transactions" ? { data: [fixtures.debit], next_cursor: null } : pathname === "/events" ? { data: [fixtures.event], next_cursor: "tail" } : fixtures.settled;
      if (mode === "invalid-response") body = { ...fixtures.settled, amount: "not-an-integer" };
      response.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const upstreamPort = (server.address() as { port: number }).port;
    // Reserve an ephemeral port, then hand it to the child. A startup failure fails the test.
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    const executable = fileURLToPath(new URL("../../../node_modules/@stoplight/prism-cli/dist/index.js", import.meta.url));
    const spec = fileURLToPath(new URL("../fixtures/increase/openapi.json", import.meta.url));
    prism = spawn(process.execPath, [executable, "proxy", spec, `http://127.0.0.1:${upstreamPort}`, "--host", "127.0.0.1", "--port", String(port), "--errors", "--verboseLevel", "error"], { stdio: ["ignore", "pipe", "pipe"] });
    let logs = ""; prism.stdout?.on("data", chunk => logs += chunk); prism.stderr?.on("data", chunk => logs += chunk);
    const deadline = Date.now() + 15_000;
    while (true) {
      if (prism.exitCode !== null) throw new Error(`Prism failed to start: ${logs}`);
      try { await fetch(`${origin}/health`, { signal: AbortSignal.timeout(200) }); break; } catch { /* startup */ }
      if (Date.now() >= deadline) throw new Error(`Prism startup timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const routedFetch: typeof fetch = (url, init) => { const u = new URL(String(url)); return fetch(`${origin}${u.pathname}${u.search}`, init); };
    provider = new IncreaseSandboxBank({ scope, apiKey: "contract-only", resolveCommand: async () => command, fetch: routedFetch });
  }, 20_000);
  afterAll(async () => {
    if (prism && prism.exitCode === null) { prism.kill("SIGTERM"); await once(prism, "exit"); }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("validates adapter outbound ACH and incoming transfer/debit schemas", async () => {
    mode = "valid";
    expect(await provider.createTransfer(command)).toMatchObject({ status: "settled", originalTransactionId: "transaction_debit" });
    expect((await provider.listTransactions(scope)).items).toHaveLength(1);
    expect((await provider.listEvents(scope)).items[0]).toMatchObject({ id: "event_demo" });
  });
  it("rejects malformed outbound request with a validation response", async () => {
    const body = JSON.parse(increaseRequestBody(command)); delete body.amount;
    const result = await fetch(`${origin}/ach_transfers`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(result.status).toBe(422);
    expect(JSON.stringify(await result.json())).toContain("amount");
  });
  it("rejects malformed incoming provider response", async () => {
    mode = "invalid-response";
    const result = await fetch(`${origin}/ach_transfers`, { method: "POST", headers, body: increaseRequestBody(command) });
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await result.json())).toContain("amount");
  });
  it("validates documented provider error response and honors Retry-After", async () => {
    mode = "rate-limit";
    await expect(provider.createTransfer(command)).rejects.toMatchObject({ errorClass: "rate_limit", retryAfterMs: 2000 });
  });
});
