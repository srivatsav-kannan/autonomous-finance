import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/lib/kernel";
import { claimTask, completeTask, deferTask, failTask, heartbeatTask, waitTask } from "../convex/tasks";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

const NOW = 1_000_000;
afterEach(() => vi.restoreAllMocks());

async function queuedFixture(overrides: Partial<Doc<"tasks">> = {}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const h = kernelHarness();
  const auth = await h.setup("payments");
  const taskId = await h.seed("tasks", {
    runId: auth.runId, type: "payments.run", role: "payments", status: "queued", priority: 3,
    payload: {}, idempotencyKey: "work", createdBy: "controller", attempts: 0, leaseGeneration: 0, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  });
  return { h, auth, taskId };
}

async function fixture() {
  const { h, auth, taskId } = await queuedFixture();
  const claim = await mutationHandler(claimTask)(h.ctx, auth);
  if (!claim.ok || !claim.task) throw new Error("expected claim");
  const lease = { ...auth, taskId, leaseGeneration: claim.task.leaseGeneration };
  return { h, auth, taskId, lease };
}

const transitions = [
  ["complete", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(completeTask)(h.ctx, { ...lease, result: "finished" })],
  ["fail", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(failTask)(h.ctx, { ...lease, error: "retry", retryInMs: 0 })],
  ["wait", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(waitTask)(h.ctx, { ...lease, reason: "approval" })],
  ["defer", (h: ReturnType<typeof kernelHarness>, lease: Awaited<ReturnType<typeof fixture>>["lease"]) => mutationHandler(deferTask)(h.ctx, { ...lease, delayMs: 100, reason: "waiting for parser" })],
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
    expect(reclaimed).toMatchObject({ ok: true, reclaimed: true, task: { _id: lease.taskId, attempts: 2, leaseGeneration: 2, leaseOwner: auth.seatId } });
    const before = h.all("tasks");
    expect(await transition(h, lease)).toMatchObject({ ok: false, code: "stale_lease" });
    expect(h.all("tasks")).toEqual(before);
    expect(await transition(h, { ...lease, leaseGeneration: 2 })).toMatchObject({ ok: true });
  });

  it.each(transitions)("rejects stale %s after deferral and same-seat reclaim", async (_name, transition) => {
    const { h, auth, lease } = await fixture();
    expect(await mutationHandler(deferTask)(h.ctx, { ...lease, delayMs: 100, reason: "waiting for parser" }))
      .toMatchObject({ ok: true, deferrals: 1 });
    expect(h.all("tasks")[0]).toMatchObject({ status: "queued", attempts: 0, leaseGeneration: 1, notBefore: NOW + 100 });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    vi.mocked(Date.now).mockReturnValue(NOW + 101);
    const reclaimed = await mutationHandler(claimTask)(h.ctx, auth);
    if (!reclaimed.ok || !reclaimed.task) throw new Error("expected reclaim");
    expect(reclaimed.task).toMatchObject({ _id: lease.taskId, attempts: 1, leaseGeneration: 2, leaseOwner: auth.seatId });
    const before = h.all("tasks");
    expect(await transition(h, lease)).toMatchObject({ ok: false, code: "stale_lease" });
    expect(h.all("tasks")).toEqual(before);
    expect(h.all("violations")).toMatchObject([{ operation: `tasks.${_name}Task`, reason: expect.stringContaining("stale_lease:") }]);
    expect(await transition(h, { ...lease, leaseGeneration: reclaimed.task.leaseGeneration })).toMatchObject({ ok: true });
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
    expect(await mutationHandler(waitTask)(h.ctx, { ...lease, leaseGeneration: 2, reason: "approval" })).toMatchObject({ ok: true });
    expect(h.all("tasks")[0]).toMatchObject({ status: "waiting", leaseOwner: undefined, leaseExpiresAt: undefined });
    await h.ctx.db.patch(lease.taskId, { status: "queued" });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: { attempts: 3 } });
    expect(await mutationHandler(failTask)(h.ctx, { ...lease, leaseGeneration: 3, error: "give up" })).toMatchObject({ ok: true, status: "failed" });
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

  it("keeps 200 deferrals separate from the four-attempt failure budget", async () => {
    const { h, auth, lease } = await fixture();
    let current = lease;
    for (let deferrals = 1; deferrals <= 200; deferrals++) {
      expect(await mutationHandler(deferTask)(h.ctx, { ...current, delayMs: 100, reason: "waiting for parser" }))
        .toMatchObject({ ok: true, deferrals });
      expect(h.all("tasks")[0]).toMatchObject({ attempts: 0, leaseGeneration: deferrals, deferrals });
      vi.mocked(Date.now).mockReturnValue(NOW + deferrals * 100);
      const claim = await mutationHandler(claimTask)(h.ctx, auth);
      if (!claim.ok || !claim.task) throw new Error("expected deferred claim");
      expect(claim.task).toMatchObject({ attempts: 1, leaseGeneration: deferrals + 1 });
      current = { ...lease, leaseGeneration: claim.task.leaseGeneration };
    }
    const before = h.all("tasks");
    expect(await mutationHandler(deferTask)(h.ctx, { ...current, delayMs: 100, reason: "still waiting" }))
      .toMatchObject({ ok: false, code: "too_many_deferrals" });
    expect(h.all("tasks")).toEqual(before);

    for (let attempts = 1; attempts <= 4; attempts++) {
      expect(await mutationHandler(failTask)(h.ctx, { ...current, error: "retry", retryInMs: 0 }))
        .toMatchObject({ ok: true, status: attempts === 4 ? "failed" : "queued" });
      expect(h.all("tasks")[0]).toMatchObject({ attempts, leaseGeneration: 200 + attempts, deferrals: 200 });
      const claim = await mutationHandler(claimTask)(h.ctx, auth);
      if (attempts === 4) {
        expect(claim).toMatchObject({ ok: true, task: null });
      } else {
        if (!claim.ok || !claim.task) throw new Error("expected retry claim");
        current = { ...lease, leaseGeneration: claim.task.leaseGeneration };
      }
    }
  });

  it("refunds only the deferred attempt after prior failures", async () => {
    const { h, auth, lease } = await fixture();
    expect(await mutationHandler(failTask)(h.ctx, { ...lease, error: "retry", retryInMs: 0 })).toMatchObject({ ok: true });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ task: { attempts: 2, leaseGeneration: 2 } });
    expect(await mutationHandler(deferTask)(h.ctx, { ...lease, leaseGeneration: 2, delayMs: 100, reason: "wait" }))
      .toMatchObject({ ok: true });
    expect(h.all("tasks")[0]).toMatchObject({ attempts: 1, deferrals: 1, leaseGeneration: 2 });
    vi.mocked(Date.now).mockReturnValue(NOW + 100);
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ task: { attempts: 2, leaseGeneration: 3 } });
  });
});

