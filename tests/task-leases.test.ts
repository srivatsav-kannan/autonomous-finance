import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../convex/lib/kernel";
import { claimTask, completeTask, failTask, heartbeatTask, waitTask } from "../convex/tasks";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

const NOW = 1_000_000;
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const h = kernelHarness();
  const auth = await h.setup("payments");
  const taskId = await h.seed("tasks", {
    runId: auth.runId, type: "payments.run", role: "payments", status: "queued", priority: 3,
    payload: {}, idempotencyKey: "work", createdBy: "controller", attempts: 0, createdAt: NOW, updatedAt: NOW,
  });
  const claim = await mutationHandler(claimTask)(h.ctx, auth);
  if (!claim.ok || !claim.task) throw new Error("expected claim");
  const lease = { ...auth, taskId, leaseAttempt: claim.task.attempts };
  return { h, auth, taskId, lease };
}

const transitions = [
  ["complete", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(completeTask)(h.ctx, { ...lease, result: "finished" })],
  ["fail", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(failTask)(h.ctx, { ...lease, error: "retry", retryInMs: 0 })],
  ["wait", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(waitTask)(h.ctx, { ...lease, reason: "approval" })],
  ["heartbeat", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(heartbeatTask)(h.ctx, lease)],
] as const;

describe("task lease boundaries", () => {
  it("an auditor cannot suspend another role's leased work", async () => {
    const { h, lease } = await fixture();
    await h.seed("seats", {
      runId: lease.runId, seatId: "auditor", role: "auditor", name: "Auditor", kind: "agent",
      capabilities: {}, status: "active", tokenHash: await sha256Hex("audit-token"), createdAt: NOW,
    });
    const before = h.all("tasks");
    expect(await mutationHandler(waitTask)(h.ctx, { ...lease, seatId: "auditor", token: "audit-token", reason: "park" }))
      .toMatchObject({ ok: false, code: "not_lease_owner" });
    expect(h.all("tasks")).toEqual(before);
    expect(h.all("violations")).toMatchObject([{ seatId: "auditor", operation: "tasks.waitTask" }]);
  });

  it("a delayed failure cannot reopen completed work", async () => {
    const { h, lease } = await fixture();
    expect(await mutationHandler(completeTask)(h.ctx, { ...lease, result: "success" })).toMatchObject({ ok: true });
    const completed = h.all("tasks");
    expect(await mutationHandler(failTask)(h.ctx, { ...lease, error: "late", retryInMs: 0 })).toMatchObject({ ok: false, code: "not_leased" });
    expect(h.all("tasks")).toEqual(completed);
    expect(completed[0]).toMatchObject({ status: "done", result: "success", leaseOwner: undefined, leaseExpiresAt: undefined });
  });

  it.each(transitions)("rejects %s at the exact lease expiry without changing the task", async (_name, transition) => {
    const { h, lease } = await fixture();
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    const before = h.all("tasks");
    expect(await transition(h, lease)).toMatchObject({ ok: false, code: "lease_expired" });
    expect(h.all("tasks")).toEqual(before);
    expect(h.all("violations")).toHaveLength(1);
  });

  it.each(transitions)("rejects old %s messages when the same seat reclaims its task", async (_name, transition) => {
    const { h, auth, lease } = await fixture();
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    const reclaimed = await mutationHandler(claimTask)(h.ctx, auth);
    expect(reclaimed).toMatchObject({ ok: true, reclaimed: true, task: { _id: lease.taskId, attempts: 2, leaseOwner: auth.seatId } });
    const before = h.all("tasks");
    expect(await transition(h, lease)).toMatchObject({ ok: false, code: "stale_lease" });
    expect(h.all("tasks")).toEqual(before);
    expect(await transition(h, { ...lease, leaseAttempt: 2 })).toMatchObject({ ok: true });
  });

  it.each(["queued", "waiting", "done", "failed"] as const)("does not mutate %s work using a leftover lease owner", async (status) => {
    const { h, lease } = await fixture();
    await h.ctx.db.patch(lease.taskId, { status });
    const before = h.all("tasks");
    for (const [, transition] of transitions) {
      expect(await transition(h, lease)).toMatchObject({ ok: false, code: "not_leased" });
      expect(h.all("tasks")).toEqual(before);
    }
  });

  it("preserves owner wait, retry and terminal-failure workflows and clears leases", async () => {
    const { h, auth, lease } = await fixture();
    expect(await mutationHandler(failTask)(h.ctx, { ...lease, error: "retry", retryInMs: 500 })).toMatchObject({ ok: true, status: "queued" });
    expect(h.all("tasks")[0]).toMatchObject({ status: "queued", notBefore: NOW + 500, leaseOwner: undefined, leaseExpiresAt: undefined });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    vi.mocked(Date.now).mockReturnValue(NOW + 500);
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: { attempts: 2 } });
    expect(await mutationHandler(waitTask)(h.ctx, { ...lease, leaseAttempt: 2, reason: "approval" })).toMatchObject({ ok: true });
    expect(h.all("tasks")[0]).toMatchObject({ status: "waiting", leaseOwner: undefined, leaseExpiresAt: undefined });
    await h.ctx.db.patch(lease.taskId, { status: "queued" });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: { attempts: 3 } });
    expect(await mutationHandler(failTask)(h.ctx, { ...lease, leaseAttempt: 3, error: "give up" })).toMatchObject({ ok: true, status: "failed" });
  });

  it("keeps a healthy worker alive beyond the original expiry", async () => {
    const { h, lease } = await fixture();
    vi.mocked(Date.now).mockReturnValue(NOW + 90_000);
    expect(await mutationHandler(heartbeatTask)(h.ctx, lease)).toMatchObject({ ok: true });
    expect(h.all("tasks")[0]?.leaseExpiresAt).toBe(NOW + 210_000);
    vi.mocked(Date.now).mockReturnValue(NOW + 150_000);
    expect(await mutationHandler(completeTask)(h.ctx, { ...lease, result: "long handler" })).toMatchObject({ ok: true });
  });

  it("clears expired lease metadata when attempts are exhausted", async () => {
    const { h, auth, lease } = await fixture();
    await h.ctx.db.patch(lease.taskId, { attempts: 4 });
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    expect(h.all("tasks")[0]).toMatchObject({ status: "failed", leaseOwner: undefined, leaseExpiresAt: undefined });
  });
});
