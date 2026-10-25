/**
 * DABstep runner (Adyen + Hugging Face, https://huggingface.co/datasets/adyen/DABstep).
 *
 * Claude Opus 5.5 answers each task by writing and running pandas code inside Anthropic's
 * server-side code execution sandbox (`code_execution_20260521`). The seven context files are
 * uploaded once through the Files API and copied into every task's fresh container with
 * `container_upload` blocks, so no model-written code ever runs on this machine.
 *
 *   npx tsx evals/external/dabstep/run.ts --probe                      # where do uploads land?
 *   npx tsx evals/external/dabstep/run.ts --label pilot --task-ids 1273
 *   npx tsx evals/external/dabstep/run.ts --label dev-x3 --runs 3
 *
 * Every request's cost is appended to var/dabstep/ledger.jsonl; the runner refuses to start
 * requests that could push the ledger past --budget-usd. Scoring is done separately by
 * score.py with the official DABstep scorer.
 */
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const VAR_DIR = path.join(REPO, "var", "dabstep");

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// List prices in USD per million tokens. Cache writes: 1.25x input (5 min TTL), 2x input (1 h TTL).
// Non-Opus-5.5 rows only matter if a server-side fallback serves part of a turn.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
// Code execution without web tools: $0.05 per container-hour after 1,550 free hours per org per
// month, 5-minute minimum. We record an upper bound that ignores the free hours.
const CONTAINER_USD_PER_HOUR = 0.05;
const CONTAINER_MIN_HOURS = 5 / 60;

const CONTEXT_FILES: ReadonlyArray<readonly [name: string, mime: string]> = [
  ["manual.md", "text/markdown"],
  ["payments-readme.md", "text/markdown"],
  ["payments.csv", "text/csv"],
  ["fees.json", "application/json"],
  ["merchant_data.json", "application/json"],
  ["merchant_category_codes.csv", "text/csv"],
  ["acquirer_countries.csv", "text/csv"],
];

// Adapted from the DABstep baseline (baseline/prompts.py in the adyen/DABstep Space):
// same Explore -> Plan -> Execute -> Conclude workflow and rules; the tool is Anthropic's code
// execution sandbox instead of a smolagents Python executor, and the final answer goes in tags.
// Probed with --probe: container_upload files land in $INPUT_DIR (/files/input/<id>/<filename>).
const FILE_LOCATION =
  "They are in the directory named by the environment variable INPUT_DIR (for example $INPUT_DIR/manual.md; in Python use os.environ['INPUT_DIR']).";
export const SYSTEM_PROMPT = `You are an expert data analyst who can solve any task using code. You will be given a task to solve as best as you can.
In your code execution environment there exists data which will help you solve your data analyst task. This data is spread out across seven files that have been uploaded into your container: manual.md, payments-readme.md, payments.csv, fees.json, merchant_data.json, merchant_category_codes.csv and acquirer_countries.csv. ${FILE_LOCATION}
Python with pandas and numpy is available in the container. It has no internet access.

When solving a task you must follow this root-level workflow: 'Explore' -> 'Plan' -> 'Execute' -> 'Conclude'.
1. Explore: Begin by reading manual.md and payments-readme.md in full (print the entire files; do not truncate them). They define the business concepts, fee rules and field semantics that the tasks depend on. Then explore the data files and become one with the data: understand what is available, what you can do with such data and what limitations there are.
2. Plan: Draft a high-level plan based on the results of the 'Explore' step.
3. Execute: Execute and operationalize the plan with code. If it turns out to be unsuccessful, start over from the 'Explore' step.
4. Conclude: Based on the output of your executed plan, distil all findings into an answer for the task.

Rules:
- ALWAYS check the data files for relevant documentation or data before assuming information is unavailable.
- ALWAYS validate your assumptions with the available documentation before executing.
- IF AND ONLY IF you have exhausted all possible solution plans you can come up with and still can not find a valid answer, then provide "Not Applicable" as the final answer.
- Use print() to retain important outputs, and never re-run code that you already know is not helping you solve the task.
- Solve the task yourself; don't just provide instructions.

When you are done, end your reply with the final answer wrapped in <final_answer></final_answer> tags, for example <final_answer>NL</final_answer>. Put only the answer inside the tags, formatted exactly as the task's guidelines require, with no explanation, units or extra words. If the guidelines say to reply with an empty string, reply with <final_answer></final_answer>.`;

