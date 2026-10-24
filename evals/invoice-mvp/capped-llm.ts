/** Replacement transport only; historical A prompt, tools and agent loop are unchanged. */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIBridge, createOpenAITransport, openAIUsage, type OpenAITransport } from "./openai-responses";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export class BudgetExceeded extends Error {}
export interface CappedConfig { authorization: string; ledger: string; runId: string; python: string; explicitLive: boolean; }
export type Request = { system: string; tools: Anthropic.Beta.BetaToolUnion[]; messages: Anthropic.Beta.BetaMessageParam[]; effort: Effort; maxTokens: number };
type WireRequest = { model: string; max_tokens: number; system: Anthropic.Beta.BetaTextBlockParam[]; tools: Anthropic.Beta.BetaToolUnion[]; messages: Anthropic.Beta.BetaMessageParam[]; output_config: { effort: Effort } };
export type Transport = (request: WireRequest) => Promise<Anthropic.Beta.BetaMessage>;
let config: CappedConfig | undefined, transport: Transport | undefined, started = 0;
let openAITransport: OpenAITransport | undefined, openAIBridge = new OpenAIBridge();
export function configureCappedTransport(value: CappedConfig, injected?: Transport, injectedOpenAI?: OpenAITransport) {
  if (!value.explicitLive && !injected && !injectedOpenAI) throw new Error("Live baseline requires explicit opt-in");
  config = value; transport = injected; started = Date.now();
  openAITransport = injectedOpenAI; openAIBridge = new OpenAIBridge();
}
function budget(action: string, details: object): Record<string, number> {
  if (!config) throw new Error("Capped transport is not configured");
  try {
    return JSON.parse(execFileSync(config.python, [path.join(path.dirname(fileURLToPath(import.meta.url)), "budget.py")], {
      input: JSON.stringify({ action, authorization: config.authorization, ledger: config.ledger, runId: config.runId, ...details }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch { throw new BudgetExceeded("Persistent pre-request budget/authorization check failed; no retry permitted"); }
}
export function createCappedClient(apiKey: string, timeout: number) {
  return new Anthropic({ apiKey, authToken: null, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout });
}
export async function agentTurn(params: Request, meta: { runId: string; system: string; purpose: string; runCapUsd?: number }) {
  if (!config || meta.runId !== config.runId) throw new Error("Run identity differs from configured authorization");
  // Read no credential until validation and persisted reservation have succeeded.
  const authorization = JSON.parse(fs.readFileSync(config.authorization, "utf8"));
  const approved = authorization.runs[config.runId];
  if (!approved || approved.kind !== "baseline") throw new Error("Baseline run not authorized");
  if (Date.now() - started >= approved.timeoutSeconds * 1000) throw new BudgetExceeded("Approved wall-time limit reached");
  if (meta.runCapUsd !== undefined && Math.round(meta.runCapUsd * 1e6) !== approved.maxCostMicros) throw new Error("Agent run cap differs from authorization");
  if (params.maxTokens > approved.maxOutputTokens) throw new BudgetExceeded("Unchanged baseline max_tokens exceeds approved bound");
  if (approved.provider === "openai") {
    if (params.effort !== approved.effort) throw new Error("Reasoning effort differs from authorization");
    const wire = openAIBridge.request(params, approved.model);
    // Opaque encrypted reasoning bytes do not prove a token bound. Reserve every
    // prior response's reported output tokens in addition to the full wire bytes.
    const priorOutputTokenAllowance = openAIBridge.priorOutputTokenAllowance(params);
    const inputBound = Buffer.byteLength(JSON.stringify(wire), "utf8") + 4096 + priorOutputTokenAllowance;
    budget("reserve", { requestId: meta.purpose, inputTokens: inputBound, outputTokens: params.maxTokens });
    const begin = Date.now();
    let send = openAITransport;
    if (!send) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!config.explicitLive || !apiKey) throw new Error("OPENAI_API_KEY and explicit live opt-in required; reservation retained");
      const remaining = approved.timeoutSeconds * 1000 - (Date.now() - started);
      if (remaining <= 0) throw new BudgetExceeded("Approved wall-time limit reached; reservation retained");
      send = createOpenAITransport(apiKey, Math.min(60000, remaining));
    }
    const response = await send(wire);
    const usage = openAIUsage(response);
    // Settle even unusable outputs when usage is complete; invalid accounting halts.
    const settled = budget("settle", { requestId: meta.purpose, usage });
    const message = openAIBridge.message(response);
    const entry = { ts: new Date().toISOString(), run_id: meta.runId, system: "A-capped", purpose: meta.purpose, provider: "openai", model_requested: approved.model, models_served: [response.model], fallback_used: false, stop_reason: message.stop_reason, input_tokens: usage.inputTokens!, output_tokens: usage.outputTokens!, reasoning_tokens: usage.reasoningTokens!, cache_read_input_tokens: usage.cacheReadTokens!, cache_creation_input_tokens: usage.cacheWriteTokens!, cost_usd: settled.costMicros! / 1e6, latency_ms: Date.now() - begin, system_sha256: createHash("sha256").update(params.system).digest("hex"), tools_sha256: createHash("sha256").update(JSON.stringify(params.tools)).digest("hex"), wire_sha256: createHash("sha256").update(JSON.stringify(wire)).digest("hex"), input_token_bound: inputBound, prior_output_token_allowance: priorOutputTokenAllowance, max_output_tokens: params.maxTokens, provider_response: response };
    return { message, entry };
  }
  const request: WireRequest = { model: approved.model, max_tokens: params.maxTokens, output_config: { effort: params.effort }, system: [{ type: "text", text: params.system }], tools: params.tools, messages: params.messages };
  // Text-only byte bound plus protocol allowance; conservative limits may stop early.
  const inputBound = Buffer.byteLength(JSON.stringify(request), "utf8") + 4096;
  budget("reserve", { requestId: meta.purpose, inputTokens: inputBound, outputTokens: params.maxTokens });
  const begin = Date.now();
  if (!transport) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!config.explicitLive || !apiKey) throw new Error("ANTHROPIC_API_KEY and explicit live opt-in required; reservation retained");
    const sdk = createCappedClient(apiKey, Math.min(60000, approved.timeoutSeconds * 1000));
    transport = (wire) => sdk.beta.messages.stream(wire).finalMessage();
  }
  // Errors retain the entire reservation; callers must not retry automatically.
  const message = await transport(request);
  if ((message.usage.iterations ?? []).some((item) => item.type === "fallback_message")) throw new Error("Unexpected provider fallback; reservation retained");
  const usage = { model: message.model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0 };
  const settled = budget("settle", { requestId: meta.purpose, usage });
  const entry = { ts: new Date().toISOString(), run_id: meta.runId, system: "A-capped", purpose: meta.purpose, model_requested: approved.model, models_served: [message.model], fallback_used: false, stop_reason: message.stop_reason, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWriteTokens, cost_usd: settled.costMicros! / 1e6, latency_ms: Date.now() - begin, system_sha256: createHash("sha256").update(params.system).digest("hex"), tools_sha256: createHash("sha256").update(JSON.stringify(params.tools)).digest("hex"), input_token_bound: inputBound, max_output_tokens: params.maxTokens };
  return { message, entry };
}
