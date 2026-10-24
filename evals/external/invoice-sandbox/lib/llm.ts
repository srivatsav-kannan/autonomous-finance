// Thin Claude wrapper for the invoice-sandbox eval. Same request shape as src/agents/llm.ts:
// beta Messages endpoint, server-side refusal fallbacks ("default"), output_config.effort,
// adaptive thinking left at its default, no sampling parameters, structured outputs via zod.
// Adds what an external benchmark needs: a spend ledger, a hard budget cap, and per-call logs.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { HARD_CAP_USD, LEDGER_PATH, loadApiKey } from "./config";

export const MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const USE_FALLBACKS = (process.env.INVOICE_SANDBOX_FALLBACKS ?? "1") !== "0";
const BETAS: Anthropic.Beta.AnthropicBeta[] = USE_FALLBACKS ? ["server-side-fallback-2026-07-01"] : [];
const FALLBACK_PARAM = USE_FALLBACKS ? { fallbacks: "default" as const } : {};

/** USD per million tokens (list prices; 5-minute cache writes are 1.25x input). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
// Anything unexpected (a fallback to a pricier model) is costed conservatively.
const UNKNOWN_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function costOf(model: string | null | undefined, u: TokenCounts): number {
  const p = PRICES[model ?? MODEL] ?? UNKNOWN_PRICE;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1e6
  );
}

export interface CallMeta {
  runId: string;
  system: string; // "A" | "B" | "smoke"
  purpose: string; // e.g. "agent-turn-3", "extract:invoices/INV-...pdf"
  runCapUsd?: number;
}

export interface LedgerEntry {
  ts: string;
  run_id: string;
  system: string;
  purpose: string;
  model_requested: string;
  models_served: string[];
  fallback_used: boolean;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  latency_ms: number;
  error?: string;
}

export class BudgetExceeded extends Error {}

export function readLedger(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs
    .readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry);
}

export function spent(filter?: (e: LedgerEntry) => boolean): number {
  return readLedger()
    .filter(filter ?? (() => true))
    .reduce((s, e) => s + e.cost_usd, 0);
}

function guard(meta: CallMeta): void {
  const total = spent();
  if (total >= HARD_CAP_USD) throw new BudgetExceeded(`hard cap reached: $${total.toFixed(2)} >= $${HARD_CAP_USD}`);
  if (meta.runCapUsd !== undefined) {
    const run = spent((e) => e.run_id === meta.runId);
    if (run >= meta.runCapUsd) throw new BudgetExceeded(`run cap reached for ${meta.runId}: $${run.toFixed(2)} >= $${meta.runCapUsd}`);
  }
}

function record(meta: CallMeta, msg: Anthropic.Beta.BetaMessage, latencyMs: number): LedgerEntry {
  const u = msg.usage;
  const iterations = u.iterations ?? [];
  const served = iterations.map((it) => ("model" in it && it.model ? String(it.model) : MODEL));
  const fallbackUsed = iterations.some((it) => it.type === "fallback_message");
  const topLevel = costOf(MODEL, u);
  const perIteration = iterations.reduce((s, it) => {
    if (it.type !== "message" && it.type !== "fallback_message") return s;
    return s + costOf("model" in it ? (it.model as string | null) : MODEL, it);
  }, 0);
  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    run_id: meta.runId,
    system: meta.system,
    purpose: meta.purpose,
    model_requested: MODEL,
    models_served: served.length ? [...new Set(served)] : [msg.model],
    fallback_used: fallbackUsed,
    stop_reason: msg.stop_reason,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cost_usd: Math.max(topLevel, perIteration), // conservative if the two ever disagree
    latency_ms: latencyMs,
  };
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

// Transport: Node 26's built-in fetch negotiates HTTP/2, and on this machine concurrent POSTs over the
// shared HTTP/2 connection completed one at a time (measured: six concurrent count_tokens calls finished
// ~130 ms apart; with HTTP/1.1 connections they finished together). System B's parallel calls need real
// concurrency, so requests go through an HTTP/1.1 undici Agent. Node bundles undici without exporting it,
// so the Agent class is taken from the global dispatcher, which exists after the first fetch.
let h1Dispatcher: Promise<unknown> | null = null;
const h1Fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  h1Dispatcher ??= (async () => {
    await fetch("https://api.anthropic.com/v1/models", { method: "HEAD" }).catch(() => undefined);
    const global = (globalThis as Record<symbol, { constructor: new (o: object) => unknown } | undefined>)[Symbol.for("undici.globalDispatcher.2")];
    return global ? new global.constructor({ allowH2: false }) : undefined;
  })();
  const dispatcher = await h1Dispatcher;
  return fetch(input, { ...init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
};

let client: Anthropic | null = null;
function sdk(): Anthropic {
  // Explicit key and base URL: the shell may carry another ANTHROPIC_BASE_URL / credentials.
  client ??= new Anthropic({ apiKey: loadApiKey(), baseURL: "https://api.anthropic.com", maxRetries: 4, timeout: 20 * 60 * 1000, fetch: h1Fetch });
  return client;
}

/** One agent turn, streamed (long thinking on the final turn), with automatic prompt caching of the prefix. */
export async function agentTurn(
  params: {
    system: string;
    tools: Anthropic.Beta.BetaToolUnion[];
    messages: Anthropic.Beta.BetaMessageParam[];
    effort: Effort;
    maxTokens: number;
  },
  meta: CallMeta,
): Promise<{ message: Anthropic.Beta.BetaMessage; entry: LedgerEntry }> {
  guard(meta);
  const started = Date.now();
  const stream = sdk().beta.messages.stream({
    model: MODEL,
    max_tokens: params.maxTokens,
    betas: BETAS,
    ...FALLBACK_PARAM,
    output_config: { effort: params.effort },
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: params.system }],
    tools: params.tools,
    messages: params.messages,
  });
  const message = await stream.finalMessage();
  return { message, entry: record(meta, message, Date.now() - started) };
}

export interface StructuredResult<T> {
  value: T | null;
  error: string | null;
  stopReason: string | null;
  entry: LedgerEntry;
  rawText: string;
}

/**
 * Structured output call (output_config.format from a zod schema). Uses create() + the helper's
 * parse() so usage is always recorded, even when the output fails validation.
 */
export async function structured<T>(
  params: { system: string; user: string; schema: z.ZodType<T>; effort: Effort; maxTokens?: number },
  meta: CallMeta,
): Promise<StructuredResult<T>> {
  guard(meta);
  const format = zodOutputFormat(params.schema as never);
  const started = Date.now();
  const msg = await sdk().beta.messages.create({
    model: MODEL,
    max_tokens: params.maxTokens ?? 16000,
    betas: BETAS,
    ...FALLBACK_PARAM,
    output_config: { effort: params.effort, format: { type: "json_schema", schema: format.schema } },
    system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: params.user }],
  });
  const entry = record(meta, msg, Date.now() - started);
  const rawText = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (msg.stop_reason === "refusal") return { value: null, error: "refusal", stopReason: msg.stop_reason, entry, rawText };
  if (msg.stop_reason === "max_tokens") return { value: null, error: "max_tokens", stopReason: msg.stop_reason, entry, rawText };
  try {
    return { value: format.parse(rawText) as T, error: null, stopReason: msg.stop_reason, entry, rawText };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e), stopReason: msg.stop_reason, entry, rawText };
  }
}

/** Free token count, used to size prompts before spending. */
export async function countTokens(system: string, user: string): Promise<number> {
  const res = await sdk().beta.messages.countTokens({
    model: MODEL,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: user }],
  });
  return res.input_tokens;
}
