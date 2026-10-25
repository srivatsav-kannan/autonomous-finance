import { afterEach, expect, it, vi } from "vitest";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";

const banks: ReturnType<typeof openFakeBank>[] = [];
afterEach(() => { for (const bank of banks.splice(0)) bank.close(); vi.unstubAllEnvs(); });

async function settled() {
  const f = await demoFixture("close-signatures");
  const bank = openFakeBank({ path: ":memory:", scope: f.scope, seed: 7, startTime: "2026-10-23T12:00:00.000Z" });
  banks.push(bank);
  const dispatcher = new PaymentDispatcher(f.t as KernelTransport, f.scope, f.dispatcherToken, bank.provider, "close-test");
  const worker = new EvidenceWorker(f.t as KernelTransport, f.scope, f.evidenceToken, bank.provider);
  async function pay(amount: number) {
    const q = await f.queued(amount);
    await dispatcher.tick();
    bank.harness.settle(bank.harness.inspect().transfers.find(t => t.commandId === q.versionId)!.id);
    expect(await worker.tick()).toEqual({ posted: 1, errors: [] });
    return q;
  }
  const q = await pay(10000);
  const sign = (actor: "controller" | "human") => actor === "controller"
    ? f.t.mutation(api.demoEvidence.signClose, { ...f.controller, period: "2026-10" })
    : f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" });
  const period = () => f.t.run(ctx => ctx.db.query("periods").first());
  return { ...f, bank, worker, pay, q, sign, period };
}

it.each(["controller", "human"] as const)("expires the %s signature when another payment changes the ledger", async first => {
  const f = await settled();
  const second = first === "controller" ? "human" : "controller";
  expect(await f.sign(first)).toEqual({ status: "open" });
  const before = await f.period();
  await f.pay(20000);
  expect(await f.sign(second)).toEqual({ status: "open" });
  const after = await f.period();
  expect(after!.closedBy).toEqual([second === "human" ? "human_cfo" : "controller"]);
  expect(after!.closeSnapshotHash).not.toBe(before!.closeSnapshotHash);
  expect(await f.sign(first)).toEqual({ status: "closed" });
  expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(4);
  expect(f.bank.harness.inspect().transfers).toHaveLength(2);
  const signatures = await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "close_signed")).collect());
  expect(signatures.map(s => (s.refs as { snapshotHash: string }).snapshotHash)).toEqual([
    before!.closeSnapshotHash, after!.closeSnapshotHash, after!.closeSnapshotHash,
  ]);
});

it.each(["attached evidence", "resolved exception"])("expires a signature after %s changes without a new journal", async change => {
  const f = await settled();
  expect(await f.sign("controller")).toEqual({ status: "open" });
  const ledger = await f.t.run(ctx => ctx.db.query("ledgerHeads").first());
  await f.t.mutation(api.demoPayments.attachEvidence, { ...f.ap, billId: f.q.billId, evidence: "new-delivery-receipt" });
  if (change === "resolved exception") {
    await f.t.mutation(api.demoPayments.flagException, { ...f.ap, billId: f.q.billId, reason: "Review delivery" });
    await expect(f.sign("human")).rejects.toThrow("AP close blocked");
    const bill = (await f.t.run(ctx => ctx.db.get(f.q.billId)))!;
    await f.human.mutation(api.demoPayments.resolveBillExceptions, { scope: f.scope, billId: f.q.billId, expectedVersion: bill.version, flags: bill.flags, evidence: ["new-delivery-receipt"], reason: "Delivery verified" });
  }
  expect(await f.t.run(ctx => ctx.db.query("ledgerHeads").first())).toEqual(ledger);
  expect(await f.sign("human")).toEqual({ status: "open" });
  expect(await f.sign("controller")).toEqual({ status: "closed" });
});

it("keeps signatures across polling and duplicate evidence without changing their snapshot", async () => {
  const f = await settled();
  const notice = { scope: f.scope, token: f.evidenceToken, eventId: "event-settled", transferId: f.bank.harness.inspect().transfers[0]!.id, bodyHash: "a".repeat(64) };
  await f.t.mutation(api.demoEvidence.ingestNotice, notice);
  expect(await f.worker.tick()).toEqual({ posted: 0, errors: [] });
  expect(await f.sign("controller")).toEqual({ status: "open" });
  const before = await f.period();
  expect(await f.t.mutation(api.demoEvidence.ingestNotice, notice)).toEqual({ duplicate: true });
  expect(await f.worker.tick()).toEqual({ posted: 0, errors: [] });
  expect(await f.sign("controller")).toEqual({ status: "open" });
  expect(await f.sign("human")).toEqual({ status: "closed" });
  expect((await f.period())!.closeSnapshotHash).toBe(before!.closeSnapshotHash);
  expect((await f.period())!.closedBy).toEqual(["controller", "human_cfo"]);
});

it("requires renewed signatures when a new notification is reconciled without changing cash", async () => {
  const f = await settled();
  expect(await f.sign("controller")).toEqual({ status: "open" });
  const ledger = await f.t.run(ctx => ctx.db.query("ledgerHeads").first());
  await f.t.mutation(api.demoEvidence.ingestNotice, { scope: f.scope, token: f.evidenceToken, eventId: "late-event", transferId: f.bank.harness.inspect().transfers[0]!.id, bodyHash: "b".repeat(64) });
  await expect(f.sign("human")).rejects.toThrow("AP close blocked");
  expect(await f.worker.tick()).toEqual({ posted: 0, errors: [] });
  expect(await f.t.run(ctx => ctx.db.query("ledgerHeads").first())).toEqual(ledger);
  expect(await f.sign("human")).toEqual({ status: "open" });
  expect(await f.sign("controller")).toEqual({ status: "closed" });
});

it("does not reuse a pre-upgrade signature without a snapshot", async () => {
  const f = await settled();
  await f.t.run(async ctx => {
    const period = (await ctx.db.query("periods").first())!;
    await ctx.db.patch(period._id, { closedBy: ["controller"] });
  });
  expect(await f.sign("human")).toEqual({ status: "open" });
  expect((await f.period())!.closedBy).toEqual(["human_cfo"]);
  expect(await f.sign("controller")).toEqual({ status: "closed" });
});

it("serializes concurrent signatures for the same unchanged snapshot", async () => {
  const f = await settled();
  const results = await Promise.all([f.sign("controller"), f.sign("human")]);
  expect(results.map(r => r.status).sort()).toEqual(["closed", "open"]);
  const closed = await f.period();
  expect(closed!.closeSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(closed!.closedBy)).toEqual(new Set(["controller", "human_cfo"]));
});
