import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetedModelClient, type ModelConfig, type RequestBudget } from "./model-client";
import { emptyUsage, type ToolDef } from "./llm";

const config: ModelConfig = { provider: "openai", model: "test-model", effort: "medium", maxInputTokens: 100000, maxOutputTokens: 4096, prices: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } };
const text = (value: string) => ({ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: value }] });
const call = (id: string, args = '{"value":2}', name = "double") => ({ type: "function_call", status: "completed", call_id: id, name, arguments: args });
const response = (output: unknown[], extra = {}) => ({ model: "test-model", status: "completed", service_tier: "default", output, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 12 } }, ...extra });
const schema = z.object({ value: z.number() }).strict();
const tool: ToolDef = { name: "double", description: "Double a value", schema, inputSchema: z.toJSONSchema(schema), run: vi.fn(async (input) => (input as { value: number }).value * 2) };
function setup(responses: unknown[], conf = config) {
  const fetcher = vi.fn<typeof fetch>();
  for (const res of responses) fetcher.mockResolvedValueOnce(new Response(JSON.stringify(res), { status: 200, headers: { "Content-Type": "application/json" } }));
  const settle = vi.fn(), fail = vi.fn();
  const budget: RequestBudget = { reserve: vi.fn(() => ({ costMicros: 250000, settle, fail })) };
  const client = new BudgetedModelClient(conf, budget, fetcher);
  const usage = emptyUsage();
  const run = (maxTurns = 4) => client.runTools({ system: "Policy", user: "Question", tools: [tool], maxTurns, usage });
  return { client, budget, settle, fail, fetcher, usage, run };
}
beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", "test-only-never-sent"); vi.stubEnv("ANTHROPIC_API_KEY", "test-only-never-sent"); vi.stubEnv("AGENT_LLM", "on"); vi.mocked(tool.run).mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe("budgeted OpenAI Responses client (mock transport only)", () => {
  it("preserves reasoning and multiple call IDs across turns, with accurate separate cache/reasoning usage", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] };
    const first = [reasoning, call("call_1"), call("call_2", '{"value":3}')];
    const t = setup([response(first), response([text("6")])]);
    expect(await t.run()).toBe("6");
    expect(tool.run).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(t.fetcher.mock.calls[1]![1]!.body));
    expect(body.input).toEqual([{ role: "user", content: "Question" }, ...first, { type: "function_call_output", call_id: "call_1", output: "4" }, { type: "function_call_output", call_id: "call_2", output: "6" }]);
    expect(body).toMatchObject({ model: "test-model", store: false, service_tier: "default", reasoning: { effort: "medium" }, max_output_tokens: 4096, include: ["reasoning.encrypted_content"], prompt_cache_options: { mode: "explicit" } });
    expect(body.tools[0]).toMatchObject({ type: "function", strict: true, name: "double" });
    expect(t.usage).toMatchObject({ turns: 2, toolCalls: 2, inputTokens: 120, cacheReadTokens: 80, outputTokens: 40, costMicros: 600 });
    expect(t.budget.reserve).toHaveBeenCalledTimes(2);
  });
  it("validates JSON/schema/unknown tools before execution and returns matching tool errors", async () => {
    const t = setup([response([call("a", "bad JSON"), call("b", '{"value":"wrong"}'), call("c", "{}", "shell")]), response([text("corrected")])]);
    expect(await t.run()).toBe("corrected");
    expect(tool.run).not.toHaveBeenCalled();
    const body = JSON.parse(String(t.fetcher.mock.calls[1]![1]!.body));
    expect(body.input.filter((x: any) => x.type === "function_call_output").map((x: any) => [x.call_id, JSON.parse(x.output).error])).toEqual(["a", "b", "c"].map((id) => [id, expect.stringContaining("invalid")]));
  });
  it("enforces turn caps and rejects replayed call IDs", async () => {
    const bounded = setup([response([call("a")])]);
    await expect(bounded.run(1)).rejects.toThrow("turn limit");
    expect(bounded.fetcher).toHaveBeenCalledTimes(1);
    const replay = setup([response([call("a")]), response([call("a")])]);
    await expect(replay.run()).rejects.toThrow("Repeated tool call");
  });
  it.each([
    response([text("partial")], { status: "incomplete" }),
    response([{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]),
    response([{ ...call("a"), status: "in_progress" }]),
    response([{ type: "web_search_call" }]),
    response([]),
  ])("does not accept incomplete/refused/empty/unexpected outputs", async (res) => {
    const t = setup([res]);
    await expect(t.run()).rejects.toThrow();
    expect(tool.run).not.toHaveBeenCalled();
    expect(t.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { model: "unapproved-model" }, { service_tier: "priority" }, { usage: null },
    { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 } } },
    { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } },
  ])("retains reservation and stops on unverified model/tier/usage", async (extra) => {
    const t = setup([response([text("answer")], extra)]);
    await expect(t.run()).rejects.toThrow("reservation retained");
    expect(t.fail).toHaveBeenCalledOnce();
    expect(t.settle).not.toHaveBeenCalled();
    expect(t.usage.costMicros).toBe(250000);
  });
  it("does not retry transport failures or persist provider error bodies", async () => {
    const t = setup([]);
    t.fetcher.mockRejectedValueOnce(new Error("secret request body test-only-never-sent"));
    await expect(t.run()).rejects.toThrow("no retry");
    expect(t.fetcher).toHaveBeenCalledTimes(1);
    expect(t.fail).toHaveBeenCalledOnce();
  });
  it("never dispatches when the budget refuses or keys/inference are disabled", async () => {
    const t = setup([]);
    vi.mocked(t.budget.reserve).mockImplementation(() => { throw new Error("Not approved"); });
    await expect(t.run()).rejects.toThrow("Not approved");
    vi.stubEnv("AGENT_LLM", "off");
    await expect(t.run()).rejects.toThrow("enabled");
    expect(t.fetcher).not.toHaveBeenCalled();
    expect(t.usage.turns).toBe(0);
  });
  it("uses the first-party origin even with an ambient proxy URL", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid");
    const t = setup([response([text("done")])]);
    await t.run();
    expect(t.fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect(t.fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
  it("requests a strict structured schema and locally rejects malformed judge output", async () => {
    const t = setup([response([text('{"value":3}')]), response([text('{"value":"3"}')])]);
    const opts = { system: "Judge", input: "Answer", schema, usage: t.usage };
    expect(await t.client.extract(opts)).toEqual({ value: 3 });
    const body = JSON.parse(String(t.fetcher.mock.calls[0]![1]!.body));
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, schema: { additionalProperties: false } });
    expect(body.tools).toBeUndefined();
    await expect(t.client.extract(opts)).rejects.toThrow();
  });
});

