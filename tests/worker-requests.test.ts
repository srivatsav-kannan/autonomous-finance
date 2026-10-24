import { describe, expect, it } from "vitest";
import { claimTask, completeTask, failTask } from "../convex/tasks";
import { logRun } from "../convex/observe";
import { spawnSeat } from "../convex/seats";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

async function fixture() {
  const h = kernelHarness();
  const auth = await h.setup();
  const taskId = await h.seed("tasks", { runId: auth.runId, role: "ap_clerk", type: "probe", status: "queued", priority: 3,
    payload: {}, idempotencyKey: "probe", createdBy: "admin", attempts: 0, createdAt: 0, updatedAt: 0 });
  return { h, auth, taskId };
}

describe("worker RPC idempotency and fencing", () => {
  it("replays the same claim and completion, but rejects a conflicting payload and a stale new request", async () => {
    const { h, auth, taskId } = await fixture();
    const args = { ...auth, requestId: "claim-1" };
    const first = await mutationHandler(claimTask)(h.ctx, args);
    expect(await mutationHandler(claimTask)(h.ctx, args)).toEqual(first);
    const completion = { ...auth, taskId, leaseAttempt: 1, requestId: "complete-1", result: "done" };
    expect(await mutationHandler(completeTask)(h.ctx, completion)).toMatchObject({ ok: true });
    expect(await mutationHandler(completeTask)(h.ctx, completion)).toMatchObject({ ok: true });
    expect(await mutationHandler(completeTask)(h.ctx, { ...completion, result: "different" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await mutationHandler(failTask)(h.ctx, { ...auth, taskId, leaseAttempt: 1, requestId: "late-fail", error: "late", retryInMs: 0 })).toMatchObject({ ok: false, code: "not_leased" });
    expect(h.all("tasks")[0]).toMatchObject({ status: "done", attempts: 1, result: "done" });
  });

  it("authenticates before replay and does not persist empty polling requests", async () => {
    const { h, auth } = await fixture();
    await mutationHandler(claimTask)(h.ctx, { ...auth, requestId: "claimed" });
    expect(await mutationHandler(claimTask)(h.ctx, { ...auth, requestId: "claimed", token: "wrong" })).toMatchObject({ ok: false, code: "bad_token" });
    for (let n = 0; n < 5; n++) await mutationHandler(claimTask)(h.ctx, { ...auth, requestId: `empty-${n}` });
    expect(h.all("idempotency")).toHaveLength(1);
    expect(JSON.stringify(h.all("idempotency"))).not.toContain(auth.token);
  });

  it("deduplicates telemetry with a lost response", async () => {
    const { h, auth, taskId } = await fixture();
    const args = { ...auth, taskId, requestId: "run-1", kind: "deterministic", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0, latencyMs: 1, toolCalls: 0, outcome: "recorded" };
    await mutationHandler(logRun)(h.ctx, args);
    await mutationHandler(logRun)(h.ctx, args);
    expect(h.all("agentRuns")).toHaveLength(1);
    expect(h.all("agentRuns")[0]).not.toHaveProperty("requestId");
    expect(JSON.stringify(h.all("agentRuns"))).not.toContain(auth.token);
  });

  it("replays a spawn without creating a second seat or losing the credential", async () => {
    const h = kernelHarness();
    const auth = await h.setup("cfo_agent");
    const args = { ...auth, requestId: "spawn-1", newSeatId: "ap-2", role: "ap_clerk", name: "AP 2", tokenHash: "hash", reason: "capacity" };
    expect(await mutationHandler(spawnSeat)(h.ctx, args)).toMatchObject({ ok: true });
    expect(await mutationHandler(spawnSeat)(h.ctx, args)).toMatchObject({ ok: true });
    expect(h.all("seats").filter(s => s.seatId === "ap-2")).toMatchObject([{ tokenHash: "hash" }]);
    expect(h.all("activity")).toHaveLength(1);
  });
});
