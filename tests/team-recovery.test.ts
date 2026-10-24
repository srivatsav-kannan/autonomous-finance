import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as kernel from "../src/core/kernel-client";
import { Team, HANDLERS } from "../src/agents/team";
import { WorkerHttpError } from "../src/agents/control-plane";
import { claimTask, completeTask, failTask, waitTask, heartbeatTask, drainState, queueStats } from "../convex/tasks";
import { logRun } from "../convex/observe";
import { list, spawnSeat } from "../convex/seats";
import { kernelHarness } from "./helpers/kernelHarness";
import type { Role } from "../src/core/roles";

const NOW = 1_000_000;
const definitions: Record<string, any> = {
  "tasks:claimTask": claimTask, "tasks:completeTask": completeTask, "tasks:failTask": failTask,
  "tasks:waitTask": waitTask, "tasks:heartbeatTask": heartbeatTask, "tasks:drainState": drainState,
  "tasks:queueStats": queueStats, "observe:logRun": logRun, "seats:list": list, "seats:spawnSeat": spawnSeat,
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  // Preserve SHA-256 semantics without a libuv hop outside the fake clock.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, data) =>
    createHash("sha256").update(Buffer.from(data as ArrayBuffer)).digest() as any);
});
afterEach(() => { delete HANDLERS["sre.probe"]; vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(roles: Role[] = ["ap_clerk"]) {
  const h = kernelHarness();
  const auth = await h.setup(roles[0]);
  const tokens: Record<string, string> = { [auth.seatId]: auth.token };
  for (const role of roles.slice(1)) {
    const seatId = `${role}-1`;
    tokens[seatId] = auth.token;
    await h.seed("seats", { ...h.all("seats")[0]!, _id: undefined, _creationTime: undefined, seatId, role } as any);
  }
  const invoke = async (ref: any, args: any) => definitions[getFunctionName(ref)]._handler(h.ctx, args);
  const client = { mutation: vi.fn(invoke), query: vi.fn(invoke) };
  vi.spyOn(kernel, "convex").mockReturnValue(client as any);
  vi.spyOn(fs, "readFileSync").mockReturnValueOnce(JSON.stringify(tokens));
  const diagnostic = vi.fn();
  const team = new Team(auth.runId, { diagnostic, retry: { baseDelayMs: 5, maxDelayMs: 10, timeoutMs: 50 } });
  let sequence = 0;
  const seed = (role: Role = roles[0]!, extra: Record<string, unknown> = {}) => h.seed("tasks", {
    runId: auth.runId, type: "sre.probe", role, status: "queued", priority: 3, payload: {},
    idempotencyKey: `probe-${++sequence}`, createdBy: "controller", attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), ...extra,
  });
  const fault = (name: string, count: number, afterCommit = false) => {
    let remaining = count;
    const method = name === "seats:list" || name === "tasks:drainState" ? client.query : client.mutation;
    method.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === name && remaining-- > 0) {
        if (afterCommit) await invoke(ref, args);
        throw new TypeError(`fetch failed: token=${auth.token}`);
      }
      return invoke(ref, args);
    });
  };
  HANDLERS["sre.probe"] = vi.fn(async () => ({ outcome: "recorded" }));
  return { h, auth, team, client, diagnostic, seed, fault, invoke, handler: vi.mocked(HANDLERS["sre.probe"]) };
}