// baseline reasoning_llm_task_prompt, without its closing "reward of $1,000,000" line
export function taskPrompt(task: Task): string {
  return `${task.question}\n\nYou must follow these guidelines when you produce your final answer:\n${task.guidelines}`;
}

const FORMAT_NUDGE =
  "Your reply did not include a final answer in <final_answer></final_answer> tags. Reply now with only the final answer inside the tags, formatted exactly as the task guidelines require.";
const STEP_LIMIT_NOTE =
  "Step limit reached for this task. Do not run any more code. Based on the work so far, reply with your best final answer inside <final_answer></final_answer> tags, formatted exactly as the task guidelines require.";

interface Task {
  task_id: string;
  question: string;
  guidelines: string;
  level: string;
  answer?: string;
}

interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

interface RequestLog {
  index: number;
  message_id: string;
  model: string;
  stop_reason: string | null;
  stop_details: unknown;
  ms: number;
  code_calls: number;
  server_iterations: number;
  tokens: Tokens;
  cost_usd: number;
  cost_usd_toplevel: number;
  fallback_blocks: unknown[];
  container_id: string | null;
}

type Status = "ok" | "no_answer" | "step_limit" | "refusal" | "error" | "budget_stop";

interface TaskResult {
  label: string;
  run: number;
  task_id: string;
  level: string;
  status: Status;
  agent_answer: string;
  answer_found: boolean;
  final_text: string;
  error?: string;
  nudges: string[];
  n_requests: number;
  code_calls: number;
  models_served: string[];
  tokens: Tokens;
  cost_usd: number;
  container_hours_est: number;
  container_usd_upper_bound: number;
  wall_s: number;
  started_at: string;
  finished_at: string;
  requests: RequestLog[];
}

// ---------------------------------------------------------------------------------------------

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const file = path.join(REPO, ".env.local");
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("ANTHROPIC_API_KEY=")) continue;
      const value = line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  throw new Error("ANTHROPIC_API_KEY is not set and not found in .env.local");
}

function emptyTokens(): Tokens {
  return { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
}

function addTokens(a: Tokens, b: Tokens): void {
  a.input += b.input;
  a.output += b.output;
  a.cache_read += b.cache_read;
  a.cache_write_5m += b.cache_write_5m;
  a.cache_write_1h += b.cache_write_1h;
}

function price(model: string | null | undefined) {
  return PRICES[model ?? MODEL] ?? PRICES[MODEL]!;
}

function tokensCost(t: Tokens, model: string | null | undefined): number {
  const p = price(model);
  return (
    (t.input * p.input + t.output * p.output + t.cache_read * p.cacheRead + t.cache_write_5m * p.input * 1.25 + t.cache_write_1h * p.input * 2) /
    1e6
  );
}

interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
}

function toTokens(u: UsageLike): Tokens {
  const created = u.cache_creation_input_tokens ?? 0;
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write_5m: Math.max(0, created - oneHour),
    cache_write_1h: oneHour,
  };
}

/** Cost of one response. Per-iteration pricing when the API reports iterations (covers fallbacks). */
function responseCost(msg: Message): { tokens: Tokens; usd: number; usdTop: number; iterations: number } {
  const top = toTokens(msg.usage);
  const usdTop = tokensCost(top, msg.model);
  const iters = (msg.usage.iterations ?? []).filter((e) => e.type === "message" || e.type === "fallback_message");
  if (!iters.length) return { tokens: top, usd: usdTop, usdTop, iterations: 0 };
  let usd = 0;
  const sum = emptyTokens();
  for (const e of iters) {
    const t = toTokens(e);
    addTokens(sum, t);
    usd += tokensCost(t, e.model ?? MODEL);
  }
  // Keep the larger of the two so budget accounting is conservative.
  return { tokens: top, usd: Math.max(usd, usdTop), usdTop, iterations: iters.length };
}

