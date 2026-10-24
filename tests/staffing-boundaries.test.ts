import { describe, expect, it } from "vitest";
import { retireSeat, spawnSeat } from "../convex/seats";
import { sha256Hex } from "../convex/lib/kernel";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

async function fixture() {
  const h = kernelHarness();
  const agent = await h.setup("cfo_agent");
  const human = { runId: agent.runId, seatId: "human-cfo", token: "human-token" };
  await h.seed("seats", { runId: human.runId, seatId: human.seatId, role: "human_cfo", name: "Human CFO", kind: "human", capabilities: {}, status: "active", tokenHash: await sha256Hex(human.token), createdAt: 0 });
  return { h, agent, human };
}

describe("CFO staffing boundary", () => {
  it.each(["controller", "payments", "auditor", "ap_clerk"])("the agent cannot retire a human-appointed %s", async (role) => {
    const { h, agent, human } = await fixture();
    expect(await mutationHandler(spawnSeat)(h.ctx, { ...human, newSeatId: "new-seat", role, name: "Appointed seat", tokenHash: await sha256Hex("seat-token"), reason: "independent staffing" })).toMatchObject({ ok: true });
    const seats = h.all("seats");
    expect(await mutationHandler(retireSeat)(h.ctx, { ...agent, targetSeatId: "new-seat", reason: "downsize" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(h.all("seats")).toEqual(seats);
    expect(h.all("violations")).toMatchObject([{ operation: "seats.retireSeat" }]);
    expect(await mutationHandler(retireSeat)(h.ctx, { ...human, targetSeatId: "new-seat", reason: "human authorized" })).toMatchObject({ ok: true });
    expect(h.all("seats").find((s) => s.seatId === "new-seat")?.status).toBe("retired");
  });

  it.each(["controller", "payments", "auditor"])("rejects a legacy self-spawned control role %s", async (role) => {
    const { h, agent } = await fixture();
    await h.seed("seats", { runId: agent.runId, seatId: "legacy", role, name: "Legacy control", kind: "agent", capabilities: {}, status: "active", tokenHash: "unused", createdAt: 0, spawnedBy: agent.seatId });
    const seats = h.all("seats");
    expect(await mutationHandler(retireSeat)(h.ctx, { ...agent, targetSeatId: "legacy", reason: "downsize" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(h.all("seats")).toEqual(seats);
  });

  it("cannot retire another agent's worker or a baseline seat", async () => {
    const { h, agent } = await fixture();
    for (const spawnedBy of ["another-cfo", undefined]) {
      const targetSeatId = spawnedBy ?? "baseline";
      await h.seed("seats", { runId: agent.runId, seatId: targetSeatId, role: "ap_clerk", name: "AP", kind: "agent", capabilities: {}, status: "active", tokenHash: "unused", createdAt: 0, spawnedBy });
      expect(await mutationHandler(retireSeat)(h.ctx, { ...agent, targetSeatId, reason: "downsize" })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(h.all("seats").every((s) => s.status === "active")).toBe(true);
  });

  it.each(["ap_clerk", "cash_application", "revenue_accountant", "fpa"])("can retire its own %s worker", async (role) => {
    const { h, agent } = await fixture();
    expect(await mutationHandler(spawnSeat)(h.ctx, { ...agent, newSeatId: "worker", role, name: "Worker", tokenHash: await sha256Hex("worker-token"), reason: "backlog" })).toMatchObject({ ok: true });
    expect(await mutationHandler(retireSeat)(h.ctx, { ...agent, targetSeatId: "worker", reason: "queue drained" })).toMatchObject({ ok: true });
    expect(h.all("seats").find((s) => s.seatId === "worker")?.status).toBe("retired");
    expect(h.all("violations")).toHaveLength(0);
  });
});
