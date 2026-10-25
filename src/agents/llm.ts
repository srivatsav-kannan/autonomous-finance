import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";
const FALLBACKS = (process.env.AGENT_FALLBACKS ?? "1") !== "0";
const BETAS = FALLBACKS ? (["server-side-fallback-2026-07-01"] as const) : [];

// Claude Opus 5.5 list prices, in micro-dollars per token: $4 in, $20 out, $0.20 cache read, $5 cache write.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

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

/** True when the SDK can find credentials (API key, auth token, or an `ant` profile). */
export function llmAvailable(): boolean {
  if (available !== null) return available;
  if (process.env.AGENT_LLM === "off") return (available = false);
  available = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  return available;
}

function sdk(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export class LlmUnavailable extends Error {
  constructor() {
    super("Claude is not configured (set ANTHROPIC_API_KEY in .env.local)");
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
