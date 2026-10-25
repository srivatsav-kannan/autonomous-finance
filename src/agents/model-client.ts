import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { emptyUsage, type ToolDef, type Usage } from "./llm";

export interface ModelConfig {
  provider: "openai" | "anthropic";
  model: string;
  effort: "low" | "medium" | "high";
  maxInputTokens: number;
  maxOutputTokens: number;
  // USD per million tokens is numerically equal to micro-USD per token.
  prices: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface RequestBudget {
  reserve(config: ModelConfig, inputBound: number): { costMicros: number; settle(usage: Usage, servedModel: string): void; fail(): void };
}
export interface ModelClient {
  readonly model: string;
  runTools(opts: { system: string; user: string; tools: ToolDef[]; maxTurns: number; usage: Usage }): Promise<string>;
  extract<T>(opts: { system: string; input: string; schema: z.ZodType<T>; usage: Usage }): Promise<T>;
}

type Item = Record<string, any>;
const count = z.number().int().nonnegative().safe();
const openAIUsage = z.object({ input_tokens: count, output_tokens: count, input_tokens_details: z.object({ cached_tokens: count, cache_write_tokens: count }) });
const anthropicUsage = z.object({ input_tokens: count, output_tokens: count, cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional() });
const toolCall = z.object({ id: z.string().min(1), name: z.string().min(1), input: z.unknown() });

export function modelCredentialsAvailable(provider: ModelConfig["provider"]): boolean {
  return process.env.AGENT_LLM !== "off" && Boolean(process.env[provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]?.trim());
}

/** Shared, explicitly budgeted provider client. No retries, fallback models or hosted tools. */
export class BudgetedModelClient implements ModelClient {
  readonly #config: ModelConfig;
  readonly #budget: RequestBudget;
  readonly #fetch: typeof fetch;
  constructor(config: ModelConfig, budget: RequestBudget, transport: typeof fetch = globalThis.fetch) {
    this.#config = structuredClone(config);
    this.#budget = budget;
    this.#fetch = transport;
  }
  get model(): string { return this.#config.model; }

  async #request(system: string, history: Item[], extra: Item, usage: Usage, priorOutputTokens: number) {
    const config = this.#config;
    if (!modelCredentialsAvailable(config.provider)) throw new Error(`${config.provider} requires an explicit API key and AGENT_LLM enabled`);
    const isOpenAI = config.provider === "openai";
    const body = isOpenAI ? {
      model: config.model, instructions: system, input: history, ...extra,
      reasoning: { effort: config.effort }, max_output_tokens: config.maxOutputTokens,
      store: false, include: ["reasoning.encrypted_content"], service_tier: "default",
      prompt_cache_options: { mode: "explicit" }, // No breakpoints: no cache-write charges.
    } : {
      model: config.model, system, messages: history, ...extra,
      max_tokens: config.maxOutputTokens, output_config: { effort: config.effort, ...extra.output_config },
    };
    // Visible UTF-8 bytes (at most one token per 3 bytes for JSON and English text), prior
    // opaque reasoning and protocol overhead form a conservative local input bound in
    // tokens. Refuse oversized histories before dispatch.
    const inputBound = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 3) + priorOutputTokens + 4096;
    const reservation = this.#budget.reserve(config, inputBound);
    usage.costMicros += reservation.costMicros; // Retained if billing cannot be verified.
    usage.turns++;
    const started = Date.now();
    let res: Item;
    try {
      if (isOpenAI) {
        const response = await this.#fetch("https://api.openai.com/v1/responses", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error("Provider request failed");
        res = await response.json() as Item;
      } else {
        // Explicit origin/key; ignore ambient base URLs and disable SDK retries.
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: 120_000, fetch: this.#fetch });
        res = await client.beta.messages.create(body as Anthropic.Beta.MessageCreateParamsNonStreaming);
      }
      if (!res || res.model !== config.model || (isOpenAI && res.service_tier !== "default")) throw new Error("Unapproved served model or service tier");
      const billed = emptyUsage();
      if (isOpenAI) {
        const u = openAIUsage.parse(res.usage);
        if (u.input_tokens_details.cache_write_tokens !== 0 || u.input_tokens_details.cached_tokens > u.input_tokens) throw new Error("Invalid cached usage");
        billed.inputTokens = u.input_tokens - u.input_tokens_details.cached_tokens;
        billed.cacheReadTokens = u.input_tokens_details.cached_tokens;
        billed.outputTokens = u.output_tokens; // Includes reasoning tokens; never add them twice.
      } else {
        const u = anthropicUsage.parse(res.usage);
        billed.inputTokens = u.input_tokens;
        billed.outputTokens = u.output_tokens;
        billed.cacheReadTokens = u.cache_read_input_tokens ?? 0;
        billed.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
      }
      billed.costMicros = Math.ceil(billed.inputTokens * config.prices.input + billed.outputTokens * config.prices.output + billed.cacheReadTokens * config.prices.cacheRead + billed.cacheWriteTokens * config.prices.cacheWrite);
      reservation.settle(billed, res.model);
      usage.costMicros += billed.costMicros - reservation.costMicros;
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) usage[key] += billed[key];
    } catch {
      reservation.fail();
      // Provider bodies and SDK errors can contain request data; do not persist them.
      throw new Error(`${config.provider} request or usage verification failed; budget stopped, reservation retained (no retry)`);
    } finally { usage.latencyMs += Date.now() - started; }
    if (isOpenAI ? res.status !== "completed" : !["end_turn", "tool_use"].includes(res.stop_reason)) throw new Error(`${config.provider} returned an incomplete or refused response`);
    const output: Item[] = isOpenAI ? res.output : res.content;
    if (!Array.isArray(output)) throw new Error("Missing model output");
    if (output.some((item) => item.type === "refusal" || item.content?.some((part: Item) => part.type === "refusal"))) throw new Error("Model refused the request");
    if (isOpenAI && output.some((item) => item.status && item.status !== "completed")) throw new Error("Incomplete model output item");
    if (output.some((item) => !(isOpenAI ? ["reasoning", "message", "function_call"] : ["thinking", "redacted_thinking", "text", "tool_use"]).includes(item.type))) throw new Error("Unexpected model output type");
    const calls = output.filter((item) => item.type === (isOpenAI ? "function_call" : "tool_use")).map((item) => toolCall.parse({
      id: isOpenAI ? item.call_id : item.id, name: item.name, input: isOpenAI ? item.arguments : item.input,
    }));
    const text = isOpenAI
      ? output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n")
      : output.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    return { output, calls, text: text.trim() };
  }

  async runTools(opts: Parameters<ModelClient["runTools"]>[0]): Promise<string> {
    if (!Number.isSafeInteger(opts.maxTurns) || opts.maxTurns < 1) throw new Error("A positive turn cap is required");
    const isOpenAI = this.#config.provider === "openai";
    const history: Item[] = [{ role: "user", content: opts.user }];
    const tools = opts.tools.map((t) => isOpenAI
      ? { type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: true }
      : { name: t.name, description: t.description, input_schema: t.inputSchema, strict: true });
    const seen = new Set<string>();
    const initialOutput = opts.usage.outputTokens;
    for (let turn = 0; turn < opts.maxTurns; turn++) {
      const res = await this.#request(opts.system, history, { tools }, opts.usage, opts.usage.outputTokens - initialOutput);
      if (!res.calls.length) {
        if (!res.text) throw new Error("Model returned an empty final answer");
        return res.text;
      }
      // Retain every reasoning/message/call item, including encrypted reasoning.
      history.push(...(isOpenAI ? res.output : [{ role: "assistant", content: res.output }]));
      const results: Item[] = [];
      for (const call of res.calls) {
        if (seen.has(call.id)) throw new Error("Repeated tool call ID");
        seen.add(call.id);
        opts.usage.toolCalls++;
        let result: unknown, failed = false;
        try {
          const tool = opts.tools.find((t) => t.name === call.name);
          if (!tool) throw new Error("Unknown tool");
          const input = tool.schema.parse(isOpenAI ? JSON.parse(call.input as string) : call.input);
          result = await tool.run(input);
        } catch { failed = true; result = { error: "Tool failed or input was invalid; check tool name, schema and evidence query." }; }
        results.push(isOpenAI
          ? { type: "function_call_output", call_id: call.id, output: JSON.stringify(result) ?? "null" }
          : { type: "tool_result", tool_use_id: call.id, is_error: failed, content: JSON.stringify(result) ?? "null" });
      }
      history.push(...(isOpenAI ? results : [{ role: "user", content: results }]));
    }
    throw new Error("Agent loop hit its turn limit");
  }

  async extract<T>(opts: { system: string; input: string; schema: z.ZodType<T>; usage: Usage }): Promise<T> {
    const schema = z.toJSONSchema(opts.schema);
    const extra = this.#config.provider === "openai"
      ? { text: { format: { type: "json_schema", name: "structured_result", strict: true, schema } } }
      : { output_config: { format: { type: "json_schema", schema } } };
    const res = await this.#request(opts.system, [{ role: "user", content: opts.input }], extra, opts.usage, 0);
    if (res.calls.length) throw new Error("Unexpected tool call in structured output");
    return opts.schema.parse(JSON.parse(res.text));
  }
}
