import { afterEach, expect, it, vi } from "vitest";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";

afterEach(() => vi.unstubAllEnvs());

it("replays invoice prefix variants as one payable, including concurrent ingestion", async () => {
  const f = await demoFixture("invoice-identity");
  const input = { ...f.ap, vendor: "vendor-1", invoiceDate: "2026-10-23", originalCents: 10000, expenseAccount: "5000", evidence: ["same-invoice"] };
  const recorded = await Promise.all(["INV-001", "INVOICE-001", "no 0001", "1"].map(invoiceNumber =>
    f.t.mutation(api.demoPayments.recordBill, { ...input, invoiceNumber })));
  const billIds = [...new Set(recorded.map(r => r.billId))];
  expect(billIds).toHaveLength(1);
  await expect(f.t.mutation(api.demoPayments.recordBill, { ...input, invoiceNumber: "invoice-1", originalCents: 20000 })).rejects.toThrow("Invoice idempotency conflict");
  await f.t.mutation(api.demoPayments.acceptBill, { ...f.controller, billId: billIds[0]!, approvedCents: 10000 });
  await expect(f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "duplicate", billIds: [billIds[0]!, billIds[0]!], credits: [] })).rejects.toThrow("Distinct bills");
  const requested = await f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "one-invoice", billIds, credits: [] });
  await f.human.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...requested });
  const commands = await f.t.run(ctx => ctx.db.query("demoCommands").collect());
  expect(commands).toHaveLength(1);
  expect(commands[0]!.command.amountCents).toBe(10000);
});

it.each(["controller", "human"])("lets the %s resolve a paid invoice exception without changing money", async resolver => {
  const f = await demoFixture(`paid-exception-${resolver}`);
  const q = await f.queued();
  const bank = openFakeBank({ path: ":memory:", scope: f.scope, seed: 7, startTime: "2026-10-23T12:00:00.000Z" });
  try {
    await new PaymentDispatcher(f.t as KernelTransport, f.scope, f.dispatcherToken, bank.provider, "regression").tick();
    bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
    const worker = new EvidenceWorker(f.t as KernelTransport, f.scope, f.evidenceToken, bank.provider);
    expect(await worker.tick()).toEqual({ posted: 1, errors: [] });
    const beforeBill = await f.t.run(ctx => ctx.db.get(q.billId));
    const beforeEntries = await f.t.run(ctx => ctx.db.query("journalEntries").collect());
    const beforeCommands = await f.t.run(ctx => ctx.db.query("demoCommands").collect());
    await f.t.mutation(api.demoPayments.flagException, { ...f.ap, billId: q.billId, reason: "delivery may be missing" });
    await f.t.mutation(api.demoPayments.attachEvidence, { ...f.ap, billId: q.billId, evidence: "confirmed-delivery" });
    await expect(f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" })).rejects.toThrow("delivery may be missing");
    const bill = (await f.t.run(ctx => ctx.db.get(q.billId)))!;
    const resolution = { scope: f.scope, billId: q.billId, expectedVersion: bill.version, flags: bill.flags, evidence: ["confirmed-delivery"], reason: "Receipt verified against the delivery" };
    if (resolver === "controller") await f.t.mutation(api.demoPayments.resolveBillExceptions, { ...resolution, ...f.controller });
    else await f.human.mutation(api.demoPayments.resolveBillExceptions, resolution);
    expect((await f.t.run(ctx => ctx.db.get(q.billId)))!).toMatchObject({ paidCents: beforeBill!.paidCents, approvedCents: beforeBill!.approvedCents, entryId: beforeBill!.entryId, status: "paid", flags: [] });
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toEqual(beforeEntries);
    expect(await f.t.run(ctx => ctx.db.query("demoCommands").collect())).toEqual(beforeCommands);
    expect(await worker.tick()).toEqual({ posted: 0, errors: [] });
    expect(bank.harness.inspect().transfers).toHaveLength(1);
    const audit = await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "bill_exceptions_resolved")).collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]!.refs).toMatchObject({ billId: q.billId, reason: resolution.reason, evidence: resolution.evidence, flags: resolution.flags });
    expect(await f.t.mutation(api.demoEvidence.signClose, { ...f.controller, period: "2026-10" })).toEqual({ status: "open" });
    expect(await f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" })).toEqual({ status: "closed" });
  } finally { bank.close(); }
});

it("requires authorized current review and attached evidence, and only clears selected flags", async () => {
  const f = await demoFixture("exception-authority");
  const billId = await f.bill();
  await f.t.mutation(api.demoPayments.flagException, { ...f.ap, billId, reason: "delivery" });
  const initial = (await f.t.run(ctx => ctx.db.get(billId)))!;
  const resolution = { scope: f.scope, billId, expectedVersion: initial.version, flags: ["delivery"], evidence: initial.evidence, reason: "Confirmed receipt" };
  await expect(f.t.mutation(api.demoPayments.resolveBillExceptions, { ...resolution, ...f.ap })).rejects.toThrow("Forbidden");
  await expect(f.t.mutation(api.demoPayments.resolveBillExceptions, resolution)).rejects.toThrow("authenticated human");
  await expect(f.human.mutation(api.demoPayments.resolveBillExceptions, { ...resolution, evidence: ["not-attached"] })).rejects.toThrow("attached evidence");
  await f.t.mutation(api.demoPayments.flagException, { ...f.ap, billId, reason: "quantity" });
  await expect(f.human.mutation(api.demoPayments.resolveBillExceptions, resolution)).rejects.toThrow("Stale bill exception review");
  const current = (await f.t.run(ctx => ctx.db.get(billId)))!;
  await f.human.mutation(api.demoPayments.resolveBillExceptions, { ...resolution, expectedVersion: current.version });
  expect((await f.t.run(ctx => ctx.db.get(billId)))!.flags).toEqual(["quantity"]);
  expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers).toContainEqual({ kind: "bill", id: billId, reason: "quantity" });
});
