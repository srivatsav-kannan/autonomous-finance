/** OpenAI wire adapter for the unchanged historical baseline loop. No SDK defaults. */
import type Anthropic from "@anthropic-ai/sdk";
import type { Request } from "./capped-llm";

type Item = Record<string, unknown>;
export interface OpenAIRequest {
  model: string; instructions: string; input: Item[]; tools: Item[];
  reasoning: { effort: string; context: "all_turns" };
  max_output_tokens: number; service_tier: "default"; store: false;
  prompt_cache_options: { mode: "explicit" }; tool_choice: "auto"; parallel_tool_calls: true;
}
export interface OpenAIResponse {
  id: string; model: string; status: string; service_tier: string; output: Item[];
  incomplete_details?: { reason?: string };
  usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens: number; cache_write_tokens: number }; output_tokens_details?: { reasoning_tokens: number } };
}
export type OpenAITransport = (request: OpenAIRequest) => Promise<OpenAIResponse>;

export function createOpenAITransport(apiKey: string, timeout: number, fetcher: typeof fetch = fetch): OpenAITransport {
  if (!apiKey || !Number.isFinite(timeout) || timeout <= 0) throw new Error("Explicit OpenAI key and positive timeout required");
  return async (request) => {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.ceil(timeout)),
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    // Never print provider error bodies, request headers, or credentials.
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}; reservation retained; no retry`);
    return await response.json() as OpenAIResponse;
  };
}

export function openAIUsage(response: OpenAIResponse) {
  return {
    model: response.model, serviceTier: response.service_tier,
    inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
    cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens,
    cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
  };
}

export class OpenAIBridge {
  // The unchanged loop appends this exact content array. Keep every native output
  // item (encrypted reasoning, function call IDs, message phase) for the next turn.
  private readonly nativeOutput = new WeakMap<object, Item[]>();

  request(params: Request, model: string): OpenAIRequest {
    const input: Item[] = [];
    for (const message of params.messages) {
      if (!message.content) throw new Error("Baseline message content required");
      if (message.role === "assistant") {
        const native = typeof message.content !== "string" && this.nativeOutput.get(message.content);
        if (!native) throw new Error("Missing native OpenAI history; cannot reconstruct reasoning from text");
        input.push(...native);
      } else if (typeof message.content === "string") input.push({ role: "user", content: message.content });
      else for (const block of message.content) {
        if (block.type === "text") input.push({ role: "user", content: block.text });
        else if (block.type === "tool_result" && typeof block.content === "string") {
          input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.content });
        } else throw new Error("Unsupported baseline input block; refusing lossy translation");
      }
    }
    const tools = params.tools.map((tool) => {
      if (!("input_schema" in tool) || !tool.name || !tool.input_schema) throw new Error("Only baseline function tools supported");
      return { type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: tool.strict ?? false };
    });
    return { model, instructions: params.system, input, tools, reasoning: { effort: params.effort, context: "all_turns" }, max_output_tokens: params.maxTokens,
      service_tier: "default", store: false, prompt_cache_options: { mode: "explicit" }, tool_choice: "auto", parallel_tool_calls: true };
  }

  message(response: OpenAIResponse): Anthropic.Beta.BetaMessage {
    if (!Array.isArray(response.output) || !["completed", "incomplete"].includes(response.status)) throw new Error("Unusable OpenAI response status/output; actual usage retained");
    const content: Item[] = [];
    let refusal = false;
    const callIds = new Set<string>();
    const truncated = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
    if (response.status === "incomplete" && !truncated) throw new Error("Incomplete OpenAI response; actual usage retained");
    for (const item of response.output) {
      if (item.type === "reasoning") continue; // Preserved in nativeOutput, never converted to visible text.
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || callIds.has(item.call_id) || typeof item.name !== "string" || typeof item.arguments !== "string") throw new Error("Malformed OpenAI function call");
        callIds.add(item.call_id);
        // A truncated call cannot be executed by the baseline loop.
        const args: unknown = truncated ? {} : JSON.parse(item.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Function arguments must be an object");
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input: args });
      } else if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
        for (const part of item.content as Item[]) {
          if (part.type === "output_text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
          else if (part.type === "refusal" && typeof part.refusal === "string") { refusal = true; content.push({ type: "text", text: part.refusal }); }
          else throw new Error("Unsupported OpenAI message content");
        }
      } else throw new Error("Unexpected OpenAI output type; hosted tools are not authorized");
    }
    const usage = openAIUsage(response);
    const message = { id: response.id, model: response.model, role: "assistant", type: "message", content,
      stop_reason: refusal ? "refusal" : truncated ? "max_tokens" : callIds.size ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWriteTokens } } as unknown as Anthropic.Beta.BetaMessage;
    this.nativeOutput.set(message.content, response.output);
    return message;
  }
}
