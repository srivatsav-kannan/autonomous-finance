import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { ModelClient, ModelConfig, RequestBudget } from "./model-client";

// Provider: AGENT_PROVIDER=openai|anthropic. Default is OpenAI when an OpenAI key is present.
export const PROVIDER: "openai" | "anthropic" =
  process.env.AGENT_PROVIDER === "anthropic" || (process.env.AGENT_PROVIDER !== "openai" && !process.env.OPENAI_API_KEY) ? "anthropic" : "openai";
export const MODEL = process.env.AGENT_MODEL ?? (PROVIDER === "openai" ? "gpt-6.1-sol" : "claude-opus-5-5");
const FALLBACKS = (process.env.AGENT_FALLBACKS ?? "1") !== "0";
const BETAS = FALLBACKS ? (["server-side-fallback-2026-07-01"] as const) : [];

// Claude Opus 5.5 list prices, in micro-dollars per token: $4 in, $20 out, $0.20 cache read, $5 cache write.
export const ANTHROPIC_PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const PRICE = ANTHROPIC_PRICES;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  latencyMs: number;
  toolCalls: number;
  turns: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, latencyMs: 0, toolCalls: 0, turns: 0 };
}

function addUsage(u: Usage, usage: Anthropic.Beta.BetaUsage, ms: number): void {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  u.inputTokens += usage.input_tokens;
  u.outputTokens += usage.output_tokens;
  u.cacheReadTokens += cacheRead;
  u.cacheWriteTokens += cacheWrite;
  u.costMicros += Math.round(
    usage.input_tokens * PRICE.input + usage.output_tokens * PRICE.output + cacheRead * PRICE.cacheRead + cacheWrite * PRICE.cacheWrite,
  );
  u.latencyMs += ms;
  u.turns += 1;
}

let client: Anthropic | null = null;
let available: boolean | null = null;

/** True when the selected provider has credentials (and AGENT_LLM isn't "off"). */
export function llmAvailable(): boolean {
  if (available !== null) return available;
  if (process.env.AGENT_LLM === "off") return (available = false);
  available = PROVIDER === "openai"
    ? Boolean(process.env.OPENAI_API_KEY?.trim())
    : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  return available;
}

// OpenAI list prices for the agent model, USD per million tokens (= micro-USD per token).
export const OPENAI_PRICES = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
export const SPEND_FILE = path.join("var", "agent-spend.json");
const CAP_MICROS = Math.round(Number(process.env.AGENT_MAX_USD ?? "15") * 1e6);

/**
 * Hard local spend cap shared by every process on this machine (agents, gateway): a request is
 * refused before dispatch if its worst-case cost would take the running total past AGENT_MAX_USD.
 */
const localBudget: RequestBudget = {
  reserve(config: ModelConfig, inputBound: number) {
    const read = () => (fs.existsSync(SPEND_FILE) ? (JSON.parse(fs.readFileSync(SPEND_FILE, "utf8")) as { spentMicros: number }).spentMicros : 0);
    const add = (micros: number) => {
      fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
      fs.writeFileSync(SPEND_FILE, JSON.stringify({ spentMicros: read() + micros, capMicros: CAP_MICROS, updatedAt: new Date().toISOString() }));
    };
    const costMicros = Math.ceil(inputBound * config.prices.input + config.maxOutputTokens * config.prices.output);
    if (read() + costMicros > CAP_MICROS) throw new LlmUnavailable(`agent spend cap of $${(CAP_MICROS / 1e6).toFixed(2)} reached (${SPEND_FILE})`);
    return { costMicros, settle: (u: Usage) => add(u.costMicros), fail: () => add(costMicros) };
  },
};

const openaiClients = new Map<string, ModelClient>();
async function openai(effort: Effort, model: string, maxOutputTokens: number): Promise<ModelClient> {
  const level = effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
  const key = `${model}:${level}:${maxOutputTokens}`;
  let c = openaiClients.get(key);
  if (!c) {
    const { BudgetedModelClient } = await import("./model-client");
    c = new BudgetedModelClient({ provider: "openai", model, effort: level, maxInputTokens: 100_000, maxOutputTokens, prices: OPENAI_PRICES }, localBudget);
    openaiClients.set(key, c);
  }
  return c;
}

