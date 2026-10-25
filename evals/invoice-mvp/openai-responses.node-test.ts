import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAIBridge, createOpenAITransport, type OpenAIResponse, type OpenAITransport } from "./openai-responses";
import { agentTurn, configureCappedTransport, BudgetExceeded, type Request } from "./capped-llm";
import { runSystemA } from "./baseline-agent";
import { Workspace } from "../external/invoice-sandbox/lib/workspace";

const python = process.env.INVOICE_MVP_PYTHON ?? "python3";
const request: Request = { system: "Unchanged system text", tools: [{ name: "read_file", description: "Read original source", strict: true, input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }], messages: [{ role: "user", content: "Begin." }], effort: "high", maxTokens: 100 };
const meta = { runId: "a", system: "A", purpose: "turn-1", runCapUsd: 0.1 };
function response(): OpenAIResponse {
  return { id: "resp_test", model: "gpt-6.1-sol", service_tier: "default", status: "completed", output: [
    { type: "reasoning", id: "reason_test", encrypted_content: "synthetic-encrypted-reasoning", summary: [] },
    { type: "message", role: "assistant", id: "msg_test", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "Reading the source.", annotations: [] }] },
    { type: "function_call", id: "fc_test", call_id: "call_test", name: "read_file", arguments: '{"path":"invoice.pdf"}', status: "completed" },
  ], usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 7 } } };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-openai-test-")), authorization = path.join(root, "authorization.json"), ledger = path.join(root, "ledger.json");
  const auth = JSON.parse(fs.readFileSync("evals/invoice-mvp/authorization.openai.example.json", "utf8"));
  Object.assign(auth, { authorized: true, approvalReference: "TEST_ONLY_NO_NETWORK", expiresAt: new Date(Date.now() + 60000).toISOString(), aggregateMaxCostMicros: 100000, ledgerPath: ledger });
  auth.runs = { a: { ...auth.runs["baseline-original"], maxCostMicros: 100000, maxCalls: 2, maxInputTokens: 10000, maxOutputTokens: 100 } };
  fs.writeFileSync(authorization, JSON.stringify(auth));
  return { root, authorization, ledger, state: () => JSON.parse(fs.readFileSync(ledger, "utf8")) };
}

