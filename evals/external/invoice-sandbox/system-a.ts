// System A: one plain Claude agent with generic read-only file tools over the run workspace.
// No domain helpers, no calculator: it reads, reasons, and submits the final answer itself.
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { agentTurn, BudgetExceeded, type Effort } from "./lib/llm";
import { MONEY, Submission, writeSubmission } from "./lib/submission";
import { TASK_TEXT } from "./lib/task";
import type { Workspace } from "./lib/workspace";

const DEFAULT_LIMIT = 4000;
const MAX_LIMIT = 20000;

const ListDirInput = z.object({ path: z.string().describe('Workspace-relative directory, "." for the root') });
const ReadFileInput = z.object({
  path: z.string().describe("Workspace-relative file path"),
  offset: z.number().int().nullable().describe("Character offset to start from (null = 0)"),
  limit: z.number().int().nullable().describe(`Maximum characters to return (null = ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
});

function schemaOf(s: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  return zodOutputFormat(s as never).schema as Anthropic.Beta.BetaTool.InputSchema;
}

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "list_dir",
    description: "List the entries of a directory in the workspace (name, type, size in bytes, or entry count for directories).",
    input_schema: schemaOf(ListDirInput),
    strict: true,
  },
  {
    name: "read_file",
    description:
      "Read a file from the workspace as text. PDF files are returned as extracted text with '=== Page N of M ===' markers. " +
      `Returns up to \`limit\` characters (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) starting at \`offset\`; the header reports the file's total length so long files can be paged.`,
    input_schema: schemaOf(ReadFileInput),
    strict: true,
  },
  {
    name: "submit_results",
    description: "Submit the final answer. Call exactly once, when you are done. Money values are decimal strings with two decimals.",
    input_schema: schemaOf(Submission),
    strict: true,
  },
];

const SYSTEM = (maxTurns: number) => `You are an accounts-receivable analyst working alone with read-only access to a document workspace through the list_dir and read_file tools. You cannot run code.

${TASK_TEXT}

When you are finished, call submit_results with the complete answer. You have at most ${maxTurns} assistant turns (each turn may contain several tool calls, which run in parallel), so plan your reading.`;

export interface ARunResult {
  status: "submitted" | "turn_limit" | "budget" | "error";
  turns: number;
  toolCalls: number;
  costUsd: number;
  wallMs: number;
  error?: string;
}

export async function runSystemA(opts: {
  runId: string;
  ws: Workspace;
  outDir: string;
  effort: Effort;
  maxTurns: number;
  runCapUsd: number;
}): Promise<ARunResult> {
  const started = Date.now();
  fs.mkdirSync(opts.outDir, { recursive: true });
  const transcriptPath = path.join(opts.outDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const log = (o: unknown) => fs.appendFileSync(transcriptPath, JSON.stringify(o) + "\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: "Begin. The workspace root is \".\"." },
  ];
  let cost = 0;
  let toolCalls = 0;
  let nudges = 0;
  const finish = (status: ARunResult["status"], turns: number, error?: string): ARunResult => {
    const r: ARunResult = { status, turns, toolCalls, costUsd: cost, wallMs: Date.now() - started, ...(error ? { error } : {}) };
    fs.writeFileSync(path.join(opts.outDir, "run_result.json"), JSON.stringify(r, null, 2) + "\n");
    return r;
  };

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      const out = await agentTurn(
        { system: SYSTEM(opts.maxTurns), tools: TOOLS, messages, effort: opts.effort, maxTokens: 64000 },
        { runId: opts.runId, system: "A", purpose: `agent-turn-${turn}`, runCapUsd: opts.runCapUsd },
      );
      res = out.message;
      cost += out.entry.cost_usd;
      log({ turn, stop_reason: res.stop_reason, usage: out.entry, content: res.content });
    } catch (e) {
      if (e instanceof BudgetExceeded) return finish("budget", turn - 1, e.message);
      throw e;
    }
    if (res.stop_reason === "refusal") return finish("error", turn, `refusal: ${res.stop_details?.category ?? "unknown"}`);
    messages.push({ role: "assistant", content: res.content });

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      if (res.stop_reason === "max_tokens") return finish("error", turn, "max_tokens without a tool call");
      nudges++;
      if (nudges > 2) return finish("error", turn, "ended without calling submit_results");
      messages.push({ role: "user", content: "You have not called submit_results yet. Call it now with your complete final answer." });
      continue;
    }
    if (res.stop_reason === "max_tokens") return finish("error", turn, "tool input truncated at max_tokens");

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let submitted: Submission | null = null;
    for (const call of uses) {
      toolCalls++;
      const reply = (content: string, isError = false) => {
        results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
        log({ turn, tool: call.name, input: call.name === "submit_results" ? "(submission)" : call.input, is_error: isError, result_preview: content.slice(0, 300) });
      };
      try {
        if (call.name === "list_dir") {
          const input = ListDirInput.parse(call.input);
          reply(JSON.stringify(opts.ws.listDir(input.path)));
        } else if (call.name === "read_file") {
          const input = ReadFileInput.parse(call.input);
          const text = opts.ws.readText(input.path);
          const offset = Math.max(0, input.offset ?? 0);
          const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
          const slice = text.slice(offset, offset + limit);
          const end = offset + slice.length;
          const header = `[${opts.ws.resolve(input.path).rel} | characters ${offset}-${end} of ${text.length}]`;
          const footer = end < text.length ? `\n[${text.length - end} more characters; call read_file with offset=${end} to continue]` : "\n[end of file]";
          reply(`${header}\n${slice}${footer}`);
        } else if (call.name === "submit_results") {
          const parsed = Submission.safeParse(call.input);
          if (!parsed.success) {
            reply(`Invalid submission: ${parsed.error.message}`, true);
            continue;
          }
          const bad = parsed.data.customers.flatMap((c) =>
            (["gross_invoice_spend_usd", "credit_memo_total_usd", "net_spend_usd"] as const)
              .filter((k) => !MONEY.test(c[k]))
              .map((k) => `${c.customer_id}.${k}=${JSON.stringify(c[k])}`),
          );
          if (bad.length) {
            reply(`Invalid money format (need e.g. "12345.67"): ${bad.join(", ")}`, true);
            continue;
          }
          submitted = parsed.data;
          reply("Submission received.");
        } else {
          reply(`unknown tool ${call.name}`, true);
        }
      } catch (e) {
        reply(e instanceof Error ? e.message : String(e), true);
      }
    }
    if (submitted) {
      writeSubmission(opts.outDir, submitted);
      return finish("submitted", turn);
    }
    const left = opts.maxTurns - turn;
    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
    if (left <= 5) content.push({ type: "text", text: `${left} turn(s) remain. Call submit_results before the limit.` });
    messages.push({ role: "user", content });
  }
  return finish("turn_limit", opts.maxTurns);
}