class Ledger {
  private spent = 0;
  constructor(private readonly file: string) {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.spent += Number(JSON.parse(line).cost_usd ?? 0);
      }
    }
  }
  add(entry: Record<string, unknown> & { cost_usd: number }): void {
    this.spent += entry.cost_usd;
    fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
  get total(): number {
    return this.spent;
  }
}

class BudgetExceeded extends Error {}

// ---------------------------------------------------------------------------------------------

interface UploadState {
  [name: string]: { id: string; sha256: string; bytes: number; created_at: string };
}

async function ensureUploads(client: Anthropic, contextDir: string): Promise<UploadState> {
  const stateFile = path.join(VAR_DIR, "files.json");
  const state: UploadState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  for (const [name, mime] of CONTEXT_FILES) {
    const buf = fs.readFileSync(path.join(contextDir, name));
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const prev = state[name];
    if (prev && prev.sha256 === sha256) {
      try {
        await client.files.retrieveMetadata(prev.id);
        continue;
      } catch (err) {
        if (!(err instanceof Anthropic.NotFoundError)) throw err;
      }
    }
    const meta = await client.files.upload({ file: await toFile(buf, name, { type: mime }) });
    state[name] = { id: meta.id, sha256, bytes: meta.size_bytes, created_at: meta.created_at };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
    console.log(`uploaded ${name} -> ${meta.id} (${meta.size_bytes} bytes, ${meta.mime_type})`);
  }
  return state;
}

function uploadBlocks(uploads: UploadState): Anthropic.Beta.BetaContainerUploadBlockParam[] {
  return CONTEXT_FILES.map(([name]) => ({ type: "container_upload" as const, file_id: uploads[name]!.id }));
}

// ---------------------------------------------------------------------------------------------

interface Config {
  label: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  maxRequests: number;
  taskCapUsd: number;
  budgetUsd: number;
  fallbacks: boolean;
  concurrency: number;
}

class Runner {
  private inflight = 0;
  private maxRequestCost = 0.75; // reserve per in-flight request until we observe real costs

  constructor(
    private readonly client: Anthropic,
    private readonly ledger: Ledger,
    private readonly cfg: Config,
  ) {}

  private headroomOk(): boolean {
    return this.ledger.total + this.inflight * this.maxRequestCost < this.cfg.budgetUsd;
  }

