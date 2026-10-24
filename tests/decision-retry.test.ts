import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatRuntime } from "../src/agents/runtime";
import { MemoryStore } from "../src/memory/store";
import type { Decision } from "../src/memory/schemas";
import type { WorldBank } from "../src/world/bank";

const decision = {
  on: "2026-01-05", task: "task-1", kind: "bill", subject: { type: "invoice", id: "INV-1" },
  outcome: "act" as const, confidence: 0.99, summary: "Approved invoice", facts: [], rules: [],
};
let dir: string;
let mem: MemoryStore;
function runtime(store = mem) {
  const rt = new SeatRuntime("test", { seatId: "ap-1", role: "ap_clerk", name: "AP" }, "token", store, {} as WorldBank);
  vi.spyOn(rt.kernel.client, "mutation").mockResolvedValue({ ok: true });
  return rt;
}

beforeEach(async () => {
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-retry-"));
  mem = new MemoryStore(path.join(dir, "memory.git"));
  await mem.init();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("decision evidence retries", () => {
  it("returns the original path, commit, and memory snapshot after unrelated writes and restart", async () => {
    const rt = runtime();
    const before = await mem.head();
    const first = await rt.decide(decision);
    await rt.decide({ ...decision, task: "another-task" });
    const retry = await runtime(new MemoryStore(mem.dir)).decide({ ...decision, on: "2026-02-01" });
    expect(retry).toEqual(first);
    expect(first.memorySha).toBe(before);
    expect(await mem.read<Decision>(retry.path, retry.sha)).toMatchObject({ task: "task-1", on: decision.on });
    expect((await mem.list("decisions/")).length).toBe(2);
  });

  it.each([false, true])("recovers when the kernel mirror fails (response lost: %s)", async (responseLost) => {
    const rt = runtime();
    const mirror = vi.mocked(rt.kernel.client.mutation);
    const persisted = new Map<string, unknown>();
    mirror.mockImplementation(async (...call) => {
      const [, args] = call;
      if (responseLost) persisted.set(args.sha, args);
      throw new Error("transport failed");
    });
    const before = await mem.head();
    await expect(rt.decide(decision)).rejects.toThrow("transport failed");
    const originalPayload = mirror.mock.calls[0]![1];
    const committed = await mem.head();
    mirror.mockImplementation(async (...call) => {
      const [, args] = call;
      if (!persisted.has(args.sha)) persisted.set(args.sha, args);
      return { ok: true };
    });
    const retry = await rt.decide({ ...decision, on: "2026-02-01", summary: "retry text" });
    expect(retry).toEqual({ path: originalPayload.paths[0], sha: committed, memorySha: before });
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(mirror.mock.calls[1]![1]).toEqual(originalPayload);
    expect(persisted.size).toBe(1);
    expect(await mem.head()).toBe(committed);
  });

  it("finds another store's completed decision even with a warmed local idempotency index", async () => {
    const other = runtime(new MemoryStore(mem.dir));
    await other.decide({ ...decision, task: "warm-index" });
    const first = await runtime().decide(decision);
    expect(await other.decide(decision)).toEqual(first);
    expect((await mem.list("decisions/")).length).toBe(2);
  });

  it("does not report success when the kernel rejects the commit mirror", async () => {
    const rt = runtime();
    const mirror = vi.mocked(rt.kernel.client.mutation);
    mirror.mockResolvedValueOnce({ ok: false, code: "forbidden", error: "invalid credentials" });
    await expect(rt.decide(decision)).rejects.toThrow("recordCommit failed: forbidden invalid credentials");
    const committed = await mem.head();
    expect((await rt.decide(decision)).sha).toBe(committed);
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(mirror.mock.calls[1]![1]).toEqual(mirror.mock.calls[0]![1]);
  });

  it("preserves Git authorship when a different authenticated seat retries the mirror", async () => {
    const first = runtime();
    vi.mocked(first.kernel.client.mutation).mockRejectedValueOnce(new Error("mirror unavailable"));
    await expect(first.decide(decision)).rejects.toThrow("mirror unavailable");
    const second = new SeatRuntime("test", { seatId: "ap-2", role: "ap_clerk", name: "Second AP" }, "second-token", mem, {} as WorldBank);
    const mirror = vi.spyOn(second.kernel.client, "mutation").mockResolvedValue({ ok: true });
    const retry = await second.decide(decision);
    expect(await mem.read<Decision>(retry.path)).toMatchObject({ seat: "ap-1" });
    expect(mirror.mock.calls[0]![1]).toMatchObject({ seatId: "ap-2", token: "second-token", trailers: {
      "Git-Author": "AP", "Git-Author-Email": MemoryStore.emailFor("ap-1"),
    } });
  });

  it("publishes one decision when separate stores race the same task", async () => {
    const other = new MemoryStore(mem.dir);
    let arrived = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    for (const store of [mem, other]) {
      const git = store.git.bind(store);
      let gated = false;
      vi.spyOn(store, "git").mockImplementation(async (args, opts) => {
        if (!gated && args[0] === "update-ref" && args[1] === "refs/heads/main") {
          gated = true;
          if (++arrived === 2) release();
          await bothReady;
        }
        return git(args, opts);
      });
    }
    const results = await Promise.all([runtime().decide(decision), runtime(other).decide(decision)]);
    expect(results[0]).toEqual(results[1]);
    expect(await mem.list("decisions/")).toHaveLength(1);
  });
});
