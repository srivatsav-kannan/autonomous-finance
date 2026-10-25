import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { ModelClient, ModelConfig, RequestBudget } from "./model-client";

// Provider: AGENT_PROVIDER=openai|anthropic. Default is OpenAI when an OpenAI key is present.
// Both providers go through BudgetedModelClient and the same local spend cap (AGENT_MAX_USD).
export const PROVIDER: "openai" | "anthropic" =
  process.env.AGENT_PROVIDER === "anthropic" || (process.env.AGENT_PROVIDER !== "openai" && !process.env.OPENAI_API_KEY) ? "anthropic" : "openai";
export const MODEL = process.env.AGENT_MODEL ?? (PROVIDER === "openai" ? "gpt-6.1-sol" : "claude-opus-5-5");

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

let available: boolean | null = null;

/** True when the selected provider has an API key (and AGENT_LLM isn't "off"). */
export function llmAvailable(): boolean {
  if (available !== null) return available;
  if (process.env.AGENT_LLM === "off") return (available = false);
  // The budgeted client authenticates with an explicit key only (no ambient tokens or profiles).
  available = Boolean(process.env[PROVIDER === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]?.trim());
  return available;
}

// List prices for the agent models, USD per million tokens (= micro-USD per token).
export const OPENAI_PRICES = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
// Claude Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write.
export const ANTHROPIC_PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
export const SPEND_FILE = process.env.AGENT_SPEND_FILE ?? path.join("var", "agent-spend.json");
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

const clients = new Map<string, ModelClient>();
/**
 * One budgeted client per provider, model, effort and output cap. No SDK retries and no
 * server-side fallbacks: each request is reserved against the cap before it is sent.
 */
async function budgeted(effort: Effort, model: string, kind: "extract" | "tools"): Promise<ModelClient> {
  const level = effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
  const deep = effort === "high" || effort === "xhigh" || effort === "max";
  // Claude's output cap matches what the unbudgeted path used (16,000), so thinking isn't truncated.
  const maxOutputTokens = PROVIDER === "anthropic" ? 16_000 : kind === "extract" && deep ? 32_000 : 8_000;
  const key = `${PROVIDER}:${model}:${level}:${maxOutputTokens}`;
  let c = clients.get(key);
  if (!c) {
    const { BudgetedModelClient } = await import("./model-client");
    const prices = PROVIDER === "openai" ? OPENAI_PRICES : ANTHROPIC_PRICES;
    c = new BudgetedModelClient({ provider: PROVIDER, model, effort: level, maxInputTokens: 100_000, maxOutputTokens, prices }, localBudget);
    clients.set(key, c);
  }
  return c;
}

export class LlmUnavailable extends Error {
  constructor(message = PROVIDER === "openai" ? "OpenAI is not configured (set OPENAI_API_KEY in .env.local)" : "Claude is not configured (set ANTHROPIC_API_KEY in .env.local)") {
    super(message);
  }
}

export class LlmRefused extends Error {}

/** The budgeted client reports refusals as plain errors; surface them as LlmRefused so they aren't retried. */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof LlmUnavailable) && e instanceof Error && /refus/i.test(e.message)) throw new LlmRefused(e.message);
    throw e;
  }
}

/** Structured extraction: the model returns JSON validated against a zod schema. */
export async function extract<T>(opts: {
  system: string;
  input: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  usage?: Usage;
  model?: string;
}): Promise<T> {
  if (!llmAvailable()) throw new LlmUnavailable();
  const client = await budgeted(opts.effort ?? "low", opts.model ?? MODEL, "extract");
  return await call(() => client.extract({ system: opts.system, input: opts.input, schema: opts.schema, usage: opts.usage ?? emptyUsage() }));
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
  const client = await budgeted(opts.effort ?? "medium", MODEL, "tools");
  return await call(() => client.runTools({ system: opts.system, user: opts.user, tools: opts.tools, maxTurns: opts.maxTurns ?? 12, usage: opts.usage ?? emptyUsage() }));
}