// Converted from the SRE review probes: these assert recovery, not the prior defects.
describe("shared worker control-plane recovery", () => {
  it.each([false, true])("keeps polling after telemetry failure (committed=%s) without rerunning completed work", async (committed) => {
    const f = await fixture();
    await f.seed();
    f.fault("observe:logRun", 1, committed);
    const running = f.team.runForever(20);
    await vi.advanceTimersByTimeAsync(100);
    f.team.stop();
    await running;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.h.all("agentRuns")).toHaveLength(1);
    expect(f.client.query.mock.calls.filter(([ref]) => getFunctionName(ref) === "seats:list").length).toBeGreaterThan(1);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "recovered", operation: expect.stringContaining("observe.logRun") }));
  });

  it("bounds telemetry retries, retains a safe fallback and recovers on later work", async () => {
    const f = await fixture();
    await f.seed();
    f.fault("observe:logRun", 3);
    const running = f.team.runForever(20);
    await vi.advanceTimersByTimeAsync(60);
    expect(f.h.all("tasks")[0]?.status).toBe("done");
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "telemetry_fallback", outcome: "recorded", inputTokens: 0 }));
    await f.seed();
    await vi.advanceTimersByTimeAsync(60);
    f.team.stop();
    await running;
    expect(f.handler).toHaveBeenCalledTimes(2);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "recovered" }));
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(f.auth.token);
  });

  it.each([false, true])("retries a claim with the same request ID (committed=%s)", async (committed) => {
    const f = await fixture();
    await f.seed(); await f.seed();
    f.fault("tasks:claimTask", 1, committed);
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(100);
    await drained;
    expect(f.h.all("tasks").map(t => [t.status, t.attempts])).toEqual([["done", 1], ["done", 1]]);
    expect(f.handler).toHaveBeenCalledTimes(2);
    const claims = f.client.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "tasks:claimTask");
    expect(claims[0]![1].requestId).toBe(claims[1]![1].requestId);
  });

  it("continues unrelated seats while a role's claims are unavailable", async () => {
    const f = await fixture(["ap_clerk", "cash_application"]);
    await f.seed(); await f.seed("cash_application");
    f.client.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === "tasks:claimTask" && args.seatId === f.auth.seatId) throw new TypeError("fetch failed");
      return f.invoke(ref, args);
    });
    const running = f.team.runForever(20);
    await vi.advanceTimersByTimeAsync(100);
    f.team.stop(); await running;
    expect(f.h.all("tasks").map(t => t.status)).toEqual(["queued", "done"]);
  });

  it("uses known seats during a refresh outage and eventually refreshes again", async () => {
    const f = await fixture();
    await f.seed();
    await f.team.refreshSeats();
    f.fault("seats:list", 3);
    const running = f.team.runForever(20);
    await vi.advanceTimersByTimeAsync(100);
    f.team.stop(); await running;
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "recovered", operation: "seats.list" }));
  });

  it.each(["tasks:completeTask", "tasks:failTask", "tasks:waitTask"])("replays a committed %s without changing task state again", async (operation) => {
    const f = await fixture();
    await f.seed();
    if (operation === "tasks:failTask") f.handler.mockRejectedValueOnce(new Error("dependency unavailable"));
    if (operation === "tasks:waitTask") f.handler.mockResolvedValue({ outcome: "waiting", waiting: true });
    f.fault(operation, 1, true);
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(1200);
    await drained;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: operation === "tasks:waitTask" ? "waiting" : "done", attempts: operation === "tasks:failTask" ? 2 : 1 });
    expect(f.handler).toHaveBeenCalledTimes(operation === "tasks:failTask" ? 2 : 1);
    expect(f.h.all("violations")).toHaveLength(0);
  });

  it("does not fail or reopen an ambiguously completed task when the response stays unavailable", async () => {
    const f = await fixture();
    await f.seed();
    f.fault("tasks:completeTask", 3, true);
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(500);
    await drained;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.client.mutation.mock.calls.some(([ref]) => getFunctionName(ref) === "tasks:failTask")).toBe(false);
  });

  it("recovers an unreported failure through lease expiry after the report retry budget is exhausted", async () => {
    const f = await fixture();
    await f.seed();
    f.handler.mockRejectedValueOnce(new Error("temporary handler failure"));
    f.fault("tasks:failTask", 3);
    const drained = f.team.runUntilIdle({ timeoutMs: 130_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "leased", attempts: 1 });
    await vi.advanceTimersByTimeAsync(120_000);
    await drained;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(f.handler).toHaveBeenCalledTimes(2);
  });

  it("recovers a transient heartbeat without losing the task lease", async () => {
    const f = await fixture();
    await f.seed();
    let release!: (result: { outcome: string }) => void;
    f.handler.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.fault("tasks:heartbeatTask", 1);
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.h.all("tasks")[0]!.leaseExpiresAt).toBeGreaterThan(NOW + 120_000);
    release({ outcome: "recorded" });
    await vi.advanceTimersByTimeAsync(20);
    await drained;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["bad_token", "http_auth", "config"])("fails clearly without transport retry on %s", async (mode) => {
    const f = await fixture();
    await f.seed();
    f.client.mutation.mockImplementation(async () => {
      if (mode === "bad_token") return { ok: false, code: "bad_token", error: f.auth.token };
      if (mode === "http_auth") throw new WorkerHttpError(401);
      throw new Error(`missing function; request token=${f.auth.token}`);
    });
    await expect(f.team.runForever()).rejects.toThrow(/credentials|rejected/);
    expect(f.client.mutation).toHaveBeenCalledTimes(1);
    expect(f.handler).not.toHaveBeenCalled();
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain(f.auth.token);
  });
});

