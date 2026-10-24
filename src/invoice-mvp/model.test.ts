import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL } from "../agents/llm";
import { AnthropicInvestigator, ModelResponseError, type ModelRequest } from "./model";
import { investigate } from "./investigator";
import { TestBackend } from "./test-backend";
import { runtimeAttestation } from "./server";
import { InvoiceService } from "./service";

const transport = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: transport.create };
    constructor(options: unknown) { transport.construct(options); }
  },
}));

const request: ModelRequest = { caseId: "synthetic-case", evidenceVersion: 1, observations: [], decisionSummaries: [] };
const budget = { maxCalls: 5, maxInputTokens: 50_000, maxOutputTokens: 1200, maxCostMicros: 500_000 };
const makeModel = () => new AnthropicInvestigator(budget, { inputMicros: 4, outputMicros: 20 }, 1200, true);
const response = (content: unknown[], stop_reason = "tool_use") => ({ content, stop_reason, model: MODEL, usage: { input_tokens: 123, output_tokens: 17 } });
const tool = (input: unknown = {}) => ({ type: "tool_use", id: "tool-test", name: "inspect_source", input });

beforeEach(() => {
  vi.clearAllMocks();
  // Dummy credential only satisfies the guard. The SDK itself is replaced; no network path exists.
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-mock-transport-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Anthropic transport compatibility — mocked SDK, no provider calls", () => {
  it("uses supported auto tool selection and the unchanged configured model with no retries/fallback", async () => {
    transport.create.mockResolvedValueOnce(response([{ type: "thinking", thinking: "", signature: "synthetic" }, tool()]));
    const result = await makeModel().next(request);
    expect(transport.construct).toHaveBeenCalledExactlyOnceWith({ baseURL: "https://api.anthropic.com", apiKey: "synthetic-mock-transport-key", authToken: null, maxRetries: 0, timeout: 30_000 });
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.create.mock.calls[0]![0]).toMatchObject({ model: MODEL, max_tokens: 1200, tool_choice: { type: "auto", disable_parallel_tool_use: true } });
    expect(transport.create.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
    expect(transport.create.mock.calls[0]![0]).not.toHaveProperty("thinking");
    expect(result).toMatchObject({ action: { name: "inspect_source", input: {} }, usage: { inputTokens: 123, outputTokens: 17, costMicros: 832 } });
  });

  it.each([
    ["no-tool text", response([{ type: "text", text: "No tool action was selected." }], "end_turn")],
    ["malformed content", { ...response([]), content: null }],
    ["malformed content block", response([null])],
    ["refusal", response([], "refusal")],
    ["truncated tool", response([tool()], "max_tokens")],
    ["multiple tools", response([tool(), tool()])],
    ["malformed tool input", response([tool(["not an input object"])])],
    ["null tool input", response([tool(null)])],
    ["unknown tool", response([{ ...tool(), name: "send_payment" }])],
    ["unfinished turn", response([tool()], "pause_turn")],
  ])("preserves usage for %s and does not retry", async (_label, providerResponse) => {
    transport.create.mockResolvedValueOnce(providerResponse);
    const error = await makeModel().next(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelResponseError);
    expect(error).toMatchObject({ code: "model_output_invalid", usage: { inputTokens: 123, outputTokens: 17, costMicros: 832 } });
    expect((error as ModelResponseError).usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(transport.create).toHaveBeenCalledTimes(1);
  });

  it("propagates transport failure without inventing usage or retrying", async () => {
    const failure = new Error("Synthetic network failure; no response usage available");
    transport.create.mockRejectedValueOnce(failure);
    await expect(makeModel().next(request)).rejects.toBe(failure);
    expect(transport.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["model mismatch", { ...response([tool()]), model: "unexpected-provider-model" }],
    ["cache read", { ...response([tool()]), usage: { input_tokens: 123, output_tokens: 17, cache_read_input_tokens: 40 } }],
    ["cache write", { ...response([tool()]), usage: { input_tokens: 123, output_tokens: 17, cache_creation_input_tokens: 40 } }],
  ])("rejects %s, preserves token counts and explicitly marks cost unavailable", async (_label, providerResponse) => {
    transport.create.mockResolvedValueOnce(providerResponse);
    await expect(makeModel().next(request)).rejects.toMatchObject({ code: "model_output_invalid", usage: { inputTokens: 123, outputTokens: 17, costMicros: null } });
    expect(transport.create).toHaveBeenCalledTimes(1);
  });

  it("does not construct a transport without explicit live opt-in", () => {
    expect(() => new AnthropicInvestigator(budget, { inputMicros: 4, outputMicros: 20 })).toThrow("explicit opt-in");
    expect(transport.construct).not.toHaveBeenCalled();
    expect(transport.create).not.toHaveBeenCalled();
  });

  it("pins the first-party endpoint and explicit key despite ambient redirect/auth/profile settings", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://untrusted.example");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-ambient-token");
    vi.stubEnv("ANTHROPIC_PROFILE", "synthetic-ambient-profile");
    makeModel();
    expect(transport.construct).toHaveBeenCalledExactlyOnceWith({ baseURL: "https://api.anthropic.com", apiKey: "synthetic-mock-transport-key", authToken: null, maxRetries: 0, timeout: 30_000 });
    expect(transport.create).not.toHaveBeenCalled();
  });

  it("rejects profile/auth-token-only configuration before constructing a transport", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-ambient-token");
    vi.stubEnv("ANTHROPIC_PROFILE", "synthetic-ambient-profile");
    expect(makeModel).toThrow("explicit ANTHROPIC_API_KEY");
    expect(transport.construct).not.toHaveBeenCalled();
  });

  it("attests immutable per-token prices and provider provenance without credentials", () => {
    const prices = { inputMicros: 4, outputMicros: 20 };
    const model = new AnthropicInvestigator(budget, prices, 1200, true);
    prices.inputMicros = 0;
    const runtime = runtimeAttestation(new InvoiceService(new TestBackend(), model));
    expect(runtime.modelProvider).toEqual({ baseURL: "https://api.anthropic.com", authentication: "explicit_api_key", pricing: { inputMicros: 4, outputMicros: 20 }, servedModelValidated: true, cacheUsageValidated: true });
    expect(model.reservation(request).costMicros).toBe(model.reservation(request).inputTokens * 4 + 1200 * 20);
    expect(JSON.stringify(runtime)).not.toContain("synthetic-mock-transport-key");
    expect(transport.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no-tool", response([{ type: "text", text: "PROVIDER_CONTENT_MUST_NOT_ENTER_AUDIT" }, { type: "thinking", thinking: "PRIVATE_THINKING_MUST_NOT_ENTER_AUDIT" }], "end_turn")],
    ["malformed", response([tool(["invalid"])] )],
  ])("persists %s response usage once then stops after one request without exposing provider content", async (_label, providerResponse) => {
    transport.create.mockResolvedValueOnce(providerResponse);
    const reserveModelRequest = vi.fn(async () => ({ reservationId: "synthetic-reservation", replayed: false, maxRequests: 5, maxCostMicros: 500_000, requestsReserved: 1, costReservedMicros: 100_000 }));
    const backend = Object.assign(new TestBackend(), { reserveModelRequest });
    const { caseIds } = await backend.ingestBatch({ label: "Synthetic model response audit", idempotencyKey: "fixture", documents: [{ externalId: "unknown", name: "unknown.txt", mimeType: "text/plain", text: "Unknown layout needs evidence" }] });
    const caseId = caseIds[0]!;
    await backend.beginInvestigation(caseId);
    const result = await investigate(backend, await backend.caseDetail(caseId), makeModel());
    expect(result).toMatchObject({ mode: "live_model", outcome: "evidence_missing", modelCalls: 1, toolCalls: 0, usage: { inputTokens: 123, outputTokens: 17, costMicros: 832 } });
    expect(reserveModelRequest).toHaveBeenCalledTimes(1);
    expect(transport.create).toHaveBeenCalledTimes(1);
    const detail = await backend.caseDetail(caseId);
    const actual = detail.audit.filter((a) => a.toolCall?.tool === "model_usage");
    expect(actual).toHaveLength(1);
    expect(actual[0]!.toolCall).toMatchObject({ inputTokens: 123, outputTokens: 17, costMicros: 832 });
    expect(detail.audit.filter((a) => a.toolCall?.tool === "model_failure")).toHaveLength(1);
    expect(JSON.stringify(detail.audit)).not.toContain("MUST_NOT_ENTER_AUDIT");
    expect(detail.audit.findIndex((a) => a.toolCall?.tool === "model_usage")).toBeLessThan(detail.audit.findIndex((a) => a.toolCall?.tool === "model_failure"));
  });

  it("persists known usage with unknown cost after cache mismatch and leaves the full reservation charged", async () => {
    transport.create.mockResolvedValueOnce({ ...response([tool()]), usage: { input_tokens: 123, output_tokens: 17, cache_read_input_tokens: 40 } });
    const reserveModelRequest = vi.fn(async () => ({ reservationId: "synthetic-cache-reservation", replayed: false, maxRequests: 5, maxCostMicros: 500_000, requestsReserved: 1, costReservedMicros: 100_000 }));
    const backend = Object.assign(new TestBackend(), { reserveModelRequest });
    const { caseIds } = await backend.ingestBatch({ label: "Unpriced response test", idempotencyKey: "cache-fixture", documents: [{ externalId: "unknown", name: "unknown.txt", mimeType: "text/plain", text: "Unknown layout needs evidence" }] });
    const caseId = caseIds[0]!;
    await backend.beginInvestigation(caseId);
    const result = await investigate(backend, await backend.caseDetail(caseId), makeModel());
    expect(result).toMatchObject({ outcome: "evidence_missing", modelCalls: 1, toolCalls: 0, usage: { inputTokens: 123, outputTokens: 17, costMicros: null } });
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(reserveModelRequest).toHaveBeenCalledTimes(1);
    const detail = await backend.caseDetail(caseId);
    expect(detail.audit.filter((a) => a.toolCall?.tool === "model_usage")).toHaveLength(0);
    const unknownCost = detail.audit.filter((a) => a.toolCall?.tool === "model_usage_unavailable");
    expect(unknownCost).toHaveLength(1);
    expect(unknownCost[0]!.toolCall).toMatchObject({ inputTokens: 123, outputTokens: 17 });
    expect(unknownCost[0]!.toolCall).not.toHaveProperty("costMicros");
    expect(unknownCost[0]!.summary).toContain("full reservation remains charged");
    expect(detail.audit.filter((a) => a.toolCall?.tool === "model_reservation")).toHaveLength(1);
  });
});
