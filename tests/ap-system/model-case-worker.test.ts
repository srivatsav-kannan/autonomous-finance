import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, refs } from "./accounting-fixture";
import { APCaseAgentWorker } from "../../src/agents/ap-case-worker";
import {
  createAPModelStep,
  persistentAPBudget,
} from "../../src/agents/ap-case-model";
import type { ModelClient, ModelConfig } from "../../src/agents/model-client";
import { emptyUsage } from "../../src/agents/llm";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import { makeFunctionReference } from "convex/server";
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  directories
    .splice(0)
    .forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
function directory() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ap-model-test-"));
  fs.chmodSync(d, 0o700);
  directories.push(d);
  return d;
}
const config = (d: string) => ({
  provider: "openai" as const,
  model: "explicit-test-model",
  effort: "low" as const,
  maxInputTokens: 10000,
  maxOutputTokens: 512,
  prices: { input: 2, output: 10, cacheRead: 1, cacheWrite: 3 },
  maxSpendMicros: 100_000,
  directory: d,
});
function fakeModel(run: ModelClient["runTools"]): ModelClient {
  return {
    model: "explicit-test-model",
    runTools: run,
    extract: async () => {
      throw Error("No extraction");
    },
  };
}
it("uses model-selected typed inspect/advance tools with the real backend and persists a credential-free trace", async () => {
  const f = await fixture(),
    d = await f.reviewed(),
    dir = directory(),
    seen: string[] = [];
  const model = fakeModel(async (opts) => {
    seen.push(...opts.tools.map((t) => t.name));
    await opts.tools.find((t) => t.name === "inspect_case")!.run({});
    await opts.tools.find((t) => t.name === "advance_case")!.run({});
    return "Waiting for independent business approval.";
  });
  const client = f.t as unknown as KernelTransport,
    step = createAPModelStep({
      client,
      scope: f.scope,
      config: config(dir),
      model,
    });
  const worker = new APCaseAgentWorker(
    client,
    f.scope,
    [{ seatId: "ap_clerk", token: "token-ap_clerk" }],
    step,
  );
  const result = await worker.tick();
  expect(result[0]).toMatchObject({ caseId: d.caseId, mode: "model" });
  expect(seen).toEqual(["inspect_case", "advance_case", "escalate_case"]);
  expect(
    await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
  ).toHaveLength(0);
  expect(
    await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
  ).toHaveLength(0);
  const file = path.join(
      dir,
      fs.readdirSync(dir).find((n) => n.endsWith(".jsonl"))!,
    ),
    trace = fs.readFileSync(file, "utf8");
  expect(trace).toContain('"tool_requested"');
  expect(trace).toContain('"tool_result"');
  expect(trace).toContain('"completed"');
  expect(trace).not.toContain("token-ap_clerk");
  expect(trace).not.toContain("tokenHash");
  expect(fs.statSync(file).mode & 0o077).toBe(0);
});
it("escalates an incomplete model turn without granting financial authority", async () => {
  const f = await fixture();
  await f.reviewed();
  const client = f.t as unknown as KernelTransport;
  const worker = new APCaseAgentWorker(
    client,
    f.scope,
    [{ seatId: "ap_clerk", token: "token-ap_clerk" }],
    createAPModelStep({
      client,
      scope: f.scope,
      config: config(directory()),
      model: fakeModel(async () => "I paid it."),
    }),
  );
  expect(await worker.tick()).toMatchObject([{ status: "escalated" }]);
  expect(
    await f.t.run((ctx) => ctx.db.query("demoVersions").collect()),
  ).toHaveLength(0);
});
it("prevents advance before inspection and any second terminal effect", async () => {
  const f = await fixture();
  await f.reviewed();
  const client = f.t as unknown as KernelTransport;
  const model = fakeModel(async (o) => {
    const inspect = o.tools[0]!,
      advance = o.tools[1]!;
    await expect(advance.run({})).rejects.toThrow(/Inspect/);
    await inspect.run({});
    await advance.run({});
    await expect(advance.run({})).rejects.toThrow(/budget/);
    return "Waiting";
  });
  await new APCaseAgentWorker(
    client,
    f.scope,
    [{ seatId: "ap_clerk", token: "token-ap_clerk" }],
    createAPModelStep({
      client,
      scope: f.scope,
      config: config(directory()),
      model,
    }),
  ).tick();
  expect(
    await f.t.run((ctx) => ctx.db.query("demoVersions").collect()),
  ).toHaveLength(0);
});
it("cannot renew someone else's or an expired generation, and caps inference ownership at five minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const f = await fixture();
  await f.reviewed();
  const claim = makeFunctionReference<"mutation">("apCaseAgent:claim"),
    renew = makeFunctionReference<"mutation">("apCaseAgent:renew");
  const l = await f.t.mutation(claim, { ...f.ap, requestId: "model-lease" }),
    args = { ...f.ap, caseId: l.caseId, generation: l.generation };
  await expect(
    f.t.mutation(renew, {
      ...args,
      seatId: "payments",
      token: "token-payments",
    }),
  ).rejects.toThrow(/Stale/);
  for (let i = 0; i < 29; i++) {
    vi.advanceTimersByTime(10000);
    await f.t.mutation(renew, args);
  }
  vi.advanceTimersByTime(10001);
  await expect(f.t.mutation(renew, args)).rejects.toThrow(/exhausted/);
});
it("persists worst-case reservations before calls and preserves unknown charges across restart", () => {
  const dir = directory(),
    c = config(dir),
    budget = persistentAPBudget(dir, 100_000),
    reservation = budget.reserve(c, 1000);
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"))
      .spentMicros,
  ).toBe(reservation.costMicros);
  reservation.fail();
  const resumed = persistentAPBudget(dir, 100_000),
    r = resumed.reserve(c, 1000),
    usage = { ...emptyUsage(), costMicros: 1000 };
  r.settle(usage, c.model);
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"))
      .spentMicros,
  ).toBe(reservation.costMicros + 1000);
  expect(() => resumed.reserve(c, 10001)).toThrow(/input cap/);
  expect(() =>
    resumed.reserve({ ...c, maxOutputTokens: 100000 } as ModelConfig, 1000),
  ).toThrow(/spend cap/);
});
