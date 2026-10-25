import { InvoiceError } from "./backend";
import { INVESTIGATOR_POLICY, ModelResponseError, TOOL_SCHEMAS, type InvestigatorModel, type ModelProvider, type ModelRequest, type ModelUsage, type Observation, type ResourceBudget, type ToolAction, type ToolName } from "./model";

export const OPENAI_INVOICE_MODEL = "gpt-6.1-sol";
export const OPENAI_INPUT_CEILING = 100_000;
export const OPENAI_OUTPUT_CEILING = 4096;
export const OPENAI_REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_URL = "https://api.openai.com/v1/responses";

// Existing tools have optional fields. Opt out of Responses schema normalization;
// the application validates every tool input and the backend revalidates evidence.
export const OPENAI_TOOL_SCHEMAS = Object.freeze(TOOL_SCHEMAS.map((tool) => Object.freeze({
  type: "function" as const, name: tool.name, description: tool.description,
  parameters: tool.input_schema, strict: false,
})));

type Item = Record<string, unknown>;
type Continuation = { caseId: string; evidenceVersion: number; decisionSummaries: string; history: Item[]; observationPrefix: string; observationCount: number; call: { id: string; action: ToolAction }; outputTokens: number };
const object = (value: unknown): Item | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const containsBreakpoint = (value: unknown): boolean => Array.isArray(value) ? value.some(containsBreakpoint) : !!object(value) && Object.entries(value as Item).some(([key, child]) => key === "prompt_cache_breakpoint" || containsBreakpoint(child));
const textParts = (value: unknown, type: string): boolean => Array.isArray(value) && value.every((part) => object(part)?.type === type && typeof object(part)?.text === "string");
const replayableReasoning = (item: Item): boolean => typeof item.id === "string" && item.id.length > 0
  && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
  && textParts(item.summary, "summary_text")
  && (item.content === undefined || textParts(item.content, "reasoning_text"))
  && (item.status === undefined || item.status === "completed");

/** First-party Responses transport. Only next() can dispatch, and only after explicit setup. */
export class OpenAIInvestigator implements InvestigatorModel {
  readonly mode = "live_model" as const;
  readonly model = OPENAI_INVOICE_MODEL;
  readonly effort = "high" as const;
  readonly reasoningContext = "all_turns" as const;
  readonly provider: ModelProvider;
  readonly toolSchemas = OPENAI_TOOL_SCHEMAS;
  readonly budget: ResourceBudget;
  readonly maxOutputTokens: number;
  readonly #apiKey: string;
  readonly #prices: Readonly<{ inputMicros: number; outputMicros: number }>;
  readonly #transport: typeof fetch;
  // Opaque provider state is scoped by this investigation's observation array.
  // It is never returned, logged, persisted, or reused by a restarted investigation.
  readonly #continuations = new WeakMap<Observation[], Continuation>();

