import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "../demo-fixture";
import { createPaymentCommandService } from "../../src/payments/application/payment-commands";
import { createConvexPaymentCommands } from "../../src/payments/adapters/convex-payment-commands";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import type { CommandEnvelope, RequestPayment } from "../../src/payments/contracts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const f = await demoFixture();
  const service = (client: KernelTransport, actor: Parameters<typeof createConvexPaymentCommands>[2]) =>
    createPaymentCommandService(createConvexPaymentCommands(client, f.scope, actor));
  return {
    ...f,
    payments: service(f.t as KernelTransport, { kind: "agent", seatId: "payments", token: "token-payments" }),
    controller: service(f.t as KernelTransport, { kind: "agent", seatId: "controller", token: "token-controller" }),
    humanCommands: service(f.human as KernelTransport, { kind: "human" }),
    unauthenticatedHuman: service(f.t as KernelTransport, { kind: "human" }),
  };
}

describe("payment commands through the application service and authenticated adapter", () => {
  it("maps request identity once, keeps policy approval insufficient, and records the real human on replay", async () => {
    const f = await fixture(); const billId = await f.bill();
    const envelope: CommandEnvelope<RequestPayment> = {
      commandId: "stable-business-request", command: { type: "RequestPayment", billIds: [billId], credits: [] },
    };
    const requested = await f.payments.requestPayment(envelope);
    expect(await f.payments.requestPayment(envelope)).toEqual(requested);
    expect(await f.t.run(ctx => ctx.db.query("demoVersions").collect())).toEqual([
      expect.objectContaining({ requestKey: envelope.commandId, requestedBy: "payments", reservations: "reserved" }),
    ]);
    expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({ reservedVersionId: requested.versionId, paidCents: 0 });
    await f.controller.approveWithinPolicy({ commandId: "policy-review", command: { type: "ApproveWithinPolicy", ...requested } });
    expect(await f.t.run(ctx => ctx.db.query("demoCommands").collect())).toEqual([]);

    const approval = { type: "ApprovePayment" as const, ...requested };
    const first = await f.humanCommands.approveAndQueue({ commandId: "human-correlation-one", command: approval });
    expect(await f.humanCommands.approveAndQueue({ commandId: "human-correlation-two", command: approval })).toEqual(first);
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review.commands).toHaveLength(1);
    expect(review.commands[0]).toMatchObject({ _id: first.commandId, attemptCount: 0,
      command: { commandId: requested.versionId, approvalVersion: requested.versionId, idempotencyKey: `demo:${requested.versionId}` } });
    expect(review.versions[0]?.approvals.filter(approval => approval.kind === "human")).toEqual([
      expect.objectContaining({ seatId: "human_cfo", subject: f.humanIdentity.tokenIdentifier, snapshotHash: requested.snapshotHash }),
    ]);
    expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({ paidCents: 0 });
    expect((await f.t.run(ctx => ctx.db.query("journalEntries").collect())).filter(entry => entry.lines.some(line => line.account === "1000"))).toEqual([]);
  });

  it("does not turn a client-side human label or supplied actor fields into approval authority", async () => {
    const f = await fixture(); const billId = await f.bill();
    const requested = await f.payments.requestPayment({ commandId: "needs-human", command: { type: "RequestPayment", billIds: [billId], credits: [] } });
    const approval = { commandId: "approval", command: { type: "ApprovePayment" as const, ...requested } };
    await expect(async () => f.payments.approveAndQueue(approval)).rejects.toThrow(/authenticated human/i);
    await expect(async () => f.unauthenticatedHuman.approveAndQueue(approval)).rejects.toThrow(/authenticated human/i);
    const forged = { ...approval, command: { ...approval.command, subject: f.humanIdentity.tokenIdentifier } };
    await expect(async () => f.humanCommands.approveAndQueue(forged)).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.query("demoCommands").collect())).toEqual([]);
    expect((await f.human.query(api.demoPayments.humanReview, { scope: f.scope })).versions[0]?.approvals).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({ reservedVersionId: requested.versionId, paidCents: 0 });
  });

  it("snapshots the adapter scope and cancels only the identified reserved payment", async () => {
    const f = await demoFixture(); const billId = await f.bill();
    const binding = { ...f.scope };
    const payments = createPaymentCommandService(createConvexPaymentCommands(f.t as KernelTransport, binding,
      { kind: "agent", seatId: "payments", token: "token-payments" }));
    binding.accountId = "mutated-after-binding";
    const requested = await payments.requestPayment({ commandId: "bound-request", command: { type: "RequestPayment", billIds: [billId], credits: [] } });
    const human = createPaymentCommandService(createConvexPaymentCommands(f.human as KernelTransport, f.scope, { kind: "human" }));
    expect(await human.cancel({ commandId: "cancel-correlation", command: { type: "CancelPayment", versionId: requested.versionId } })).toBeUndefined();
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review.versions[0]).toMatchObject({ scope: f.scope, status: "cancelled", reservations: "released" });
    expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({ paidCents: 0 });
    expect((await f.t.run(ctx => ctx.db.get(billId)))?.reservedVersionId).toBeUndefined();
    expect(review.commands).toEqual([]);
  });
});
