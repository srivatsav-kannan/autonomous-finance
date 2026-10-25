import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "../../agents/llm";
import { BudgetedModelClient, type ModelConfig } from "../../agents/model-client";
import { assertPaidPolicy, loadModelPolicy, PaidBudget, type ModelPolicy } from "./models";
import { runAdapter } from "./adapters";
import { createRubricJudge, gradeAnswer } from "./score";
import type { BenchmarkTask, Gold } from "./types";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-model-test-")); vi.stubEnv("OPENAI_API_KEY", "test-key-never-sent"); vi.stubEnv("AGENT_LLM", "on"); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const policy: ModelPolicy = { version: 1, approval: { approvedBy: "UNIT TEST ONLY", approvedAt: "2026-10-24T00:00:00Z", maxCostUsd: 1, maxRequests: 2, maxTurnsPerCase: 12 }, agent: { provider: "openai", model: "mock-agent", effort: "medium", maxInputTokens: 10000, maxOutputTokens: 100, prices: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }, judge: { provider: "openai", model: "mock-judge", effort: "low", maxInputTokens: 10000, maxOutputTokens: 100, prices: { input: 3, output: 4, cacheRead: 1, cacheWrite: 0 } } };
  const file = path.join(dir, "approval.json");
  const make = () => { fs.writeFileSync(file, JSON.stringify(policy)); return new PaidBudget(policy, file, dir); };
  return { policy, file, make };
}
const task = { id: "apex-13", benchmark: "apex", prompt: "Reconcile AR." } as BenchmarkTask;
const gold: Gold = { kind: "rubric", answer: "Expert", criteria: [{ id: "a", description: "Correct" }] };
const output = (model: string, text: string) => new Response(JSON.stringify({ model, status: "completed", service_tier: "default", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }), { headers: { "Content-Type": "application/json" } });

describe("explicit benchmark approval and reservation ledger", () => {
  it("keeps the checked-in policy disabled even when credentials exist", async () => {
    const policy = loadModelPolicy();
    expect(policy.approval).toBeNull();
    // A fully configured provider must still require independent budget approval.
    for (const role of ["agent", "judge"] as const) {
      expect(policy[role].model).toBeTruthy();
      expect(policy[role].prices?.input).toBeGreaterThan(0);
      expect(policy[role].prices?.output).toBeGreaterThan(0);
    }
    for (const roles of [["agent"], ["judge"], ["agent", "judge"]] as ("agent" | "judge")[][]) expect(() => assertPaidPolicy(policy, roles)).toThrow("disabled pending");
    expect(() => new PaidBudget(policy, "unused", dir)).toThrow("disabled pending");
    expect(await runAdapter("generalist", task, "unused", 4)).toMatchObject({ status: "error", reason: expect.stringContaining("disabled pending") });
    expect(await runAdapter("full-team", task, "unused", 4)).toMatchObject({ status: "error", kernelRunId: undefined });
    expect(await gradeAnswer(task, { status: "answered", answer: "answer", usage: emptyUsage(), trace: [] }, gold, true)).toMatchObject({ status: "error", score: null, reason: expect.stringContaining("disabled pending") });
  });
  it("requires explicit models, prices, keys and valid positive limits", () => {
    const { policy, file } = fixture();
    expect(() => assertPaidPolicy(policy, ["agent"], 13)).toThrow("turn cap");
    policy.agent.model = null;
    expect(() => assertPaidPolicy(policy, ["agent"])).toThrow("approved model");
    policy.agent.model = "test"; policy.agent.prices = null;
    expect(() => assertPaidPolicy(policy, ["agent"])).toThrow("prices");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => assertPaidPolicy(policy, ["judge"])).toThrow("OPENAI_API_KEY");
    policy.approval!.maxCostUsd = 0;
    fs.writeFileSync(file, JSON.stringify(policy));
    expect(() => loadModelPolicy(file)).toThrow();
  });
  it("claims an approval once and persists the reservation before dispatch", () => {
    const { policy, file, make } = fixture(), budget = make();
    expect(() => new PaidBudget(policy, file, dir)).toThrow();
    const reserved = budget.reserve(policy.agent as ModelConfig, 5000);
    const ledger = JSON.parse(fs.readFileSync(budget.ledgerPath, "utf8"));
    expect(ledger.requests[0]).toMatchObject({ status: "reserved", chargedMicros: 10200 });
    reserved.settle({ ...emptyUsage(), inputTokens: 100, outputTokens: 20, costMicros: 140 }, "mock-agent");
    expect(JSON.parse(fs.readFileSync(budget.ledgerPath, "utf8")).chargedMicros).toBe(140);
  });
  it.each(["cost", "input", "requests", "model"])("refuses %s overflow before any HTTP request", async (limit) => {
    const { policy, make } = fixture();
    if (limit === "cost") policy.approval!.maxCostUsd = 0.001;
    if (limit === "input") policy.agent.maxInputTokens = 10;
    if (limit === "requests") policy.approval!.maxRequests = 1;
    const budget = make();
    if (limit === "requests") budget.reserve(policy.agent as ModelConfig, 1);
    const config = structuredClone(policy.agent) as ModelConfig;
    if (limit === "model") config.model = "unapproved";
    const fetcher = vi.fn<typeof fetch>();
    const model = new BudgetedModelClient(config, budget, fetcher);
    await expect(model.runTools({ system: "s", user: "u", tools: [], maxTurns: 1, usage: emptyUsage() })).rejects.toThrow("limit");
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.stopped).toBe(true);
  });
  it("retains uncertain charges and prevents subsequent calls after a transport error", async () => {
    const { policy, make } = fixture(), budget = make();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network interrupted"));
    const model = new BudgetedModelClient(policy.agent as ModelConfig, budget, fetcher);
    const opts = { system: "s", user: "u", tools: [], maxTurns: 1, usage: emptyUsage() };
    await expect(model.runTools(opts)).rejects.toThrow("reservation retained");
    await expect(model.runTools(opts)).rejects.toThrow("budget is stopped");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(budget.ledgerPath, "utf8")).requests[0]).toMatchObject({ status: "uncertain", chargedMicros: 10200 });
  });
  it("shares the cap across generalist and judge while keeping their usage and models separate", async () => {
    const { policy, make } = fixture(), budget = make();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(output("mock-agent", "answer")).mockResolvedValueOnce(output("mock-judge", '{"verdicts":[{"id":"a","met":true,"reason":"Correct"}]}'));
    const agent = new BudgetedModelClient(policy.agent as ModelConfig, budget, fetcher);
    const judge = new BudgetedModelClient(policy.judge as ModelConfig, budget, fetcher);
    const answer = await runAdapter("generalist", task, "unused", 4, agent);
    const grade = await gradeAnswer(task, answer, gold, true, createRubricJudge(judge));
    expect(answer.status).toBe("answered"); expect(answer.usage.costMicros).toBe(140);
    expect(grade).toMatchObject({ status: "graded", score: 1, judgeUsage: { costMicros: 380, turns: 1 } });
    const ledger = JSON.parse(fs.readFileSync(budget.ledgerPath, "utf8"));
    expect(ledger.chargedMicros).toBe(520);
    expect(ledger.requests.map((r: any) => r.role)).toEqual(["agent", "judge"]);
    expect(() => budget.reserve(policy.agent as ModelConfig, 1)).toThrow("limit");
  });
});