  /** One streamed request; retries transient failures that the SDK's own retries did not cover. */
  async request(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, tag: Record<string, unknown>): Promise<{ msg: Message; ms: number; cost: ReturnType<typeof responseCost> }> {
    for (let attempt = 0; ; attempt++) {
      if (!this.headroomOk()) throw new BudgetExceeded(`ledger $${this.ledger.total.toFixed(4)} + reserve would exceed budget $${this.cfg.budgetUsd}`);
      this.inflight++;
      const started = Date.now();
      try {
        const msg = await this.client.beta.messages.stream(params).finalMessage();
        const ms = Date.now() - started;
        const cost = responseCost(msg);
        this.maxRequestCost = Math.max(this.maxRequestCost, cost.usd);
        this.ledger.add({ ...tag, kind: "request", message_id: msg.id, model: msg.model, stop_reason: msg.stop_reason, ms, tokens: cost.tokens, cost_usd: cost.usd });
        return { msg, ms, cost };
      } catch (err) {
        const retryable =
          err instanceof Anthropic.APIConnectionError ||
          err instanceof Anthropic.RateLimitError ||
          err instanceof Anthropic.InternalServerError ||
          (err instanceof Anthropic.APIError && (err.status === undefined || err.status >= 500));
        if (!retryable || attempt >= 2) throw err;
        const wait = 20_000 * (attempt + 1);
        console.warn(`[${tag.task_id ?? "probe"}] transient error (${(err as Error).message.slice(0, 160)}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      } finally {
        this.inflight--;
      }
    }
  }

  baseParams(messages: MessageParam[], container: string | undefined, effort = this.cfg.effort): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    return {
      model: MODEL,
      max_tokens: this.cfg.maxTokens,
      ...(this.cfg.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      thinking: { type: "adaptive" as const, display: "summarized" as const },
      output_config: { effort },
      cache_control: { type: "ephemeral" as const },
      system: SYSTEM_PROMPT,
      tools: [{ type: "code_execution_20260521" as const, name: "code_execution" as const }],
      messages,
      ...(container ? { container } : {}),
    };
  }

  async runTask(task: Task, run: number, uploads: UploadState): Promise<{ result: TaskResult; transcript: MessageParam[] }> {
    const startedAt = new Date();
    const t0 = Date.now();
    const messages: MessageParam[] = [{ role: "user", content: [...uploadBlocks(uploads), { type: "text", text: taskPrompt(task) }] }];
    const requests: RequestLog[] = [];
    const tokens = emptyTokens();
    const nudges: string[] = [];
    const models = new Set<string>();
    let container: string | undefined;
    let cost = 0;
    let status: Status = "no_answer";
    let answer: string | null = null;
    let error: string | undefined;
    const tag = { label: this.cfg.label, run, task_id: task.task_id };

    try {
      for (;;) {
        const { msg, ms, cost: c } = await this.request(this.baseParams(messages, container), tag);
        container = msg.container?.id ?? container;
        cost += c.usd;
        addTokens(tokens, c.tokens);
        models.add(msg.model);
        requests.push({
          index: requests.length,
          message_id: msg.id,
          model: msg.model,
          stop_reason: msg.stop_reason,
          stop_details: msg.stop_details ?? null,
          ms,
          code_calls: msg.content.filter((b) => b.type === "server_tool_use").length,
          server_iterations: c.iterations,
          tokens: c.tokens,
          cost_usd: c.usd,
          cost_usd_toplevel: c.usdTop,
          fallback_blocks: msg.content.filter((b) => b.type === "fallback"),
          container_id: container ?? null,
        });
        messages.push({ role: "assistant", content: msg.content });
        answer = extractAnswer(messages) ?? answer;
        console.log(
          `[r${run} ${task.task_id}] req ${requests.length}: ${msg.stop_reason}, ${requests.at(-1)!.code_calls} tool calls, $${c.usd.toFixed(3)} (task $${cost.toFixed(3)}, total $${this.ledger.total.toFixed(3)})`,
        );

        if (msg.stop_reason === "refusal") {
          status = "refusal";
          break;
        }
        if (msg.stop_reason === "pause_turn") {
          const overCap = requests.length >= this.cfg.maxRequests || cost >= this.cfg.taskCapUsd;
          if (!overCap) continue; // resend as-is: the server resumes the paused turn
          if (nudges.includes("step_limit")) {
            status = "step_limit";
            break;
          }
          // A mid-conversation system message may follow an assistant turn ending in server tool use.
          messages.push({ role: "system", content: STEP_LIMIT_NOTE });
          nudges.push("step_limit");
          continue;
        }
        if (answer !== null) {
          status = "ok";
          break;
        }
        if (nudges.includes("format") || nudges.includes("step_limit")) {
          status = nudges.includes("step_limit") ? "step_limit" : "no_answer";
          break;
        }
        messages.push({ role: "user", content: FORMAT_NUDGE });
        nudges.push("format");
      }
    } catch (err) {
      status = err instanceof BudgetExceeded ? "budget_stop" : "error";
      error = (err as Error).message;
      console.warn(`[r${run} ${task.task_id}] ${status}: ${error.slice(0, 300)}`);
    }

    const wallMs = Date.now() - t0;
    const containerHours = container ? Math.max(CONTAINER_MIN_HOURS, wallMs / 3_600_000) : 0;
    const containerUsd = containerHours * CONTAINER_USD_PER_HOUR;
    if (containerUsd > 0) this.ledger.add({ ...tag, kind: "container_upper_bound", hours: containerHours, cost_usd: containerUsd });

    const result: TaskResult = {
      label: this.cfg.label,
      run,
      task_id: task.task_id,
      level: task.level,
      status,
      agent_answer: answer ?? "",
      answer_found: answer !== null,
      final_text: lastAssistantText(messages),
      ...(error ? { error } : {}),
      nudges,
      n_requests: requests.length,
      code_calls: requests.reduce((s, r) => s + r.code_calls, 0),
      models_served: [...models],
      tokens,
      cost_usd: cost,
      container_hours_est: containerHours,
      container_usd_upper_bound: containerUsd,
      wall_s: wallMs / 1000,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      requests,
    };
    return { result, transcript: messages };
  }
}

function assistantTexts(messages: MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "text") out.push(b.text);
  }
  return out;
}

function extractAnswer(messages: MessageParam[]): string | null {
  const matches = [...assistantTexts(messages).join("\n").matchAll(/<final_answer>([\s\S]*?)<\/final_answer>/g)];
  const last = matches.at(-1);
  return last ? last[1]!.trim() : null;
}

function lastAssistantText(messages: MessageParam[]): string {
  return assistantTexts(messages).at(-1) ?? "";
}

// ---------------------------------------------------------------------------------------------

async function probe(client: Anthropic, ledger: Ledger, runner: Runner, uploads: UploadState): Promise<void> {
  const cmd = "pwd; echo INPUT_DIR=$INPUT_DIR OUTPUT_DIR=$OUTPUT_DIR; ls -la $INPUT_DIR; find / -name 'payments*' -not -path '/proc/*' 2>/dev/null | head -20";
  const messages: MessageParam[] = [
    {
      role: "user",
      content: [...uploadBlocks(uploads), { type: "text", text: `Run exactly this one bash command and nothing else, then reply "done":\n${cmd}` }],
    },
  ];
  const { msg, cost } = await runner.request(runner.baseParams(messages, undefined, "low"), { label: "probe", kind: "probe" });
  for (const b of msg.content) {
    if (b.type === "server_tool_use") console.log("TOOL CALL:", JSON.stringify(b.input));
    if (b.type === "bash_code_execution_tool_result") console.log("RESULT:", JSON.stringify(b.content, null, 2));
    if (b.type === "text") console.log("TEXT:", b.text);
  }
  console.log(`probe: stop=${msg.stop_reason} model=${msg.model} container=${msg.container?.id} cost=$${cost.usd.toFixed(4)} usage=${JSON.stringify(msg.usage)}`);
  console.log(`ledger total $${ledger.total.toFixed(4)}`);
}

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      "data-dir": { type: "string", default: process.env.DABSTEP_DATA_DIR ?? path.resolve(REPO, "../benchdata/dabstep") },
      split: { type: "string", default: "dev" },
      label: { type: "string", default: "dev" },
      runs: { type: "string", default: "1" },
      "task-ids": { type: "string" },
      concurrency: { type: "string", default: "5" },
      effort: { type: "string", default: "high" },
      "budget-usd": { type: "string", default: "15" },
      "task-cap-usd": { type: "string", default: "1.5" },
      "max-requests": { type: "string", default: "8" },
      "max-tokens": { type: "string", default: "64000" },
      "no-fallbacks": { type: "boolean", default: false },
      probe: { type: "boolean", default: false },
    },
  });

  const cfg: Config = {
    label: a.label!,
    effort: a.effort as Config["effort"],
    maxTokens: Number(a["max-tokens"]),
    maxRequests: Number(a["max-requests"]),
    taskCapUsd: Number(a["task-cap-usd"]),
    budgetUsd: Number(a["budget-usd"]),
    fallbacks: !a["no-fallbacks"],
    concurrency: Number(a.concurrency),
  };
  const dataDir = path.resolve(a["data-dir"]!);
  fs.mkdirSync(VAR_DIR, { recursive: true });

  const client = new Anthropic({ apiKey: loadApiKey(), maxRetries: 4, timeout: 30 * 60 * 1000 });
  const ledger = new Ledger(path.join(VAR_DIR, "ledger.jsonl"));
  console.log(`ledger so far: $${ledger.total.toFixed(4)} of $${cfg.budgetUsd} budget`);
  const runner = new Runner(client, ledger, cfg);
  const uploads = await ensureUploads(client, path.join(dataDir, "context"));

  if (a.probe) return probe(client, ledger, runner, uploads);

  const tasksFile = path.join(dataDir, `${a.split}.jsonl`);
  let tasks: Task[] = fs
    .readFileSync(tasksFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const t = JSON.parse(l);
      return { task_id: String(t.task_id), question: t.question, guidelines: t.guidelines, level: String(t.level) };
    });
  if (a["task-ids"]) {
    const want = new Set(a["task-ids"].split(",").map((s) => s.trim()));
    tasks = tasks.filter((t) => want.has(t.task_id));
  }

  const outDir = path.join(VAR_DIR, "runs", cfg.label);
  fs.mkdirSync(path.join(outDir, "transcripts"), { recursive: true });
  const resultsFile = path.join(outDir, "results.jsonl");
  const done = new Set<string>();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as TaskResult;
      if (r.status !== "error" && r.status !== "budget_stop") done.add(`${r.run}:${r.task_id}`);
    }
  }
  const sdkVersion = JSON.parse(fs.readFileSync(path.join(REPO, "node_modules/@anthropic-ai/sdk/package.json"), "utf8")).version;
  fs.writeFileSync(
    path.join(outDir, "config.json"),
    JSON.stringify(
      {
        model: MODEL,
        ...cfg,
        betas: cfg.fallbacks ? [FALLBACK_BETA] : [],
        fallbacks: cfg.fallbacks ? "default" : null,
        thinking: { type: "adaptive", display: "summarized" },
        tool: "code_execution_20260521",
        prompt_caching: "top-level cache_control ephemeral (automatic)",
        system_prompt: SYSTEM_PROMPT,
        task_prompt_template: taskPrompt({ task_id: "", level: "", question: "{question}", guidelines: "{guidelines}" }),
        format_nudge: FORMAT_NUDGE,
        step_limit_note: STEP_LIMIT_NOTE,
        uploads,
        tasks_file: tasksFile,
        tasks_sha256: crypto.createHash("sha256").update(fs.readFileSync(tasksFile)).digest("hex"),
        sdk: `@anthropic-ai/sdk ${sdkVersion}`,
        git_head: gitHead(),
        written_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  const jobs: Array<{ task: Task; run: number }> = [];
  for (let run = 1; run <= Number(a.runs); run++) for (const task of tasks) if (!done.has(`${run}:${task.task_id}`)) jobs.push({ task, run });
  console.log(`${jobs.length} task-runs to do (${done.size} already done) with concurrency ${cfg.concurrency}`);

  const t0 = Date.now();
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop && next < jobs.length) {
      const job = jobs[next++]!;
      const { result, transcript } = await runner.runTask(job.task, job.run, uploads);
      fs.appendFileSync(resultsFile, JSON.stringify(result) + "\n");
      fs.writeFileSync(path.join(outDir, "transcripts", `${job.task.task_id}-r${job.run}.json`), JSON.stringify(transcript, null, 1));
      console.log(
        `[r${job.run} ${job.task.task_id}] ${result.status} answer=${JSON.stringify(result.agent_answer).slice(0, 120)} $${result.cost_usd.toFixed(3)} ${result.wall_s.toFixed(0)}s`,
      );
      if (result.status === "budget_stop") stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
  console.log(`finished in ${((Date.now() - t0) / 1000).toFixed(0)}s; ledger total $${ledger.total.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