describe("stored tasks without lease generations", () => {
  it.each([undefined, 3])("initializes queued tasks without resetting prior attempts or %s deferrals", async (deferrals) => {
    const { h, auth, taskId } = await queuedFixture({ leaseGeneration: undefined, attempts: 2, deferrals });
    const generation = 3 + (deferrals ?? 0);
    expect(await mutationHandler(claimTask)(h.ctx, auth))
      .toMatchObject({ ok: true, task: { attempts: 3, leaseGeneration: generation, deferrals } });
    expect(h.all("tasks")[0]).toMatchObject({ attempts: 3, leaseGeneration: generation, deferrals });
    expect(await mutationHandler(completeTask)(h.ctx, { ...auth, taskId, leaseGeneration: generation }))
      .toMatchObject({ ok: true });
  });

  it.each(transitions)("rejects %s on an ambiguous legacy lease until expiry and reclaim", async (_name, transition) => {
    const { h, auth, taskId } = await queuedFixture({
      status: "leased", leaseGeneration: undefined, attempts: 1, deferrals: 3,
      leaseOwner: "payments-1", leaseExpiresAt: NOW + 120_000,
    });
    const oldLease = { ...auth, taskId, leaseGeneration: 1 };
    const before = h.all("tasks");
    expect(await transition(h, oldLease)).toMatchObject({ ok: false, code: "stale_lease" });
    expect(h.all("tasks")).toEqual(before);
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    vi.mocked(Date.now).mockReturnValue(NOW + 120_000);
    expect(await mutationHandler(claimTask)(h.ctx, auth))
      .toMatchObject({ ok: true, reclaimed: true, task: { attempts: 2, deferrals: 3, leaseGeneration: 5 } });
    const reclaimed = h.all("tasks");
    expect(await transition(h, oldLease)).toMatchObject({ ok: false, code: "stale_lease" });
    expect(h.all("tasks")).toEqual(reclaimed);
    expect(await transition(h, { ...oldLease, leaseGeneration: 5 })).toMatchObject({ ok: true });
  });

  it.each(["queued", "leased"] as const)("does not reset exhausted legacy %s tasks", async (status) => {
    const { h, auth } = await queuedFixture({
      status, attempts: 4, deferrals: 3, leaseGeneration: undefined,
      leaseOwner: "payments-1", leaseExpiresAt: NOW,
    });
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    expect(h.all("tasks")[0]).toMatchObject({
      status: "failed", attempts: 4, deferrals: 3, leaseGeneration: undefined,
      leaseOwner: undefined, leaseExpiresAt: undefined,
    });
  });

  it.each(["waiting", "done", "failed"] as const)("leaves legacy %s tasks unchanged", async (status) => {
    const { h, auth } = await queuedFixture({ status, attempts: 1, leaseGeneration: undefined });
    const before = h.all("tasks");
    expect(await mutationHandler(claimTask)(h.ctx, auth)).toMatchObject({ ok: true, task: null });
    expect(h.all("tasks")).toEqual(before);
  });
});
