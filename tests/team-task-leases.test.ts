import fs from "node:fs";
import { getFunctionName } from "convex/server";
import { afterEach, expect, it, vi } from "vitest";
import { claimTask, completeTask, deferTask, failTask, heartbeatTask } from "../convex/tasks";
import { SeatRuntime } from "../src/agents/runtime";
import { HANDLERS, Team } from "../src/agents/team";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("the worker renews and completes with the new generation after deferring and reclaiming", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv("CONVEX_URL", "http://127.0.0.1:3210");
  const h = kernelHarness();
  const auth = await h.setup("payments");
  const taskId = await h.seed("tasks", {
    runId: auth.runId, type: "payments.run", role: "payments", status: "queued", priority: 3,
    payload: {}, idempotencyKey: "work", createdBy: "controller", attempts: 0, leaseGeneration: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  // The team only needs its in-memory seat here; no scenario files or backend are used.
  const read = vi.spyOn(fs, "readFileSync").mockReturnValueOnce("{}");
  const team = new Team(auth.runId);
  read.mockRestore();
  const rt = new SeatRuntime(auth.runId, { seatId: auth.seatId, role: "payments", name: "Payments" }, auth.token, team.mem, team.bank);
  const mutation = vi.spyOn(rt.kernel.client, "mutation").mockImplementation(async (...call) => {
    const [ref, args] = call;
    switch (getFunctionName(ref)) {
      case "tasks:claimTask": return mutationHandler(claimTask)(h.ctx, args);
      case "tasks:completeTask": return mutationHandler(completeTask)(h.ctx, args);
      case "tasks:deferTask": return mutationHandler(deferTask)(h.ctx, args);
      case "tasks:failTask": return mutationHandler(failTask)(h.ctx, args);
      case "tasks:heartbeatTask": return mutationHandler(heartbeatTask)(h.ctx, args);
      case "observe:logRun": return { ok: true };
      default: throw new Error(`unexpected mutation ${getFunctionName(ref)}`);
    }
  });
  vi.spyOn(HANDLERS, "payments.run")
    .mockResolvedValueOnce({ outcome: "deferred", deferMs: 100 })
    .mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      return { outcome: "finished" };
    });

  expect(await team.step(rt)).toBe(true);
  expect(h.all("tasks")[0]).toMatchObject({ status: "queued", attempts: 0, deferrals: 1, leaseGeneration: 1 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await team.step(rt)).toBe(true);
  expect(h.all("tasks")[0]).toMatchObject({
    status: "done", attempts: 1, deferrals: 1, leaseGeneration: 2, result: { outcome: "finished" },
  });
  const leaseCalls = mutation.mock.calls
    .map(([ref, args]) => ({ name: getFunctionName(ref), args }))
    .filter(({ name }) => ["tasks:deferTask", "tasks:heartbeatTask", "tasks:completeTask"].includes(name));
  expect(leaseCalls).toMatchObject([
    { name: "tasks:deferTask", args: { taskId, leaseGeneration: 1 } },
    { name: "tasks:heartbeatTask", args: { taskId, leaseGeneration: 2 } },
    { name: "tasks:completeTask", args: { taskId, leaseGeneration: 2 } },
  ]);
  expect(h.all("violations")).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