  constructor(budget: ResourceBudget, prices: { inputMicros: number; outputMicros: number }, maxOutputTokens = OPENAI_OUTPUT_CEILING, explicitOptIn = false, transport: typeof fetch = globalThis.fetch) {
    if (!explicitOptIn) throw new InvoiceError("live_opt_in_required", "OpenAI inference requires explicit opt-in and a capped resource budget.");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) throw new InvoiceError("model_unconfigured", "An explicit OPENAI_API_KEY is required for the first-party invoice investigator.");
    for (const n of [...Object.values(budget), maxOutputTokens]) if (!Number.isSafeInteger(n) || n <= 0) throw new InvoiceError("invalid_budget", "Positive safe-integer resource limits are required.");
    for (const n of Object.values(prices)) if (!Number.isFinite(n) || n <= 0) throw new InvoiceError("invalid_budget", "Explicit positive maximum token prices are required.");
    if (budget.maxInputTokens > OPENAI_INPUT_CEILING || budget.maxOutputTokens > OPENAI_OUTPUT_CEILING || maxOutputTokens > budget.maxOutputTokens) throw new InvoiceError("invalid_budget", "OpenAI preparation is bounded to 100000 input and 4096 total output tokens per request.");
    this.budget = Object.freeze({ ...budget });
    this.maxOutputTokens = maxOutputTokens;
    this.#prices = Object.freeze({ ...prices });
    this.#apiKey = apiKey;
    this.#transport = transport;
    this.provider = Object.freeze({ baseURL: "https://api.openai.com/v1", api: "responses", authentication: "explicit_api_key", pricing: this.#prices, servedModelValidated: true, cacheUsageValidated: true, serviceTier: "default", promptCacheMode: "explicit_without_breakpoints" });
  }

  #prepare(request: ModelRequest) {
    const previous = this.#continuations.get(request.observations);
    let input: Item[];
    if (!previous) {
      if (request.observations.length) throw new InvoiceError("continuation_missing", "Provider continuation is unavailable; restart investigation from persisted evidence rather than inventing tool history.");
      input = [{ role: "developer", content: INVESTIGATOR_POLICY }, { role: "user", content: JSON.stringify({ caseId: request.caseId, evidenceVersion: request.evidenceVersion, decisionSummaries: request.decisionSummaries }) }];
    } else {
      if (request.caseId !== previous.caseId || request.evidenceVersion !== previous.evidenceVersion || JSON.stringify(request.decisionSummaries) !== previous.decisionSummaries || request.observations.length !== previous.observationCount + 1 || JSON.stringify(request.observations.slice(0, previous.observationCount)) !== previous.observationPrefix) throw new InvoiceError("continuation_invalid", "Provider continuation requires unchanged evidence and append-only tool observations.");
      const observation = request.observations.at(-1)!;
      if (observation.tool !== previous.call.action.name || JSON.stringify(observation.input) !== JSON.stringify(previous.call.action.input)) throw new InvoiceError("continuation_invalid", "Tool result does not match the selected provider call.");
      input = [...previous.history, { type: "function_call_output", call_id: previous.call.id, output: JSON.stringify({ result: observation.result, ...(observation.error ? { error: true } : {}) }) }];
    }
    return { previous, body: { model: this.model, input, tools: this.toolSchemas, tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: this.effort, context: this.reasoningContext }, service_tier: "default", store: false, include: ["reasoning.encrypted_content"], prompt_cache_options: { mode: "explicit" }, max_output_tokens: this.maxOutputTokens } };
  }

  release(observations: Observation[]): void { this.#continuations.delete(observations); }

  reservation(request: ModelRequest): ModelUsage {
    const { body, previous } = this.#prepare(request);
    // UTF-8 bytes conservatively bound visible prompt tokenization. Also reserve all
    // prior output tokens for opaque replay plus protocol overhead before dispatch.
    const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8") + (previous?.outputTokens ?? 0) + 4096;
    const costMicros = Math.ceil(inputTokens * this.#prices.inputMicros + this.maxOutputTokens * this.#prices.outputMicros);
    if (!Number.isSafeInteger(costMicros)) throw new InvoiceError("invalid_budget", "Request reservation exceeds safe integer cost bounds.");
    return { inputTokens, outputTokens: this.maxOutputTokens, costMicros, durationMs: 0 };
  }

  async next(request: ModelRequest): Promise<{ action: ToolAction; usage: ModelUsage; usageSummary: string }> {
    try { return await this.#next(request); }
    catch (error) { this.release(request.observations); throw error; }
  }

  async #next(request: ModelRequest): Promise<{ action: ToolAction; usage: ModelUsage; usageSummary: string }> {
    const reservation = this.reservation(request);
    if (reservation.inputTokens > this.budget.maxInputTokens || reservation.costMicros > this.budget.maxCostMicros) throw new InvoiceError("resource_limit", "OpenAI request exceeds configured pre-request bounds.");
    const { body, previous } = this.#prepare(request);
    const started = Date.now();
    let result: Item;
    try {
      const response = await this.#transport(RESPONSE_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#apiKey}` }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error("Unsuccessful provider response");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("Oversized provider response");
      const parsed = object(JSON.parse(text));
      if (!parsed) throw new Error("Invalid provider response");
      result = parsed;
    } catch {
      this.#continuations.delete(request.observations);
      throw new InvoiceError("model_transport_failed", "OpenAI request failed without usable response usage; no retry or fallback was attempted.");
    }
    // A later failure must never leave a reusable pending provider continuation.
    this.#continuations.delete(request.observations);
    const reported = object(result.usage);
    if (!count(reported?.input_tokens) || !count(reported?.output_tokens)) throw new InvoiceError("model_usage_unavailable", "OpenAI response did not include complete input/output usage; actual cost is unavailable.");
    const usage: ModelUsage = { inputTokens: reported.input_tokens, outputTokens: reported.output_tokens, costMicros: Math.ceil(reported.input_tokens * this.#prices.inputMicros + reported.output_tokens * this.#prices.outputMicros), durationMs: Date.now() - started };
    const inputDetails = object(reported.input_tokens_details), outputDetails = object(reported.output_tokens_details);
    const reasoningTokens = outputDetails?.reasoning_tokens;
    const invalidUsage = !count(reported.total_tokens) || reported.total_tokens !== usage.inputTokens + usage.outputTokens || !count(reasoningTokens) || reasoningTokens > usage.outputTokens;
    if (invalidUsage) throw new ModelResponseError("OpenAI response usage was incomplete or inconsistent; actual cost is unavailable.", { ...usage, costMicros: null });
    const usageSummary = `Total output includes ${reasoningTokens} reasoning tokens; no reasoning content is retained in audit.`;
    const writeDetails = inputDetails?.cache_write_tokens_details;
    const writeCounts = object(writeDetails);
    if (inputDetails?.cached_tokens !== 0 || inputDetails?.cache_write_tokens !== 0 || writeDetails !== undefined && (!writeCounts || Object.values(writeCounts).some((tokens) => tokens !== 0))) throw new ModelResponseError("OpenAI cache usage was nonzero or unavailable; actual cost is unavailable with uncached rates.", { ...usage, costMicros: null }, usageSummary);
    if (result.model !== this.model || result.service_tier !== "default") throw new ModelResponseError("OpenAI served model or tier did not match the configured standard request; actual cost is unavailable.", { ...usage, costMicros: null }, usageSummary);
    if (!Number.isSafeInteger(usage.costMicros)) throw new ModelResponseError("OpenAI response cost exceeded safe numeric bounds; actual cost is unavailable.", { ...usage, costMicros: null }, usageSummary);
    if (usage.inputTokens > Math.min(reservation.inputTokens, this.budget.maxInputTokens) || usage.outputTokens > this.maxOutputTokens) throw new ModelResponseError("OpenAI response usage exceeded the reserved request bounds; review the held reservation.", usage, usageSummary);
    if (result.status !== "completed" || result.error) throw new ModelResponseError("OpenAI response was incomplete or failed; no action was executed.", usage, usageSummary);
    const output = Array.isArray(result.output) ? result.output : [];
    if (output.some((item) => !object(item))) throw new ModelResponseError("OpenAI response contained malformed output items; no action was executed.", usage, usageSummary);
    if (output.some((item: Item) => !["reasoning", "message", "function_call"].includes(item.type as string))) throw new ModelResponseError("OpenAI response contained unsupported output types; no action or continuation was accepted.", usage, usageSummary);
    // Stateless replay needs complete encrypted reasoning, not a stored item reference.
    // Validate only structure; preserve all original fields and never expose their values.
    if (output.some((item: Item) => item.type === "reasoning" && !replayableReasoning(item))) throw new ModelResponseError("OpenAI response reasoning was not complete for stateless replay; no action or continuation was accepted.", usage, usageSummary);
    if (containsBreakpoint(output)) throw new ModelResponseError("OpenAI output contained unexpected cache configuration; no continuation was accepted.", usage, usageSummary);
    const calls = output.filter((item: Item) => item.type === "function_call") as Item[];
    if (calls.length !== 1) throw new ModelResponseError("OpenAI response did not contain exactly one function call; the bounded investigation stopped.", usage, usageSummary);
    const call = calls[0]!;
    let input: Item | undefined;
    try { input = typeof call.arguments === "string" ? object(JSON.parse(call.arguments)) : undefined; } catch { /* Safe typed error below; never retain raw arguments. */ }
    if (typeof call.call_id !== "string" || !call.call_id || call.status !== undefined && call.status !== "completed" || !TOOL_SCHEMAS.some((tool) => tool.name === call.name) || !input) throw new ModelResponseError("OpenAI function call was malformed or unsupported; no action was executed.", usage, usageSummary);
    if (previous?.history.some((item) => item.type === "function_call" && item.call_id === call.call_id)) throw new ModelResponseError("OpenAI function call identifier was reused; no action was executed.", usage, usageSummary);
    const action = { name: call.name as ToolName, input };
    this.#continuations.set(request.observations, { caseId: request.caseId, evidenceVersion: request.evidenceVersion, decisionSummaries: JSON.stringify(request.decisionSummaries), history: [...body.input, ...structuredClone(output)], observationPrefix: JSON.stringify(request.observations), observationCount: request.observations.length, call: { id: call.call_id, action: structuredClone(action) }, outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens });
    return { action, usage, usageSummary };
  }
}