describe("Anthropic compatibility (mock transport only)", () => {
  const conf = { ...config, provider: "anthropic" as const, prices: { ...config.prices, cacheWrite: 3 } };
  const anthropic = (content: unknown[], stop_reason = "end_turn") => ({ id: "msg_test", type: "message", role: "assistant", model: "test-model", content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } });
  it("shares the tool contract, keeps models fixed and applies explicit provider prices", async () => {
    const t = setup([anthropic([{ type: "tool_use", id: "a", name: "double", input: { value: 4 } }], "tool_use"), anthropic([{ type: "text", text: "8" }])], conf);
    expect(await t.run()).toBe("8");
    expect(t.usage).toMatchObject({ costMicros: 820, cacheWriteTokens: 20, inputTokens: 200 });
    const body = JSON.parse(String(t.fetcher.mock.calls[0]![1]!.body));
    expect(body.fallbacks).toBeUndefined();
    expect(body.model).toBe("test-model");
    const second = JSON.parse(String(t.fetcher.mock.calls[1]![1]!.body));
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "a", content: "8" });
  });
  it("uses Anthropic structured output without a fallback or retry", async () => {
    const t = setup([anthropic([{ type: "text", text: '{"value":9}' }])], conf);
    expect(await t.client.extract({ system: "Judge", input: "Answer", schema, usage: t.usage })).toEqual({ value: 9 });
    const body = JSON.parse(String(t.fetcher.mock.calls[0]![1]!.body));
    expect(body.output_config.format.type).toBe("json_schema");
    const failure = setup([], conf);
    failure.fetcher.mockResolvedValue(new Response('{"error":{"message":"private"}}', { status: 429 }));
    await expect(failure.run()).rejects.toThrow("no retry");
    expect(failure.fetcher).toHaveBeenCalledTimes(1);
  });
});