test("OpenAI wire preserves prompt/schema and native reasoning, phase, call ID and mixed tool output history", () => {
  const bridge = new OpenAIBridge(), first = bridge.request(request, "gpt-6.1-sol");
  assert.equal(first.instructions, request.system);
  assert.deepEqual(first.tools[0]!.parameters, (request.tools[0] as { input_schema: unknown }).input_schema);
  assert.deepEqual(first.reasoning, { effort: "high", context: "all_turns" });
  assert.equal(first.service_tier, "default"); assert.equal(first.store, false);
  assert.deepEqual(first.prompt_cache_options, { mode: "explicit" });
  assert.equal(JSON.stringify(first).includes("prompt_cache_breakpoint"), false);
  const raw = response(), msg = bridge.message(raw);
  const next = bridge.request({ ...request, messages: [...request.messages, { role: "assistant", content: msg.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_test", content: "source bytes as text", is_error: true }, { type: "text", text: "4 turns remain" }] }] }, "gpt-6.1-sol");
  assert.deepEqual(next.input.slice(1, 4), raw.output);
  assert.deepEqual(next.input[4], { type: "function_call_output", call_id: "call_test", output: "source bytes as text" });
  assert.deepEqual(next.input[5], { role: "user", content: "4 turns remain" });
  assert.throws(() => bridge.request({ ...request, messages: [{ role: "assistant", content: "invented replay" }] }, "gpt-6.1-sol"));
});

test("OpenAI fetch pins first-party URL/key, disables redirects, and makes one attempt", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-explicit-key");
    return new Response("provider error body deliberately not reported", { status: 429 });
  };
  const send = createOpenAITransport("synthetic-explicit-key", 1000, fakeFetch);
  await assert.rejects(send(new OpenAIBridge().request(request, "gpt-6.1-sol")), /OpenAI HTTP 429; reservation retained; no retry/);
  assert.equal(calls, 1);
});

test("OpenAI reservation precedes dispatch, reasoning is within output cost, and replay cannot spend", async () => {
  const f = fixture(); let calls = 0;
  try {
    const send: OpenAITransport = async () => { calls++; assert.equal(f.state().runs.a.requests["turn-1"].status, "reserved"); return response(); };
    configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, send);
    const result = await agentTurn(request, meta);
    assert.equal(result.entry.cost_usd, 0.00014); assert.equal(f.state().runs.a.requests["turn-1"].usage.reasoningTokens, 7);
    assert.deepEqual(result.message.content.filter(b => b.type === "tool_use").map(b => b.id), ["call_test"]);
    await assert.rejects(agentTurn(request, meta), BudgetExceeded); assert.equal(calls, 1);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test("multistep reservation adds prior reported output tokens beyond opaque wire bytes", async () => {
  const f = fixture(); let calls = 0;
  try {
    configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, async wire => {
      calls++;
      const record = f.state().runs.a.requests[`turn-${calls}`];
      assert.equal(record.inputTokensBound, Buffer.byteLength(JSON.stringify(wire), "utf8") + 4096 + (calls === 1 ? 0 : 100));
      const raw = response();
      if (calls === 1) {
        raw.output[0]!.encrypted_content = "x";
        raw.usage!.output_tokens = 100;
        raw.usage!.output_tokens_details!.reasoning_tokens = 90;
      }
      return raw;
    });
    const first = await agentTurn(request, meta);
    const next: Request = { ...request, messages: [...request.messages, { role: "assistant", content: first.message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_test", content: "source text" }] }] };
    await agentTurn(next, { ...meta, purpose: "turn-2" });
    assert.equal(calls, 2);
    const bridge = new OpenAIBridge(), one = response(), two = response();
    two.usage!.output_tokens = 20;
    const firstMessage = bridge.message(one), secondMessage = bridge.message(two);
    assert.equal(bridge.priorOutputTokenAllowance({ ...request, messages: [{ role: "assistant", content: firstMessage.content }, { role: "assistant", content: secondMessage.content }] }), 30);
    assert.throws(() => bridge.priorOutputTokenAllowance({ ...request, messages: [{ role: "assistant", content: [] }] }), /Missing prior native output usage/);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test("wrong model/tier/cache/missing usage/reasoning halt ledger with original reservation retained", async () => {
  for (const mutate of [
    (r: OpenAIResponse) => { r.model = "unapproved-model"; },
    (r: OpenAIResponse) => { r.service_tier = "fast"; },
    (r: OpenAIResponse) => { r.usage!.input_tokens_details!.cached_tokens = 1; },
    (r: OpenAIResponse) => { r.usage!.input_tokens_details!.cache_write_tokens = 1; },
    (r: OpenAIResponse) => { delete r.usage; },
    (r: OpenAIResponse) => { r.usage!.output_tokens_details!.reasoning_tokens = 11; },
  ]) {
    const f = fixture(); let calls = 0;
    try {
      configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, async () => { calls++; const r = response(); mutate(r); return r; });
      await assert.rejects(agentTurn(request, meta), BudgetExceeded);
      const state = f.state(); assert.equal(state.halted, true);
      assert.equal(state.runs.a.requests["turn-1"].chargedCostMicros, state.runs.a.requests["turn-1"].reservedCostMicros);
      await assert.rejects(agentTurn(request, { ...meta, purpose: "turn-2" })); assert.equal(calls, 1);
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

test("oversized input and effort mismatch stop before any OpenAI call", async () => {
  const f = fixture(); let calls = 0;
  try {
    configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, async () => { calls++; return response(); });
    await assert.rejects(agentTurn({ ...request, system: "x".repeat(10000) }, meta), BudgetExceeded);
    await assert.rejects(agentTurn({ ...request, effort: "low" }, meta), /Reasoning effort/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test("OpenAI transport failure retains reservation; unusable function arguments retain actual usage", async () => {
  for (const failTransport of [true, false]) {
    const f = fixture(); let calls = 0;
    try {
      configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, async () => { calls++; if (failTransport) throw new Error("synthetic transport failure"); const r = response(); r.output[2]!.arguments = "{"; return r; });
      await assert.rejects(agentTurn(request, meta)); assert.equal(calls, 1);
      const record = f.state().runs.a.requests["turn-1"];
      assert.equal(record.status, failTransport ? "reserved" : "settled");
      if (!failTransport) assert.equal(record.chargedCostMicros, 140);
    } finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

test("truncated and refused outputs never become executable successful tool calls", () => {
  const bridge = new OpenAIBridge(), raw = response();
  raw.status = "incomplete"; raw.incomplete_details = { reason: "max_output_tokens" }; raw.output[2]!.arguments = "{";
  assert.equal(bridge.message(raw).stop_reason, "max_tokens");
  raw.status = "completed"; raw.output = [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "synthetic refusal" }] }];
  assert.equal(bridge.message(raw).stop_reason, "refusal");
  raw.output = [{ type: "web_search_call" }]; assert.throws(() => bridge.message(raw), /hosted tools/);
});

test("unchanged baseline loop lists, reads, and submits through OpenAI wire without network", async () => {
  const f = fixture(); let calls = 0;
  try {
    const auth = JSON.parse(fs.readFileSync(f.authorization, "utf8"));
    auth.aggregateMaxCostMicros = 3000000;
    Object.assign(auth.runs.a, { maxCostMicros: 3000000, maxCalls: 3, maxInputTokens: 250000, maxOutputTokens: 64000 });
    fs.writeFileSync(f.authorization, JSON.stringify(auth));
    const workspace = path.join(f.root, "workspace"), outDir = path.join(f.root, "output");
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "invoice.txt"), "SYNTHETIC invoice: C_TEST, 12.34 USD");
    const submission = { customers: [{ customer_id: "C_TEST", customer_name: "Synthetic", valid_invoice_count: 1, gross_invoice_spend_usd: "12.34", credit_memo_total_usd: "0.00", net_spend_usd: "12.34" }], suspicious_documents: [], notes: "NO_NETWORK_TEST" };
    configureCappedTransport({ ...f, runId: "a", python, explicitLive: false }, undefined, async (wire) => {
      calls++;
      assert.equal(f.state().runs.a.requests[`agent-turn-${calls}`].inputTokensBound, Buffer.byteLength(JSON.stringify(wire), "utf8") + 4096 + (calls - 1) * 10);
      const toolOutputs = wire.input.filter(i => i.type === "function_call_output");
      if (calls === 2) assert.match(String(toolOutputs.at(-1)?.output), /invoice.txt/);
      if (calls === 3) assert.match(String(toolOutputs.at(-1)?.output), /SYNTHETIC invoice: C_TEST, 12.34 USD/);
      assert.equal(wire.max_output_tokens, 64000);
      const raw = response();
      const name = calls === 1 ? "list_dir" : calls === 2 ? "read_file" : "submit_results";
      const args = calls === 1 ? { path: "." } : calls === 2 ? { path: "invoice.txt", offset: null, limit: null } : submission;
      raw.output = [{ type: "function_call", call_id: `call_${calls}`, name, arguments: JSON.stringify(args) }];
      return raw;
    });
    const result = await runSystemA({ runId: "a", ws: new Workspace(workspace, workspace), outDir, effort: "high", maxTurns: 3, runCapUsd: 3 });
    assert.equal(result.status, "submitted"); assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, "submission.json"), "utf8")), submission);
    assert.match(fs.readFileSync(path.join(outDir, "submission.csv"), "utf8"), /C_TEST,Synthetic,1,12.34,0.00,12.34/);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});
