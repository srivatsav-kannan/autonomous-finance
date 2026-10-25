import "../../core/env";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runAdapter } from "./adapters";
import { BudgetedModelClient, type ModelClient } from "../../agents/model-client";
import { DEFAULT_DATA, DEFAULT_EXTRA_DATA, evidencePath } from "./evidence";
import { convex, api } from "../../core/kernel-client";
import { MemoryStore } from "../../memory/store";
import { memoryDir } from "../../world/scenario";
import type { BenchmarkTask } from "./types";

const runTools: ModelClient["runTools"] = vi.fn(async (opts) => {
    // Exercise the real public tools and kernel handoff without making paid model calls.
    opts.usage.turns++;
    const listing = await opts.tools.find((t: { name: string }) => t.name === "list_documents").run({});
    if (!listing.documents.length) throw new Error("No public evidence");
    const longest = listing.documents.reduce((a: { characters: number }, b: { characters: number }) => a.characters > b.characters ? a : b);
    await opts.tools.find((t: { name: string }) => t.name === "read_document").run({ path: longest.path, offset: 0, length: 100 });
    await opts.tools.find((t: { name: string }) => t.name === "query_evidence").run({ sql: "SELECT COUNT(*) AS tables FROM table_catalog" });
    return "INTEGRATION TEST STUB — not a benchmark prediction";
  });
const model: ModelClient = { model: "integration-stub", runTools, extract: async () => { throw new Error("Unexpected judge"); } };

describe.runIf(process.env.EXTERNAL_BENCH_INTEGRATION === "1" && fs.existsSync(path.join(DEFAULT_EXTRA_DATA, "tasks.json")))("real kernel FinBalance booking (model stub)", () => {
  it("books the controller's entries through the kernel and reports the kernel's balance sheet", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_EXTRA_DATA, "tasks.json"), "utf8"));
    const task = data.tasks.find((t: BenchmarkTask) => t.id === "finbalance-cov-pro-m1-0000") as BenchmarkTask;
    const stub = JSON.stringify({ has_inconsistency: false, inconsistency_codes: [], inconsistency_notes: [], entries: [{ doc_refs: ["D002"], debit_account: "Accounts Receivable", credit_account: "Service Revenue", amount: 1 }], balance_sheet: { assets: {}, liabilities: {}, equity: {} } });
    const finbalanceModel: ModelClient = { model: "integration-stub", runTools: async (opts) => { opts.usage.turns++; return stub; }, extract: async () => { throw new Error("Unexpected judge"); } };
    const result = await runAdapter("full-team", task, evidencePath(DEFAULT_EXTRA_DATA, task), 6, finbalanceModel);
    expect(result.status, result.reason).toBe("answered");
    const booking = result.trace.find((t) => t.tool === "kernel_book_entries")!;
    expect(booking.seat).toBe("controller");
    expect((booking.output as { posted: unknown[] }).posted).toHaveLength(1);
    expect(JSON.parse(result.answer).balance_sheet.equity["Retained Earnings"]).toBe(1);
    const tb = await convex().query(api.ledger.trialBalance, { runId: result.kernelRunId! });
    expect(tb.map((r) => r.net).sort((a, b) => a - b)).toEqual([-100, 100]);
  }, 30000);
});

