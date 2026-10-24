import "../../core/env";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../agents/llm", async (original) => {
  const actual = await original<typeof import("../../agents/llm")>();
  return { ...actual, llmAvailable: () => true, runTools: vi.fn(async (opts) => {
    // Exercise the real public tools and kernel handoff without making paid model calls.
    opts.usage.turns++;
    const listing = await opts.tools.find((t: { name: string }) => t.name === "list_documents").run({});
    if (!listing.documents.length) throw new Error("No public evidence");
    const longest = listing.documents.reduce((a: { characters: number }, b: { characters: number }) => a.characters > b.characters ? a : b);
    await opts.tools.find((t: { name: string }) => t.name === "read_document").run({ path: longest.path, offset: 0, length: 100 });
    await opts.tools.find((t: { name: string }) => t.name === "query_evidence").run({ sql: "SELECT COUNT(*) AS tables FROM table_catalog" });
    return "INTEGRATION TEST STUB — not a benchmark prediction";
  }) };
});
import { runAdapter } from "./adapters";
import { runTools } from "../../agents/llm";
import { DEFAULT_DATA, evidencePath } from "./evidence";
import { convex, api } from "../../core/kernel-client";
import { MemoryStore } from "../../memory/store";
import { memoryDir } from "../../world/scenario";
import type { BenchmarkTask } from "./types";

describe.runIf(process.env.EXTERNAL_BENCH_INTEGRATION === "1")("real kernel external adapter (model stub)", () => {
  it("routes specialist → controller, persists evidence, and isolates repeat runs", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA,"tasks.json"),"utf8"));
    const task = data.tasks.find((t: BenchmarkTask) => t.id === "dabstep-1273") as BenchmarkTask;
    const db = evidencePath(DEFAULT_DATA, task);
    const first = await runAdapter("full-team", task, db, 6);
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
    const second = await runAdapter("full-team",task,db,6);
    expect(second.status,second.reason).toBe("answered");
    expect(second.kernelRunId).not.toBe(first.kernelRunId);
    const generalist = await runAdapter("generalist",task,db,6);
    expect(generalist.status).toBe("answered");
    expect(generalist.trace.map((t) => t.tool)).toEqual(["list_documents", "read_document", "query_evidence"]);
    expect(generalist.kernelRunId).toBeUndefined();
  },30000);

  it("runs APEX's large evidence files through revenue and payroll seats", async () => {
    const data = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA,"tasks.json"),"utf8"));
    for (const task of data.tasks.filter((t: BenchmarkTask) => t.benchmark === "apex") as BenchmarkTask[]) {
      const result = await runAdapter("full-team", task, evidencePath(DEFAULT_DATA, task), 6);
      expect(result.status, `${task.id}: ${result.reason}`).toBe("answered");
      expect(result.trace.filter((t) => t.tool === "list_documents").map((t) => t.seat)).toEqual([task.id === "apex-17" ? "payroll" : "revenue", "controller"]);
      expect(result.trace.filter((t) => t.tool === "read_document")).toHaveLength(2);
      expect(result.trace.filter((t) => t.tool === "query_evidence")).toHaveLength(2);
    }
  },30000);
});
