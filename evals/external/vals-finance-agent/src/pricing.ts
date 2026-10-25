// Token accounting and cost. Uses usage.iterations (one entry per sampling
// iteration, including server-side tool loops and fallback attempts) when the
// API returns it, so per-model pricing is applied to each attempt.
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, PRICES, WEB_FETCH_USD_PER_1K, WEB_SEARCH_USD_PER_1K, type ModelPrice } from "./config";

type Usage = Anthropic.Beta.BetaUsage;

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
  /** Sampling iterations ("turns" in the Vals sense). */
  iterations: number;
  /** Iterations served by a refusal-fallback model rather than MODEL. */
  fallback_iterations: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  web_search: number;
  web_fetch: number;
  total: number;
}

export function emptyTotals(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    web_search_requests: 0,
    web_fetch_requests: 0,
    iterations: 0,
    fallback_iterations: 0,
  };
}

export function emptyCost(): CostBreakdown {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, web_search: 0, web_fetch: 0, total: 0 };
}

function priceFor(model: string | null | undefined): ModelPrice {
  const key = Object.keys(PRICES).find((k) => model === k || (model ?? "").startsWith(`${k}-`));
  return PRICES[key ?? MODEL]!;
}

interface Slice {
  model: string;
  fallback: boolean;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

function slices(usage: Usage, requestModel: string): Slice[] {
  const its = (usage.iterations ?? []).filter(
    (it) => it.type === "message" || it.type === "fallback_message",
  );
  const writeSplit = (total: number, cc: Anthropic.Beta.BetaCacheCreation | null | undefined) =>
    cc ? { write5m: cc.ephemeral_5m_input_tokens, write1h: cc.ephemeral_1h_input_tokens } : { write5m: total, write1h: 0 };
  if (its.length === 0) {
    return [
      {
        model: requestModel,
        fallback: false,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        ...writeSplit(usage.cache_creation_input_tokens ?? 0, usage.cache_creation),
      },
    ];
  }
  return its.map((it) => ({
    model: (it.model as string | null) ?? requestModel,
    fallback: it.type === "fallback_message",
    input: it.input_tokens,
    output: it.output_tokens,
    cacheRead: it.cache_read_input_tokens ?? 0,
    ...writeSplit(it.cache_creation_input_tokens ?? 0, it.cache_creation),
  }));
}

/** Token totals and USD cost of one API response. */
export function costOfUsage(usage: Usage, requestModel: string = MODEL): { totals: TokenTotals; cost: CostBreakdown; total: number } {
  const totals = emptyTotals();
  const cost = emptyCost();
  for (const s of slices(usage, requestModel)) {
    const p = priceFor(s.model);
    totals.input_tokens += s.input;
    totals.output_tokens += s.output;
    totals.cache_read_input_tokens += s.cacheRead;
    totals.cache_write_5m_tokens += s.write5m;
    totals.cache_write_1h_tokens += s.write1h;
    totals.iterations += 1;
    if (s.fallback) totals.fallback_iterations += 1;
    cost.input += (s.input * p.input) / 1e6;
    cost.output += (s.output * p.output) / 1e6;
    cost.cache_read += (s.cacheRead * p.cacheRead) / 1e6;
    cost.cache_write += (s.write5m * p.cacheWrite5m + s.write1h * p.cacheWrite1h) / 1e6;
  }
  totals.web_search_requests = usage.server_tool_use?.web_search_requests ?? 0;
  totals.web_fetch_requests = usage.server_tool_use?.web_fetch_requests ?? 0;
  cost.web_search = (totals.web_search_requests * WEB_SEARCH_USD_PER_1K) / 1000;
  cost.web_fetch = (totals.web_fetch_requests * WEB_FETCH_USD_PER_1K) / 1000;
  cost.total = cost.input + cost.output + cost.cache_read + cost.cache_write + cost.web_search + cost.web_fetch;
  return { totals, cost, total: cost.total };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof TokenTotals)[]) out[k] += b[k];
  return out;
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof CostBreakdown)[]) out[k] += b[k];
  return out;
}
