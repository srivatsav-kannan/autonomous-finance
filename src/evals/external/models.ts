import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetedModelClient, modelCredentialsAvailable, type ModelConfig, type RequestBudget } from "../../agents/model-client";
import type { Usage } from "../../agents/llm";

export const DEFAULT_MODEL_POLICY = "benchmarks/external-models.json";
export const PAID_DISABLED = "Paid benchmark runs are disabled pending explicit model and budget approval (#67). Use --modes rules-only --judge off or --dry-run.";
const positive = z.number().finite().positive();
const modelSchema = z.object({
  provider: z.enum(["openai", "anthropic"]), model: z.string().trim().min(1).nullable(),
  effort: z.enum(["low", "medium", "high"]),
  maxInputTokens: z.number().int().min(1).max(100_000), maxOutputTokens: z.number().int().min(1).max(16_000),
  prices: z.object({ input: positive, output: positive, cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative() }).strict().nullable(),
}).strict();
const policySchema = z.object({
  version: z.literal(1),
  approval: z.object({ approvedBy: z.string().trim().min(1), approvedAt: z.iso.datetime(), maxCostUsd: positive, maxRequests: z.number().int().positive().max(100_000), maxTurnsPerCase: z.number().int().min(4).max(100) }).strict().nullable(),
  agent: modelSchema, judge: modelSchema,
}).strict();
export type ModelPolicy = z.infer<typeof policySchema>;
export function loadModelPolicy(file = DEFAULT_MODEL_POLICY): ModelPolicy {
  return policySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
export function assertPaidPolicy(policy: ModelPolicy, roles: ("agent" | "judge")[], maxTurns?: number): void {
  if (!policy.approval) throw new Error(PAID_DISABLED);
  if (!Number.isSafeInteger(Math.floor(policy.approval.maxCostUsd * 1e6))) throw new Error("Budget exceeds safe currency bounds");
  if (roles.includes("agent") && maxTurns !== undefined && maxTurns > policy.approval.maxTurnsPerCase) throw new Error("Requested turn cap exceeds the approved maxTurnsPerCase");
  for (const role of roles) {
    const config = policy[role];
    if (!config.model || !config.prices) throw new Error(`${role} needs an explicitly approved model and USD-per-million token prices`);
    if (config.prices.cacheRead > config.prices.input || (config.provider === "anthropic" && config.prices.cacheWrite <= 0)) throw new Error("Cache prices must fit the approved input bound (Anthropic cache writes require a positive rate)");
    if (!modelCredentialsAvailable(config.provider)) throw new Error(`${role}: configure ${config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} privately; AGENT_LLM=off also disables inference`);
  }
}

type BudgetEntry = { role: string; model: string; provider: string; reservedMicros: number; chargedMicros: number; status: string; servedModel?: string; usage?: Usage };

/** One invocation per approval file; claims and reservations survive crashes. */
export class PaidBudget implements RequestBudget {
  readonly #policy: ModelPolicy;
  readonly #file: string;
  readonly #entries: BudgetEntry[] = [];
  #status: "active" | "stopped" | "complete" = "active";
  constructor(policy: ModelPolicy, policyFile: string, runDirectory: string) {
    if (!policy.approval) throw new Error(PAID_DISABLED);
    this.#policy = structuredClone(policy);
    // A shared sidecar prevents two processes from spending the same approval.
    // A new, separately approved file is required for another run or rescore.
    this.#file = fs.realpathSync(policyFile) + ".usage.json";
    fs.writeFileSync(this.#file, JSON.stringify({ status: "claimed", runDirectory: path.resolve(runDirectory), policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), policy }), { flag: "wx", mode: 0o600 });
    this.#save();
  }
  get stopped(): boolean { return this.#status !== "active"; }
  get ledgerPath(): string { return this.#file; }
  stop() { this.#status = "stopped"; this.#save(); }
  complete() { this.#status = "complete"; this.#save(); }
  #save() {
    const original = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    fs.writeFileSync(this.#file + ".tmp", JSON.stringify({ ...original, status: this.#status, requests: this.#entries, chargedMicros: this.#entries.reduce((s, e) => s + e.chargedMicros, 0) }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(this.#file + ".tmp", this.#file);
  }
  reserve(config: ModelConfig, inputBound: number) {
    if (this.stopped) throw new Error("Paid budget is stopped; no further requests permitted");
    const role = (["agent", "judge"] as const).find((role) => JSON.stringify(this.#policy[role]) === JSON.stringify(config));
    const price = config.prices;
    const reservedMicros = Math.ceil(config.maxInputTokens * Math.max(price.input, price.cacheRead, price.cacheWrite) + config.maxOutputTokens * price.output);
    const used = this.#entries.reduce((s, e) => s + e.chargedMicros, 0);
    if (!role || !Number.isSafeInteger(inputBound) || inputBound > config.maxInputTokens || !Number.isSafeInteger(reservedMicros) || this.#entries.length >= this.#policy.approval!.maxRequests || used + reservedMicros > Math.floor(this.#policy.approval!.maxCostUsd * 1e6)) {
      this.stop();
      throw new Error("Paid budget/input/request limit reached before dispatch; execution stopped");
    }
    const entry = { role, model: config.model, provider: config.provider, reservedMicros, chargedMicros: reservedMicros, status: "reserved" } as BudgetEntry;
    this.#entries.push(entry); this.#save();
    let settled = false;
    return {
      costMicros: reservedMicros,
      settle: (usage: Usage, servedModel: string) => {
        if (settled) throw new Error("Request already settled");
        if (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > config.maxInputTokens || usage.outputTokens > config.maxOutputTokens || usage.costMicros > reservedMicros) throw new Error("Provider usage exceeded approved reservation");
        entry.chargedMicros = usage.costMicros; entry.usage = usage; entry.servedModel = servedModel; entry.status = "verified";
        this.#save(); settled = true;
      },
      fail: () => { if (!settled) entry.status = "uncertain"; this.stop(); },
    };
  }
}

export function createModels(policy: ModelPolicy, budget: PaidBudget, roles: ("agent" | "judge")[]) {
  assertPaidPolicy(policy, roles);
  return Object.fromEntries(roles.map((role) => [role, new BudgetedModelClient(policy[role] as ModelConfig, budget)])) as Partial<Record<"agent" | "judge", BudgetedModelClient>>;
}