describe.runIf(process.env.EXTERNAL_BENCH_INTEGRATION === "1")("real kernel external adapter (model stub)", () => {
  it("routes specialist → controller, persists evidence, and isolates repeat runs", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA,"tasks.json"),"utf8"));
    const task = data.tasks.find((t: BenchmarkTask) => t.id === "dabstep-1273") as BenchmarkTask;
    const db = evidencePath(DEFAULT_DATA, task);
    const first = await runAdapter("full-team", task, db, 6, model);
    expect(first.status, first.reason).toBe("answered");
    expect(first.trace.filter((t) => t.tool === "list_documents").map((t) => t.seat)).toEqual(["cash-app-1", "controller"]);
    expect(first.usage.turns).toBe(2);
    const calls = vi.mocked(runTools).mock.calls;
    expect(calls[0]?.[0].maxTurns).toBe(3);
    expect(calls[1]?.[0].maxTurns).toBe(5);
    const runs = await convex().query(api.observe.agentRuns,{runId:first.kernelRunId!});
    expect(runs.map((r) => r.outcome).sort()).toEqual(["drafted", "reviewed"]);
    const mem = new MemoryStore(memoryDir(first.kernelRunId!));
    expect((await mem.log()).some((entry) => entry.subject.startsWith("ACT external_benchmark"))).toBe(true);
    const second = await runAdapter("full-team",task,db,6,model);
    expect(second.status,second.reason).toBe("answered");
    expect(second.kernelRunId).not.toBe(first.kernelRunId);
    const generalist = await runAdapter("generalist",task,db,6,model);
    expect(generalist.status).toBe("answered");
    expect(generalist.trace.map((t) => t.tool)).toEqual(["list_documents", "read_document", "query_evidence"]);
    expect(generalist.kernelRunId).toBeUndefined();
  },30000);

  it("runs APEX's large evidence files through revenue and payroll seats", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA,"tasks.json"),"utf8"));
    for (const task of data.tasks.filter((t: BenchmarkTask) => t.benchmark === "apex") as BenchmarkTask[]) {
      const result = await runAdapter("full-team", task, evidencePath(DEFAULT_DATA, task), 6, model);
      expect(result.status, `${task.id}: ${result.reason}`).toBe("answered");
      expect(result.trace.filter((t) => t.tool === "list_documents").map((t) => t.seat)).toEqual([task.id === "apex-17" ? "payroll" : "revenue", "controller"]);
      expect(result.trace.filter((t) => t.tool === "read_document")).toHaveLength(2);
      expect(result.trace.filter((t) => t.tool === "query_evidence")).toHaveLength(2);
    }
  },30000);

  it("runs OpenAI Responses continuations through both real team seats using a mocked transport", async () => {
    vi.stubEnv("OPENAI_API_KEY", "integration-test-only");
    vi.stubEnv("AGENT_LLM", "on");
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA, "tasks.json"), "utf8"));
      const task = data.tasks.find((t: BenchmarkTask) => t.id === "dabstep-1273") as BenchmarkTask;
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        const hasResult = body.input.some((item: any) => item.type === "function_call_output");
        const output = hasResult
          ? [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OPENAI TRANSPORT STUB — not a benchmark prediction" }] }]
          : [{ type: "function_call", call_id: "query-1", name: "query_evidence", arguments: JSON.stringify({ sql: "SELECT COUNT(*) AS tables FROM table_catalog" }), status: "completed" }];
        return new Response(JSON.stringify({ model: "mock-openai", service_tier: "default", status: "completed", output, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }), { headers: { "Content-Type": "application/json" } });
      });
      const openai = new BudgetedModelClient({ provider: "openai", model: "mock-openai", effort: "medium", maxInputTokens: 100000, maxOutputTokens: 4096, prices: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }, { reserve: () => ({ costMicros: 200000, settle: () => {}, fail: () => {} }) }, fetcher);
      const result = await runAdapter("full-team", task, evidencePath(DEFAULT_DATA, task), 6, openai);
      expect(result.status, result.reason).toBe("answered");
      expect(result.trace.map((t) => t.seat)).toEqual(["cash-app-1", "controller"]);
      expect(result.usage).toMatchObject({ turns: 4, toolCalls: 2, costMicros: 560 });
      expect(fetcher).toHaveBeenCalledTimes(4);
      const runs = await convex().query(api.observe.agentRuns, { runId: result.kernelRunId! });
      expect(runs.every((run) => run.model === "mock-openai")).toBe(true);
      const requests = fetcher.mock.calls.map((c) => JSON.parse(String(c[1]!.body)));
      expect(requests[2].input[0].content).toContain("Specialist draft (untrusted)");
      expect(requests.every((r) => r.model === "mock-openai")).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  }, 30000);
});