describe("draining executable work", () => {
  it.each(["ap_clerk", "cash_application", "payments"] as Role[])("waits for a %s task that retries once and then succeeds", async (role) => {
    const f = await fixture([role]);
    await f.seed();
    f.handler.mockResolvedValueOnce({ outcome: "retry", summary: "temporary dependency failure" });
    let finished = false;
    const drained = f.team.runUntilIdle().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(finished).toBe(false);
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "queued", attempts: 1, notBefore: NOW + 500 });
    await vi.advanceTimersByTimeAsync(20);
    await drained;
    expect(f.h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(f.handler).toHaveBeenCalledTimes(2);
  });

  it("handles multiple due times and recovers another worker's expired lease", async () => {
    const f = await fixture(["ap_clerk", "cash_application"]);
    await f.seed("ap_clerk", { notBefore: NOW + 250 });
    await f.seed("cash_application", { notBefore: NOW + 750 });
    await f.seed("ap_clerk", { status: "leased", leaseOwner: "crashed", leaseExpiresAt: NOW + 1000, attempts: 1 });
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    await drained;
    expect(f.h.all("tasks").map(t => [t.status, t.attempts])).toEqual([["done", 1], ["done", 1], ["done", 2]]);
  });

  it("does not call an empty claim drained when it only terminalized an exhausted lease", async () => {
    const f = await fixture();
    await f.seed("ap_clerk", { status: "leased", leaseOwner: "crashed", leaseExpiresAt: NOW - 1, attempts: 4 });
    await f.seed();
    const drained = f.team.runUntilIdle({ idleRounds: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await drained;
    expect(f.h.all("tasks").map(t => t.status)).toEqual(["failed", "done"]);
  });

  it("returns without waiting on human-blocked or terminal work", async () => {
    const f = await fixture();
    await f.seed("ap_clerk", { status: "waiting" });
    await f.seed("ap_clerk", { status: "failed" });
    const drained = f.team.runUntilIdle();
    await vi.advanceTimersByTimeAsync(20);
    await drained;
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("fails explicitly for unstaffed executable work", async () => {
    const f = await fixture();
    await f.seed("cash_application");
    await expect(f.team.runUntilIdle()).rejects.toMatchObject({ reason: "unstaffed", pending: 1 });
  });

  it.each(["claim", "retry", "query", "hung_rpc"])("rejects at the drain deadline for a permanently unavailable %s", async (mode) => {
    const f = await fixture();
    await f.seed("ap_clerk", mode === "query" ? { notBefore: NOW + 1000 } : {});
    if (mode === "claim") f.fault("tasks:claimTask", Infinity);
    if (mode === "retry") f.handler.mockResolvedValue({ outcome: "retry" });
    if (mode === "query") f.fault("tasks:drainState", Infinity);
    if (mode === "hung_rpc") f.client.mutation.mockImplementation(() => new Promise(() => {}));
    const failed = expect(f.team.runUntilIdle({ timeoutMs: 200 })).rejects.toMatchObject({ reason: "timed_out" });
    await vi.advanceTimersByTimeAsync(250);
    await failed;
    expect(f.h.all("tasks")[0]?.status).toBe("queued");
  });

  it("stops immediately during a delayed retry wait without claiming again", async () => {
    const f = await fixture();
    await f.seed("ap_clerk", { notBefore: NOW + 10_000 });
    const failed = expect(f.team.runUntilIdle()).rejects.toMatchObject({ reason: "stopped" });
    await vi.advanceTimersByTimeAsync(10);
    const calls = f.client.mutation.mock.calls.length;
    f.team.stop(); await failed;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.client.mutation).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on deadline even with a pending handler, and schedules no more work when it finishes", async () => {
    const f = await fixture();
    await f.seed(); await f.seed();
    let release!: (result: { outcome: string }) => void;
    f.handler.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const failed = expect(f.team.runUntilIdle({ timeoutMs: 200 })).rejects.toMatchObject({ reason: "timed_out" });
    await vi.advanceTimersByTimeAsync(200);
    await failed;
    release({ outcome: "recorded" });
    await vi.advanceTimersByTimeAsync(20);
    expect(f.h.all("tasks").map(t => t.status)).toEqual(["done", "queued"]);
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes in-flight work after stop but starts no next claim", async () => {
    const f = await fixture();
    await f.seed(); await f.seed();
    let release!: (result: { outcome: string }) => void;
    f.handler.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = f.team.runForever();
    await vi.advanceTimersByTimeAsync(1);
    f.team.stop(); release({ outcome: "recorded" }); await running;
    expect(f.h.all("tasks").map(t => t.status)).toEqual(["done", "queued"]);
    expect(f.handler).toHaveBeenCalledTimes(1);
  });
});
