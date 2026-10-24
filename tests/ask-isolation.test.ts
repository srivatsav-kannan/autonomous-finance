import { describe, expect, it } from "vitest";
import { answerAsk, createAsk } from "../convex/asks";
import { sha256Hex } from "../convex/lib/kernel";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

async function fixture() {
  const h = kernelHarness();
  const from = await h.setup("payments");
  const to = { runId: from.runId, seatId: "controller", token: "controller-token" };
  await h.seed("seats", { runId: to.runId, seatId: to.seatId, role: "controller", name: "Controller", kind: "agent", capabilities: {}, status: "active", tokenHash: await sha256Hex(to.token), createdAt: 0 });
  const task = { runId: from.runId, type: "payments.run", role: "payments", status: "waiting" as const, priority: 3, payload: {}, idempotencyKey: "work", createdBy: "controller", attempts: 1, createdAt: 0, updatedAt: 0 };
  const ownTaskId = await h.seed("tasks", task);
  const foreignTaskId = await h.seed("tasks", { ...task, runId: "other-run" });
  const question = { to: to.seatId, severity: "decision" as const, title: "Approve?", body: "Evidence", evidence: [], options: [{ id: "approve", label: "Approve" }] };
  return { h, from, to, ownTaskId, foreignTaskId, question };
}

describe("ask task isolation", () => {
  it("rejects a foreign-run task before creating an ask", async () => {
    const { h, from, foreignTaskId, question } = await fixture();
    const before = h.all("tasks");
    expect(await mutationHandler(createAsk)(h.ctx, { ...from, ...question, taskId: foreignTaskId })).toMatchObject({ ok: false, code: "invalid_task" });
    expect(h.all("asks")).toHaveLength(0);
    expect(h.all("tasks")).toEqual(before);
    expect(h.all("violations")).toMatchObject([{ operation: "asks.createAsk" }]);
  });

  it("rejects legacy foreign-run references before answering or requeuing", async () => {
    const { h, from, to, foreignTaskId, question } = await fixture();
    const askId = await h.seed("asks", { ...question, runId: from.runId, from: from.seatId, taskId: foreignTaskId, status: "open", createdAt: 0 });
    const tasks = h.all("tasks");
    const asks = h.all("asks");
    expect(await mutationHandler(answerAsk)(h.ctx, { ...to, askId, optionId: "approve" })).toMatchObject({ ok: false, code: "invalid_task" });
    expect(h.all("asks")).toEqual(asks);
    expect(h.all("tasks")).toEqual(tasks);
    expect(h.all("violations")).toMatchObject([{ operation: "asks.answerAsk" }]);
  });

  it("rejects missing tasks at creation and answer time", async () => {
    const { h, from, to, ownTaskId, question } = await fixture();
    const ask = await mutationHandler(createAsk)(h.ctx, { ...from, ...question, taskId: ownTaskId });
    if (!ask.ok) throw new Error(ask.error);
    await h.ctx.db.delete(ownTaskId);
    expect(await mutationHandler(createAsk)(h.ctx, { ...from, ...question, taskId: ownTaskId })).toMatchObject({ ok: false, code: "invalid_task" });
    expect(await mutationHandler(answerAsk)(h.ctx, { ...to, askId: ask.askId, optionId: "approve" })).toMatchObject({ ok: false, code: "invalid_task" });
    expect(h.all("asks")[0]?.status).toBe("open");
  });

  it("still answers an authorized ask and wakes only its own waiting task", async () => {
    const { h, from, to, ownTaskId, foreignTaskId, question } = await fixture();
    const ask = await mutationHandler(createAsk)(h.ctx, { ...from, ...question, taskId: ownTaskId });
    if (!ask.ok) throw new Error(ask.error);
    expect(await mutationHandler(createAsk)(h.ctx, { ...from, ...question, taskId: ownTaskId })).toMatchObject({ ok: true, duplicate: true, askId: ask.askId });
    expect(await mutationHandler(answerAsk)(h.ctx, { ...to, askId: ask.askId, optionId: "approve" })).toMatchObject({ ok: true });
    expect(await h.ctx.db.get(ownTaskId)).toMatchObject({ status: "queued" });
    expect(await h.ctx.db.get(foreignTaskId)).toMatchObject({ status: "waiting" });
    expect(h.all("asks")[0]).toMatchObject({ status: "answered", answer: { optionId: "approve", by: to.seatId } });
  });
});
