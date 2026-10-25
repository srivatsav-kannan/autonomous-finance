// The agent loop. Mirrors finance_agent/get_agent.py semantics:
// - the loop ends only when submit_final_result is called with a non-empty result
//   (done=True) or the turn limit is reached (answer "" -> graded as wrong);
// - a text-only reply does not end the loop: "Continue." is appended as a user turn;
// - tool errors are returned to the model as tool results.
// Differences are tool-level (see README): Anthropic server-side web_search /
// web_fetch replace Tavily / parse_html_page / retrieve_information, and
// edgar_search uses SEC's EDGAR full-text search instead of sec-api.io.
import Anthropic from "@anthropic-ai/sdk";
import {
  EDGAR_RESULT_FORMAT,
  AGENT_EFFORT,
  AGENT_MAX_TOKENS,
  FALLBACK_BETA,
  MAX_TURNS,
  MODEL,
  PER_QUESTION_COST_CAP_USD,
  PER_QUESTION_WALL_CAP_S,
} from "./config";
import { EDGAR_TOOL, edgarSearch, pyJsonDumps } from "./edgar";
import { getClient } from "./env";
import { addCost, addTotals, costOfUsage, emptyCost, emptyTotals, type CostBreakdown, type TokenTotals } from "./pricing";
import { agentPrompt } from "./prompt";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResultParam = Anthropic.Beta.BetaToolResultBlockParam;

export const SUBMIT_TOOL: Anthropic.Beta.BetaTool = {
  name: "submit_final_result",
  description:
    "Submits the final answer to the user. You should include your final answer, as well as any necessary " +
    "reasoning, justification, calculations, and explanation. Finally, you should provide any sources used to answer the question. " +
    "You MUST use this tool to submit your final result. The user will not see your response if you do not use this tool to submit. " +
    "You will not be able to continue working after this tool is called; the conversation will be ended.",
  input_schema: {
    type: "object",
    properties: {
      final_result: { type: "string", description: "The final result to submit to the agent" },
    },
    required: ["final_result"],
  },
  eager_input_streaming: true,
};

/** Tool order follows get_agent.py (search, document access, EDGAR, then submit). */
export const AGENT_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
  EDGAR_TOOL,
  SUBMIT_TOOL,
];

export type AgentStatus = "submitted" | "max_turns" | "refusal" | "api_error" | "cost_cap" | "time_cap";

export interface ToolCallStats {
  web_search: number;
  web_fetch: number;
  /** web_search / web_fetch calls made from inside dynamic-filtering code. */
  web_search_in_code: number;
  web_fetch_in_code: number;
  code_execution: number;
  edgar_search: number;
  submit_final_result: number;
  other_client: number;
  errors: Record<string, number>;
}

export interface ApiCallLog {
  index: number;
  model: string;
  stop_reason: string | null;
  stop_details: unknown;
  iterations: number;
  usage: Anthropic.Beta.BetaUsage;
  cost_usd: number;
  seconds: number;
  fallback_blocks: { from: string; to: string }[];
}

