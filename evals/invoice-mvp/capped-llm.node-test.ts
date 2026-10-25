import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureCappedTransport, createCappedClient, agentTurn, BudgetExceeded, type Transport } from "./capped-llm";
const python = process.env.INVOICE_MVP_PYTHON ?? "python3";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-budget-")), authorization = path.join(root, "authorization.json"), ledger = path.join(root, "ledger.json");
  const auth = { authorized: true, approvalReference: "TEST_ONLY_NO_NETWORK", expiresAt: new Date(Date.now() + 60000).toISOString(), aggregateMaxCostMicros: 100000, ledgerPath: ledger, pricingProvenance: JSON.parse(fs.readFileSync("evals/invoice-mvp/pricing-provenance.json", "utf8")), runs: { a: { kind: "baseline", model: "claude-opus-5-5", maxCostMicros: 100000, maxCalls: 2, maxInputTokens: 10000, maxOutputTokens: 100, inputMicros: 4, outputMicros: 20, timeoutSeconds: 30 } } };
  fs.writeFileSync(authorization, JSON.stringify(auth)); return { root, authorization, ledger };
}
const request = { system: "same system", tools: [], messages: [{ role: "user" as const, content: "untrusted document" }], effort: "high" as const, maxTokens: 100 };
const meta = { runId: "a", system: "A", purpose: "turn-1", runCapUsd: 0.1 };
test("baseline prompt/tools/algorithm exactly match historical A except import paths", () => {
  const original = fs.readFileSync("evals/external/invoice-sandbox/system-a.ts", "utf8");
  let copy = fs.readFileSync("evals/invoice-mvp/baseline-agent.ts", "utf8").replace('"./capped-llm"', '"./lib/llm"');
  for (const name of ["submission", "task", "workspace"]) copy = copy.replace(`"../external/invoice-sandbox/lib/${name}"`, `"./lib/${name}"`);
  assert.equal(copy, original);
});
test("injected transport sees reservation first and no retry/fallback/cache fields", async () => {
  const f = fixture(); let calls = 0;
  const injected: Transport = async (wire) => { calls++; assert.equal(JSON.parse(fs.readFileSync(f.ledger, "utf8")).runs.a.requests["turn-1"].status, "reserved"); assert.equal(wire.system[0]!.text, request.system); assert.ok(!("fallbacks" in wire)); assert.ok(!("cache_control" in wire)); return { model: "claude-opus-5-5", content: [], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 10 } } as never; };
  configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, injected);
  const result = await agentTurn(request, meta); assert.equal(result.entry.cost_usd, 0.00028); assert.equal(calls, 1);
  await assert.rejects(agentTurn(request, meta), BudgetExceeded); assert.equal(calls, 1); fs.rmSync(f.root, { recursive: true });
});
test("network failure has one attempt, retained charge, and no automatic retry", async () => {
  const f = fixture(); let calls = 0;
  configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, async () => { calls++; throw new Error("synthetic transport failure"); });
  await assert.rejects(agentTurn(request, meta)); assert.equal(calls, 1); assert.equal(JSON.parse(fs.readFileSync(f.ledger, "utf8")).runs.a.requests["turn-1"].status, "reserved");fs.rmSync(f.root, { recursive: true });
});
test("missing explicit opt-in fails without transport", () => {
  const f = fixture(); assert.throws(() => configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }));fs.rmSync(f.root, { recursive: true });
});

test("explicit key and first-party URL ignore ambient token and base URL", () => {
  const token = process.env.ANTHROPIC_AUTH_TOKEN, url = process.env.ANTHROPIC_BASE_URL;
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-ambient-token";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    const client = createCappedClient("synthetic-explicit-key", 30000);
    assert.equal(client.apiKey, "synthetic-explicit-key"); assert.equal(client.authToken, null);
    assert.equal(client.baseURL, "https://api.anthropic.com"); assert.equal(client.maxRetries, 0);
  } finally {
    if (token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = token;
    if (url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = url;
  }
});