function sdk(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export class LlmUnavailable extends Error {
  constructor(message = PROVIDER === "openai" ? "OpenAI is not configured (set OPENAI_API_KEY in .env.local)" : "Claude is not configured (set ANTHROPIC_API_KEY in .env.local)") {
    super(message);
  }
}

export class LlmRefused extends Error {}

/**
 * Structured extraction: Claude returns JSON validated against a zod schema.
 * The system prompt is cached; the document goes after the breakpoint.
 */
export async function extract<T>(opts: {
  system: string;
  input: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  usage?: Usage;
  model?: string;
}): Promise<T> {
  if (!llmAvailable()) throw new LlmUnavailable();
  if (PROVIDER === "openai") {
    const client = await openai(opts.effort ?? "low", opts.model ?? MODEL, opts.effort === "high" || opts.effort === "xhigh" || opts.effort === "max" ? 32_000 : 8_000);
    return await client.extract({ system: opts.system, input: opts.input, schema: opts.schema, usage: opts.usage ?? emptyUsage() });
  }
  const started = Date.now();
  const res = await sdk().beta.messages.parse({
    model: opts.model ?? MODEL,
    max_tokens: 16000,
    betas: [...BETAS],
    ...(FALLBACKS ? { fallbacks: "default" as const } : {}),
    output_config: { effort: opts.effort ?? "low", format: zodOutputFormat(opts.schema as never) },
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.input }],
  });
  if (opts.usage) addUsage(opts.usage, res.usage, Date.now() - started);
  if (res.stop_reason === "refusal") throw new LlmRefused(`refused: ${res.stop_details?.category ?? "unknown"}`);
  if (res.parsed_output === null || res.parsed_output === undefined) throw new Error("no structured output returned");
  return res.parsed_output as T;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  inputSchema: Record<string, unknown>; // JSON schema with additionalProperties: false
  run: (input: unknown) => Promise<unknown>;
}

/**
 * A bounded agent loop over our own typed tools. Every tool call is validated with zod,
 * then executed against the kernel, which re-checks permissions. Returns the final text.
 */
export async function runTools(opts: {
  system: string;
  user: string;
  tools: ToolDef[];
  effort?: Effort;
  maxTurns?: number;
  usage?: Usage;
}): Promise<string> {
  if (!llmAvailable()) throw new LlmUnavailable();
  if (PROVIDER === "openai") {
    const client = await openai(opts.effort ?? "medium", MODEL, 8_000);
    return await client.runTools({ system: opts.system, user: opts.user, tools: opts.tools, maxTurns: opts.maxTurns ?? 12, usage: opts.usage ?? emptyUsage() });
  }
  const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.user }];
  for (let turn = 0; turn < (opts.maxTurns ?? 12); turn++) {
    const started = Date.now();
    const res = await sdk().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [...BETAS],
      ...(FALLBACKS ? { fallbacks: "default" as const } : {}),
      output_config: { effort: opts.effort ?? "medium" },
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    if (opts.usage) addUsage(opts.usage, res.usage, Date.now() - started);
    if (res.stop_reason === "refusal") throw new LlmRefused(`refused: ${res.stop_details?.category ?? "unknown"}`);
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (toolUses.length === 0 || res.stop_reason === "end_turn") {
      return res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    }
    if (res.stop_reason === "max_tokens") throw new Error("tool input truncated at max_tokens");
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (call) => {
        if (opts.usage) opts.usage.toolCalls++;
        const tool = byName.get(call.name);
        if (!tool) return { type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: `unknown tool ${call.name}` };
        const parsed = tool.schema.safeParse(call.input);
        if (!parsed.success) {
          return { type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: `invalid input: ${parsed.error.message}` };
        }
        try {
          const out = await tool.run(parsed.data);
          return { type: "tool_result" as const, tool_use_id: call.id, content: JSON.stringify(out) };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  throw new Error("agent loop hit its turn limit");
}
