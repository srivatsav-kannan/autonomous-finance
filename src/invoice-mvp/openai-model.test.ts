import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { OpenAIInvestigator, OPENAI_INVOICE_MODEL, OPENAI_REQUEST_TIMEOUT_MS, OPENAI_TOOL_SCHEMAS } from "./openai-model";
import { AnthropicInvestigator, ModelResponseError, type ModelRequest, type ToolAction } from "./model";
import { investigate } from "./investigator";
import { InvoiceService, createServiceFromEnv } from "./service";
import { runtimeAttestation } from "./server";
import { TestBackend } from "./test-backend";
import { demoBatch } from "./demo";

const budget = { maxCalls: 10, maxInputTokens: 100_000, maxOutputTokens: 4096, maxCostMicros: 1_000_000 };
const prices = { inputMicros: 2, outputMicros: 10 };
const transport = vi.fn<typeof fetch>();
const makeModel = () => new OpenAIInvestigator(budget, prices, 4096, true, transport);
const request = (): ModelRequest => ({ caseId: "synthetic-case", evidenceVersion: 1, observations: [], decisionSummaries: [] });
const call = (name = "inspect_source", input: unknown = {}, id = "call-1") => ({ type: "function_call", id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(input), status: "completed" });
const response = (output: unknown[] = [call()]) => ({
  model: OPENAI_INVOICE_MODEL, service_tier: "default", status: "completed", output,
  usage: { input_tokens: 123, output_tokens: 17, total_tokens: 140, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
});
const reply = (value: unknown, status = 200) => transport.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }));
const bodyAt = (index: number) => JSON.parse(transport.mock.calls[index]![1]!.body as string);
const observe = (r: ModelRequest, action: ToolAction, result: unknown = { text: "Synthetic invoice evidence" }) => r.observations.push({ tool: action.name, input: action.input, result });
const opaque = [
  { type: "reasoning", id: "rs-private", encrypted_content: "OPAQUE_CONTENT_MUST_NOT_ENTER_AUDIT", summary: [], status: "completed" },
  { type: "message", id: "msg-private", role: "assistant", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "PROVIDER_PROSE_MUST_NOT_ENTER_AUDIT", annotations: [] }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  transport.mockReset();
  // All provider traffic is replaced with this mock; only a synthetic key is used.
  vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-mock-key");
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("OpenAI Responses preparation — mocked transport only", () => {
  it("pins first-party auth/model and bounded Responses settings despite ambient overrides", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://untrusted.example");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-org");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
    vi.stubEnv("AGENT_MODEL", "unrelated-global-model");
    const model = makeModel(), req = request();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    model.reservation(req);
    expect(transport).not.toHaveBeenCalled();
    reply(response());
    const result = await model.next(req);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-openai-mock-key" }, signal: expect.any(AbortSignal) });
    expect(Object.keys(transport.mock.calls[0]![1]!.headers!)).toHaveLength(2);
    expect(OPENAI_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
    expect(bodyAt(0)).toMatchObject({ model: "gpt-6.1-sol", tools: OPENAI_TOOL_SCHEMAS, tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "high", context: "all_turns" }, service_tier: "default", store: false, include: ["reasoning.encrypted_content"], prompt_cache_options: { mode: "explicit" }, max_output_tokens: 4096 });
    expect(JSON.stringify(bodyAt(0))).not.toContain("prompt_cache_breakpoint");
    expect(bodyAt(0)).not.toHaveProperty("previous_response_id");
    expect(result).toMatchObject({ action: { name: "inspect_source", input: {} }, usage: { inputTokens: 123, outputTokens: 17, costMicros: 416 }, usageSummary: expect.stringContaining("includes 10 reasoning tokens") });
  });

  it("requires explicit opt-in and an OpenAI key; ambient credentials cannot substitute", () => {
    expect(() => new OpenAIInvestigator(budget, prices)).toThrow("explicit opt-in");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-other-provider");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "synthetic-azure");
    vi.stubEnv("OPENAI_PROFILE", "synthetic-profile");
    expect(makeModel).toThrow("explicit OPENAI_API_KEY");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["input ceiling", { ...budget, maxInputTokens: 100_001 }, prices, 4096],
    ["output ceiling", { ...budget, maxOutputTokens: 4097 }, prices, 4096],
    ["actual output exceeds cap", { ...budget, maxOutputTokens: 2048 }, prices, 4096],
    ["missing cap", { ...budget, maxCalls: NaN }, prices, 4096],
    ["missing price", budget, { inputMicros: 0, outputMicros: 10 }, 4096],
  ])("rejects %s before transport", (_label, limits, rates, output) => {
    expect(() => new OpenAIInvestigator(limits, rates, output, true, transport)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("attests copied immutable prices, exact tool schema, high effort, and actual output limit", () => {
    const mutablePrices = { ...prices }, mutableBudget = { ...budget };
    const model = new OpenAIInvestigator(mutableBudget, mutablePrices, 2048, true, transport);
    mutablePrices.inputMicros = 0; mutableBudget.maxInputTokens = 999_999;
    const runtime = runtimeAttestation(new InvoiceService(new TestBackend(), model));
    expect(runtime).toMatchObject({ model: "gpt-6.1-sol", effort: "high", reasoningContext: "all_turns", retries: 0, fallbacks: false, outputTokensPerCall: 2048, perRequest: { maxInputTokens: 100_000, maxOutputTokens: 2048 }, budget });
    expect(runtime.modelProvider).toEqual({ baseURL: "https://api.openai.com/v1", api: "responses", authentication: "explicit_api_key", pricing: prices, servedModelValidated: true, cacheUsageValidated: true, serviceTier: "default", promptCacheMode: "explicit_without_breakpoints" });
    expect(runtime.toolsHash).toBe(createHash("sha256").update(JSON.stringify(OPENAI_TOOL_SCHEMAS)).digest("hex"));
    expect(Object.isFrozen(model.provider)).toBe(true);
    expect(Object.isFrozen(model.provider.pricing)).toBe(true);
    expect(Object.isFrozen(model.budget)).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain("synthetic-openai-mock-key");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("stateless Responses continuation and reservation", () => {
  it("preserves structured reasoning fields with an omitted optional status", async () => {
    const model = makeModel(), req = request();
    const reasoning = { type: "reasoning", id: "rs-structured", encrypted_content: "OPAQUE_CONTENT_MUST_NOT_ENTER_AUDIT", summary: [{ type: "summary_text", text: "SUMMARY_MUST_NOT_ENTER_AUDIT" }], content: [{ type: "reasoning_text", text: "REASONING_MUST_NOT_ENTER_AUDIT" }] };
    reply(response([reasoning, call()]));
    const first = await model.next(req);
    expect(JSON.stringify(first)).not.toContain("MUST_NOT_ENTER_AUDIT");
    observe(req, first.action);
    reply(response([call("policy", {}, "call-2")]));
    await model.next(req);
    expect(bodyAt(1).input[2]).toEqual(reasoning);
  });

  it("replays every output item unchanged, pairs the result, and reserves full wire plus opaque output", async () => {
    const model = makeModel(), req = request(), firstOutput = [...opaque, call()];
    const initialReservation = model.reservation(req);
    reply(response(firstOutput));
    const first = await model.next(req);
    expect(initialReservation.inputTokens).toBe(Buffer.byteLength(JSON.stringify(bodyAt(0))) + 4096);
    observe(req, first.action);
    const secondReservation = model.reservation(req);
    req.observations[0]!.result = { text: "long source ".repeat(1000) };
    expect(model.reservation(req).inputTokens).toBeGreaterThan(secondReservation.inputTokens);
    const fullReservation = model.reservation(req);
    reply(response([call("policy", {}, "call-2")]));
    await model.next(req);
    expect(bodyAt(1).input).toEqual([...bodyAt(0).input, ...firstOutput, { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ result: req.observations[0]!.result }) }]);
    expect(fullReservation.inputTokens).toBe(Buffer.byteLength(JSON.stringify(bodyAt(1))) + 17 + 4096);
    expect(fullReservation.costMicros).toBe(fullReservation.inputTokens * 2 + 4096 * 10);
    expect(bodyAt(1).input[3].phase).toBe("commentary");
    expect(bodyAt(1).reasoning.context).toBe("all_turns");
  });

  it("isolates identical cases with different observation arrays and discards released state", async () => {
    const model = makeModel(), first = request(), second = request();
    reply(response([...opaque, call()]));
    const action = (await model.next(first)).action;
    observe(first, action);
    reply(response());
    await model.next(second);
    expect(bodyAt(1).input).toHaveLength(2);
    expect(JSON.stringify(bodyAt(1))).not.toContain("OPAQUE_CONTENT");
    model.release(first.observations);
    expect(() => model.reservation(first)).toThrow("continuation is unavailable");
    first.observations.length = 0;
    reply(response());
    await model.next(first);
    expect(bodyAt(2).input).toHaveLength(2);
  });

  it.each(["case", "evidence", "decisions", "tool", "arguments", "missing result"])("rejects changed %s before dispatch and clears continuation", async (change) => {
    const model = makeModel(), req = request();
    reply(response());
    observe(req, (await model.next(req)).action);
    if (change === "case") req.caseId = "other";
    if (change === "evidence") req.evidenceVersion++;
    if (change === "decisions") req.decisionSummaries.push("changed");
    if (change === "tool") req.observations[0]!.tool = "policy";
    if (change === "arguments") req.observations[0]!.input = { documentId: "other" };
    if (change === "missing result") req.observations.length = 0;
    await expect(model.next(req)).rejects.toMatchObject({ code: "continuation_invalid" });
    expect(transport).toHaveBeenCalledTimes(1);
    req.observations.length = 0;
    reply(response());
    await model.next(req);
    expect(bodyAt(1).input).toHaveLength(2);
  });

  it("rejects edited earlier observations and duplicate call identifiers", async () => {
    const model = makeModel(), req = request();
    reply(response());
    observe(req, (await model.next(req)).action);
    reply(response());
    await expect(model.next(req)).rejects.toMatchObject({ usage: { costMicros: 416 } });
    expect(() => model.reservation(req)).toThrow("continuation is unavailable");
    req.observations.length = 0;
    reply(response());
    observe(req, (await model.next(req)).action);
    reply(response([call("policy", {}, "call-2")]));
    observe(req, (await model.next(req)).action);
    req.observations[0]!.result = "changed prior evidence";
    expect(() => model.reservation(req)).toThrow("append-only");
  });

  it("refuses oversized requests before dispatch", async () => {
    const model = makeModel(), req = request();
    req.decisionSummaries.push("x".repeat(100_000));
    await expect(model.next(req)).rejects.toMatchObject({ code: "resource_limit" });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("response validation and cost honesty", () => {
  it.each([
    ["no tool", response(opaque)],
    ["multiple tools", response([call(), call("policy", {}, "call-2")])],
    ["unknown tool", response([call("send_payment")])],
    ["malformed arguments", response([{ ...call(), arguments: "{PRIVATE_RAW_CONTENT" }])],
    ["array arguments", response([call("inspect_source", [])])],
    ["missing call id", response([{ ...call(), call_id: undefined }])],
    ["unfinished call", response([{ ...call(), status: "in_progress" }])],
    ["malformed output", response([null])],
    ["unsupported output type", response([{ type: "web_search_call", id: "PRIVATE_RAW_CONTENT" }, call()])],
    ["untyped output", response([{ id: "PRIVATE_RAW_CONTENT" }, call()])],
    ["reasoning missing encrypted state", response([{ ...opaque[0], encrypted_content: undefined }, call()])],
    ["reasoning invalid encrypted state", response([{ ...opaque[0], encrypted_content: { value: "PRIVATE_RAW_CONTENT" } }, call()])],
    ["reasoning empty encrypted state", response([{ ...opaque[0], encrypted_content: "" }, call()])],
    ["reasoning missing ID", response([{ ...opaque[0], id: undefined }, call()])],
    ["reasoning malformed summary", response([{ ...opaque[0], summary: [{ type: "output_text", text: "PRIVATE_RAW_CONTENT" }] }, call()])],
    ["reasoning malformed content", response([{ ...opaque[0], content: "PRIVATE_RAW_CONTENT" }, call()])],
    ["reasoning incomplete", response([{ ...opaque[0], status: "incomplete" }, call()])],
    ["incomplete", { ...response(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["failed", { ...response(), status: "failed", error: { message: "PRIVATE_RAW_CONTENT" } }],
    ["cache breakpoint", response([{ ...opaque[0], prompt_cache_breakpoint: true }, call()])],
  ])("preserves billed usage for %s without raw content or retries", async (_label, value) => {
    reply(value);
    const error = await makeModel().next(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelResponseError);
    expect(error).toMatchObject({ usage: { inputTokens: 123, outputTokens: 17, costMicros: 416 } });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_RAW_CONTENT|MUST_NOT_ENTER_AUDIT/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["served model", { ...response(), model: "other-model" }],
    ["served tier", { ...response(), service_tier: "priority" }],
    ["cache read", { ...response(), usage: { ...response().usage, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } } }],
    ["cache write", { ...response(), usage: { ...response().usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 } } }],
    ["cache missing", { ...response(), usage: { ...response().usage, input_tokens_details: {} } }],
    ["cache write details inconsistent", { ...response(), usage: { ...response().usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 0 } } } }],
    ["reasoning missing", { ...response(), usage: { ...response().usage, output_tokens_details: {} } }],
    ["reasoning inconsistent", { ...response(), usage: { ...response().usage, output_tokens_details: { reasoning_tokens: 18 } } }],
    ["total inconsistent", { ...response(), usage: { ...response().usage, total_tokens: 150 } }],
  ])("keeps known tokens but marks cost unavailable for %s", async (_label, value) => {
    reply(value);
    await expect(makeModel().next(request())).rejects.toMatchObject({ usage: { inputTokens: 123, outputTokens: 17, costMicros: null } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["input", "output"])("stops when actual %s exceeds the held request bounds", async (kind) => {
    const value = response();
    value.usage.input_tokens = kind === "input" ? 50_000 : 123;
    value.usage.output_tokens = kind === "output" ? 4097 : 17;
    value.usage.total_tokens = value.usage.input_tokens + value.usage.output_tokens;
    reply(value);
    await expect(makeModel().next(request())).rejects.toMatchObject({ usage: { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens, costMicros: value.usage.input_tokens * 2 + value.usage.output_tokens * 10 } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "http", "invalid json", "missing usage"])("fails %s without retry, raw provider error or fabricated cost", async (kind) => {
    if (kind === "network") transport.mockRejectedValueOnce(new Error("PRIVATE_RAW_CONTENT"));
    if (kind === "http") reply({ error: "PRIVATE_RAW_CONTENT" }, 429);
    if (kind === "invalid json") transport.mockResolvedValueOnce(new Response("PRIVATE_RAW_CONTENT"));
    if (kind === "missing usage") reply({ ...response(), usage: undefined });
    const error = await makeModel().next(request()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ModelResponseError);
    expect(JSON.stringify(error)).not.toContain("PRIVATE_RAW_CONTENT");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

async function setup() {
  const reserveModelRequest = vi.fn(async () => ({ reservationId: `synthetic-${transport.mock.calls.length}`, replayed: false, maxRequests: 10, maxCostMicros: budget.maxCostMicros, requestsReserved: 1, costReservedMicros: 100_000 }));
  const backend = Object.assign(new TestBackend(), { reserveModelRequest });
  const { caseIds } = await backend.ingestBatch({ label: "Synthetic OpenAI audit", idempotencyKey: "fixture", documents: [demoBatch().documents[2]!] });
  await backend.beginInvestigation(caseIds[0]!);
  return { backend, detail: await backend.caseDetail(caseIds[0]!), reserveModelRequest };
}

describe("investigator integration — no provider or database network", () => {
  it("holds atomic reservations, proposes only for human review and never audits opaque output", async () => {
    const { backend, detail, reserveModelRequest } = await setup(), model = makeModel();
    const actions: ToolAction[] = [
      { name: "inspect_source", input: {} }, { name: "related_documents", input: {} }, { name: "related_customers", input: {} }, { name: "policy", input: {} },
      { name: "propose_disposition", input: { treatment: "include_invoice", customerId: "demo-acorn", customerName: "Acorn Design", documentNumber: "AC-100", amountCents: 100000, reason: "Invoice shows the amount.", evidence: [{ documentId: detail.source.documentId, version: detail.source.version, contentHash: detail.source.contentHash, quote: "Total: USD 1000.00" }], contradictions: [], missingEvidence: [] } },
    ];
    actions.forEach((action, i) => reply(response([...opaque.map((item) => ({ ...item, id: `${item.id}-${i}` })), call(action.name, action.input, `call-${i}`)])));
    const release = vi.spyOn(model, "release");
    const result = await investigate(backend, detail, model);
    expect(result).toMatchObject({ mode: "live_model", outcome: "needs_review", modelCalls: 5, toolCalls: 5, usage: { inputTokens: 615, outputTokens: 85, costMicros: 2080 } });
    expect(reserveModelRequest).toHaveBeenCalledTimes(5);
    expect(transport).toHaveBeenCalledTimes(5);
    expect(reserveModelRequest.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]!);
    expect(release).toHaveBeenCalledTimes(1);
    const observations = release.mock.calls[0]![0];
    expect(() => model.reservation({ ...request(), observations })).toThrow("continuation is unavailable");
    const state = await backend.caseDetail(detail.case.caseId);
    expect(state.decisions).toHaveLength(0);
    expect((await backend.workspace()).customerTotals).toHaveLength(0);
    expect(JSON.stringify(state)).not.toMatch(/MUST_NOT_ENTER_AUDIT|synthetic-openai-mock-key/);
    expect(state.audit.filter((event) => event.toolCall?.tool === "model_usage")).toHaveLength(5);
    expect(state.audit.filter((event) => event.toolCall?.tool === "model_reservation")).toHaveLength(5);
    expect(state.audit.some((event) => event.summary.includes("includes 10 reasoning tokens"))).toBe(true);
  });

  it.each(["malformed", "cache mismatch", "usage absent"])("retains reservations and honest audit for %s then clears state", async (kind) => {
    const { backend, detail, reserveModelRequest } = await setup(), model = makeModel();
    const value = response(opaque);
    reply(kind === "cache mismatch" ? { ...value, usage: { ...value.usage, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 } } } : kind === "usage absent" ? { ...value, usage: undefined } : value);
    const release = vi.spyOn(model, "release");
    const result = await investigate(backend, detail, model);
    expect(result).toMatchObject({ outcome: "evidence_missing", modelCalls: 1, toolCalls: 0, usage: { costMicros: kind === "malformed" ? 416 : null } });
    expect(reserveModelRequest).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalled();
    const state = await backend.caseDetail(detail.case.caseId);
    expect(state.audit.filter((event) => event.toolCall?.tool === "model_reservation")).toHaveLength(1);
    const usage = state.audit.filter((event) => event.toolCall?.tool === (kind === "malformed" ? "model_usage" : "model_usage_unavailable"));
    expect(usage).toHaveLength(1);
    if (kind === "usage absent") expect(usage[0]!.toolCall).not.toHaveProperty("inputTokens");
    else expect(usage[0]!.toolCall).toMatchObject({ inputTokens: 123, outputTokens: 17 });
    if (kind !== "malformed") { expect(usage[0]!.toolCall).not.toHaveProperty("costMicros"); expect(usage[0]!.summary).toContain("full reservation remains charged"); }
    expect(JSON.stringify(state)).not.toContain("MUST_NOT_ENTER_AUDIT");
  });

  it("clears opaque state when backend work throws and blocks replayed reservations", async () => {
    const { backend, detail, reserveModelRequest } = await setup(), model = makeModel();
    reply(response([...opaque, call("ask_human", { question: "Please supply the final invoice.", missingEvidence: ["Final invoice"] })]));
    vi.spyOn(backend, "submitProposal").mockRejectedValueOnce(new Error("Synthetic backend outage"));
    const release = vi.spyOn(model, "release");
    await expect(investigate(backend, detail, model)).rejects.toThrow("Synthetic backend outage");
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => model.reservation({ ...request(), observations: release.mock.calls[0]![0] })).toThrow("continuation is unavailable");
    reserveModelRequest.mockResolvedValueOnce({ reservationId: "old", replayed: true, maxRequests: 10, maxCostMicros: budget.maxCostMicros, requestsReserved: 1, costReservedMicros: 100_000 });
    expect((await investigate(backend, detail, model)).modelCalls).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("provider factory — configuration only", () => {
  beforeEach(() => {
    const environment = { INVOICE_MVP_RUN_ID: "synthetic-run", CONVEX_URL: "https://synthetic-test.convex.cloud", INVOICE_MVP_SEATS_FILE: "", INVOICE_MVP_HUMAN_TOKEN: "synthetic-human", INVOICE_MVP_INVESTIGATOR_TOKEN: "synthetic-investigator", INVOICE_MVP_MODE: "live_model", INVOICE_MVP_PROVIDER: "openai", INVOICE_MVP_LIVE_OPT_IN: "1", INVOICE_MVP_MAX_MODEL_CALLS: "10", INVOICE_MVP_MAX_INPUT_TOKENS: "100000", INVOICE_MVP_MAX_OUTPUT_TOKENS: "4096", INVOICE_MVP_MAX_COST_MICROS: "1000000", INVOICE_MVP_INPUT_TOKEN_MICROS: "2", INVOICE_MVP_OUTPUT_TOKEN_MICROS: "10", INVOICE_MVP_OUTPUT_TOKENS_PER_CALL: "2048", ANTHROPIC_API_KEY: "synthetic-anthropic-mock-key" };
    Object.entries(environment).forEach(([key, value]) => vi.stubEnv(key, value));
  });
  it("chooses OpenAI only through the live provider opt-in and does not call a provider", () => {
    const service = createServiceFromEnv();
    expect(service.model).toBeInstanceOf(OpenAIInvestigator);
    expect(runtimeAttestation(service).outputTokensPerCall).toBe(2048);
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps deterministic mode as the default even with provider keys and OpenAI selection", () => {
    vi.stubEnv("INVOICE_MVP_MODE", undefined);
    expect(createServiceFromEnv().mode).toBe("deterministic");
    expect(createServiceFromEnv().model).toBeUndefined();
    expect(runtimeAttestation(createServiceFromEnv()).reasoningContext).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves Anthropic as the default live provider and rejects unsupported providers", () => {
    vi.stubEnv("INVOICE_MVP_PROVIDER", undefined);
    const service = createServiceFromEnv();
    expect(service.model).toBeInstanceOf(AnthropicInvestigator);
    expect(runtimeAttestation(service)).toMatchObject({ effort: "provider_default", reasoningContext: null });
    vi.stubEnv("INVOICE_MVP_PROVIDER", "unapproved-proxy");
    expect(createServiceFromEnv).toThrow("supported anthropic or openai");
    expect(transport).not.toHaveBeenCalled();
  });
});
