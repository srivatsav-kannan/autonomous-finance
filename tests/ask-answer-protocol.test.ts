import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../src/core/kernel-client";
import { answer } from "../src/human/gateway";
import { legacyKernel } from "./helpers/legacyKernel";

async function fixture() {
  const k = legacyKernel();
  await k.init();
  const human = await k.seat("human-cfo", "human_cfo", "human");
  const controller = await k.seat("controller", "controller");
  const intentId = await k.h.seed("paymentIntents", {
    runId: k.runId, payee: "vendor-1", amountCents: 10_000, method: "ach", remitTo: { bank: "Test Bank", accountLast4: "1234", memorySha: "v1" },
    billIds: [], dueDate: "2026-01-30", requestedBy: "payments", approvals: [], requiredApprovals: 1, requiresHuman: true,
    status: "pending_approval", idempotencyKey: "pay:1", createdAt: 0,
  });
  const taskId = await k.h.seed("tasks", {
    runId: k.runId, type: "payments.approve", role: "controller", status: "waiting", priority: 2, payload: { intentId },
    idempotencyKey: `approve:${intentId}`, createdBy: "payments", attempts: 1, createdAt: 0, updatedAt: 0,
  });
  const created = await controller.client.mutation(api.asks.createAsk, {
    ...controller.auth, to: "human_cfo", severity: "decision", title: "Approve $100.00 to Vendor 1", body: "evidence",
    evidence: [], effect: { kind: "payment", paymentIntentId: intentId }, taskId,
  });
  if (!created.ok) throw new Error(created.error);
  const askId = created.askId;
  const intent = () => k.h.ctx.db.get(intentId);
  const ask = () => k.h.ctx.db.get(askId);
  return { k, human, controller, intentId, taskId, askId, intent, ask };
}

describe("human ask answers", () => {
  it("rejects a conflicting answer before it can change the payment", async () => {
    const f = await fixture();
    expect(await answer(f.human, f.k.runId, f.askId, "approve")).toMatchObject({ ok: true, effects: ["payment approved"] });
    await expect(answer(f.human, f.k.runId, f.askId, "reject")).rejects.toThrow(/already answered/);
    expect(await f.intent()).toMatchObject({ status: "approved", approvals: [{ seatId: "human-cfo" }] });
    expect(await f.ask()).toMatchObject({ status: "answered", answer: { optionId: "approve", by: "human-cfo" } });
  });

  it("treats a replay of the same answer as a no-op", async () => {
    const f = await fixture();
    await answer(f.human, f.k.runId, f.askId, "approve");
    const activity = f.k.h.all("activity").length;
    expect(await answer(f.human, f.k.runId, f.askId, "approve")).toMatchObject({ ok: true, replayed: true });
    expect(f.k.h.all("activity")).toHaveLength(activity);
    expect(await f.intent()).toMatchObject({ status: "approved" });
  });

  it("validates the option before any effect", async () => {
    const f = await fixture();
    await f.k.h.ctx.db.patch(f.askId, { options: [{ id: "approve", label: "Approve payment" }] });
    await expect(answer(f.human, f.k.runId, f.askId, "reject")).rejects.toThrow(/no option reject/);
    await expect(answer(f.human, f.k.runId, f.askId, "sign")).rejects.toThrow();
    await expect(answer(f.human, f.k.runId, f.askId, "merge")).rejects.toThrow();
    expect(await f.ask()).toMatchObject({ status: "open" });
    expect((await f.ask())!.answer).toBeUndefined();
    expect(await f.intent()).toMatchObject({ status: "pending_approval", approvals: [] });
  });

  it("does not mark the decision complete when its effect fails, and resumes on retry", async () => {
    const f = await fixture();
    // An unrelated limit stands in for a transient effect failure: the human may not approve yet.
    await f.k.h.ctx.db.patch(f.intentId, { requestedBy: "human-cfo" });
    await expect(answer(f.human, f.k.runId, f.askId, "approve")).rejects.toThrow(/refused/);
    expect(await f.ask()).toMatchObject({ status: "open", answer: { optionId: "approve" } });
    expect(await f.k.h.ctx.db.get(f.taskId)).toMatchObject({ status: "waiting" });
    // A different answer cannot replace the recorded decision while its effect is pending.
    await expect(answer(f.human, f.k.runId, f.askId, "reject")).rejects.toThrow(/already answered/);
    expect(await f.intent()).toMatchObject({ status: "pending_approval" });
    await f.k.h.ctx.db.patch(f.intentId, { requestedBy: "payments" });
    expect(await answer(f.human, f.k.runId, f.askId, "approve")).toMatchObject({ ok: true, effects: ["payment approved"] });
    expect(await f.ask()).toMatchObject({ status: "answered" });
    expect(await f.k.h.ctx.db.get(f.taskId)).toMatchObject({ status: "queued" });
  });

  it("kernel answerAsk refuses a different option on an answered ask and checks the addressee first", async () => {
    const f = await fixture();
    const askId = f.askId as Id<"asks">;
    expect(await f.human.client.mutation(api.asks.answerAsk, { ...f.human.auth, askId, optionId: "reject" })).toMatchObject({ ok: true });
    expect(await f.human.client.mutation(api.asks.answerAsk, { ...f.human.auth, askId, optionId: "approve" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.human.client.mutation(api.asks.answerAsk, { ...f.human.auth, askId, optionId: "reject" })).toMatchObject({ ok: true, alreadyAnswered: true });
    expect(await f.controller.client.mutation(api.asks.answerAsk, { ...f.controller.auth, askId, optionId: "reject" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.ask()).toMatchObject({ answer: { optionId: "reject", by: "human-cfo" } });
  });
});