export interface AgentRecord {
  status: AgentStatus;
  final_answer: string;
  final_error: string | null;
  turns: number;
  api_calls: number;
  pause_turns: number;
  continue_injections: number;
  tool_calls: ToolCallStats;
  tokens: TokenTotals;
  cost: CostBreakdown;
  wall_seconds: number;
  served_by_models: string[];
  calls: ApiCallLog[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emptyToolStats(): ToolCallStats {
  return {
    web_search: 0,
    web_fetch: 0,
    web_search_in_code: 0,
    web_fetch_in_code: 0,
    code_execution: 0,
    edgar_search: 0,
    submit_final_result: 0,
    other_client: 0,
    errors: {},
  };
}

/**
 * After a refusal fallback inside a streamed turn, blocks the declining model
 * produced before the last `fallback` block must not be echoed back (thinking,
 * tool_use, unpaired server_tool_use, unknown internal blocks). Text and paired
 * server-tool blocks stay. Without a fallback block the content is echoed as is.
 */
export function echoableContent(content: ContentBlock[]): ContentBlockParam[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  if (last < 0) return content as unknown as ContentBlockParam[];
  const resultIds = new Set(
    content.flatMap((b) => ("tool_use_id" in b && typeof b.tool_use_id === "string" ? [b.tool_use_id] : [])),
  );
  const keepTypes = new Set([
    "text",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
  ]);
  return content.filter((b, i) => {
    if (i >= last) return true;
    if (b.type === "server_tool_use") return resultIds.has(b.id);
    return keepTypes.has(b.type);
  }) as unknown as ContentBlockParam[];
}

function recordServerBlocks(content: ContentBlock[], stats: ToolCallStats) {
  for (const b of content) {
    if (b.type === "server_tool_use") {
      const inCode = !!b.caller && b.caller.type !== "direct";
      if (b.name === "web_search") inCode ? stats.web_search_in_code++ : stats.web_search++;
      else if (b.name === "web_fetch") inCode ? stats.web_fetch_in_code++ : stats.web_fetch++;
      else if (b.name === "code_execution" || b.name === "bash_code_execution" || b.name === "text_editor_code_execution") stats.code_execution++;
    } else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
      const c = b.content as unknown as { type?: string; error_code?: string };
      if (c && !Array.isArray(c) && typeof c.type === "string" && c.type.endsWith("_error")) {
        const key = `${b.type.replace("_tool_result", "")}:${c.error_code ?? "unknown"}`;
        stats.errors[key] = (stats.errors[key] ?? 0) + 1;
      }
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) return false;
  if (err instanceof Anthropic.AuthenticationError) return false;
  if (err instanceof Anthropic.PermissionDeniedError) return false;
  if (err instanceof Anthropic.NotFoundError) return false;
  if (err instanceof Anthropic.UnprocessableEntityError) return false;
  // RateLimit, InternalServer, overloaded mid-stream, connection errors and the
  // eager-streaming JSON parse failure of a tool input (turn is simply re-issued).
  return true;
}

async function callModel(messages: MessageParam[], deadline: number): Promise<{ msg: Anthropic.Beta.BetaMessage; seconds: number }> {
  const client = getClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Date.now() > deadline) break;
    const t0 = Date.now();
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: AGENT_MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: AGENT_EFFORT },
        cache_control: { type: "ephemeral" },
        tools: AGENT_TOOLS,
        messages,
      });
      const msg = await stream.finalMessage();
      return { msg, seconds: (Date.now() - t0) / 1000 };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      const wait = Math.min(120_000, 5000 * 2 ** attempt) * (0.5 + Math.random());
      console.error(`  [retry ${attempt + 1}] ${err instanceof Error ? err.message.slice(0, 200) : String(err)} (waiting ${Math.round(wait / 1000)}s)`);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`model call failed: ${String(lastErr)}`);
}

async function runClientTool(block: Anthropic.Beta.BetaToolUseBlock, stats: ToolCallStats): Promise<ToolResultParam> {
  if (block.name === "edgar_search") {
    stats.edgar_search++;
    try {
      const results = await edgarSearch(block.input);
      return { type: "tool_result", tool_use_id: block.id, content: EDGAR_RESULT_FORMAT === "compact" ? JSON.stringify(results) : pyJsonDumps(results) };
    } catch (err) {
      stats.errors["edgar_search"] = (stats.errors["edgar_search"] ?? 0) + 1;
      const message = err instanceof Error ? err.message : String(err);
      return { type: "tool_result", tool_use_id: block.id, content: message, is_error: true };
    }
  }
  stats.other_client++;
  stats.errors[`unknown_tool:${block.name}`] = (stats.errors[`unknown_tool:${block.name}`] ?? 0) + 1;
  return { type: "tool_result", tool_use_id: block.id, content: `Tool ${block.name} not found`, is_error: true };
}

export interface RunOptions {
  /** Called after every API response with the running cost of this question. */
  onCall?: (log: ApiCallLog, running: CostBreakdown) => void;
}

/** Runs one question end to end. Returns the record and the full message history. */
export async function runAgent(question: string, opts: RunOptions = {}): Promise<{ record: AgentRecord; messages: MessageParam[] }> {
  const started = Date.now();
  const deadline = started + PER_QUESTION_WALL_CAP_S * 1000;
  const messages: MessageParam[] = [{ role: "user", content: agentPrompt(question) }];
  const stats = emptyToolStats();
  let tokens = emptyTotals();
  let cost = emptyCost();
  const calls: ApiCallLog[] = [];
  const servedBy = new Set<string>();
  let turns = 0;
  let pauseTurns = 0;
  let continues = 0;
  let status: AgentStatus | null = null;
  let finalAnswer = "";
  let finalError: string | null = null;

  while (status === null) {
    if (turns >= MAX_TURNS) {
      status = "max_turns";
      finalError = `MaxTurnsExceeded: ${turns} turns without submit_final_result`;
      break;
    }
    if (cost.total >= PER_QUESTION_COST_CAP_USD) {
      status = "cost_cap";
      finalError = `Per-question cost cap $${PER_QUESTION_COST_CAP_USD} reached`;
      break;
    }
    if (Date.now() > deadline) {
      status = "time_cap";
      finalError = `Per-question wall-clock cap ${PER_QUESTION_WALL_CAP_S}s reached`;
      break;
    }

    let msg: Anthropic.Beta.BetaMessage;
    let seconds: number;
    try {
      ({ msg, seconds } = await callModel(messages, deadline));
    } catch (err) {
      status = "api_error";
      finalError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      break;
    }

    const c = costOfUsage(msg.usage);
    tokens = addTotals(tokens, c.totals);
    cost = addCost(cost, c.cost);
    turns += Math.max(1, c.totals.iterations);
    servedBy.add(msg.model);
    const fallbackBlocks = msg.content.flatMap((b) =>
      b.type === "fallback" ? [{ from: String(b.from.model), to: String(b.to.model) }] : [],
    );
    const log: ApiCallLog = {
      index: calls.length,
      model: msg.model,
      stop_reason: msg.stop_reason,
      stop_details: msg.stop_details ?? null,
      iterations: c.totals.iterations,
      usage: msg.usage,
      cost_usd: c.total,
      seconds,
      fallback_blocks: fallbackBlocks,
    };
    calls.push(log);
    opts.onCall?.(log, cost);
    recordServerBlocks(msg.content, stats);

    if (msg.stop_reason === "refusal") {
      status = "refusal";
      finalError = `refusal: ${JSON.stringify(msg.stop_details ?? null)}`;
      break;
    }

    messages.push({ role: "assistant", content: echoableContent(msg.content) });

    if (msg.stop_reason === "pause_turn") {
      // Server-side tool loop paused; re-send as is and the server resumes.
      pauseTurns++;
      continue;
    }

    const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // get_agent.py _before_query: a turn without tool calls gets "Continue.".
      continues++;
      messages.push({ role: "user", content: "Continue." });
      continue;
    }

    if (msg.stop_reason === "max_tokens") {
      // A tool input cut off by max_tokens may parse as a partial object: do not run it.
      messages.push({
        role: "user",
        content: toolUses.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          is_error: true,
          content: "The response hit max_tokens before this tool call was complete. Please try again.",
        })),
      });
      continue;
    }

    const submit = toolUses.find((t) => t.name === "submit_final_result");
    if (submit) {
      stats.submit_final_result++;
      const input = submit.input as { final_result?: unknown };
      const text = typeof input?.final_result === "string" ? input.final_result : "";
      if (text.trim()) {
        status = "submitted";
        finalAnswer = text;
        break;
      }
      // SubmitFinalResult.execute: empty submissions are an error and the loop goes on.
      stats.errors["submit_final_result"] = (stats.errors["submit_final_result"] ?? 0) + 1;
    }

    const results = await Promise.all(
      toolUses.map((t) =>
        t.name === "submit_final_result"
          ? Promise.resolve<ToolResultParam>({
              type: "tool_result",
              tool_use_id: t.id,
              is_error: true,
              content: "Final result must not be empty",
            })
          : runClientTool(t, stats),
      ),
    );
    messages.push({ role: "user", content: results });
  }

  const record: AgentRecord = {
    status: status!,
    final_answer: finalAnswer,
    final_error: finalError,
    turns,
    api_calls: calls.length,
    pause_turns: pauseTurns,
    continue_injections: continues,
    tool_calls: stats,
    tokens,
    cost,
    wall_seconds: (Date.now() - started) / 1000,
    served_by_models: [...servedBy],
    calls,
  };
  return { record, messages };
}
