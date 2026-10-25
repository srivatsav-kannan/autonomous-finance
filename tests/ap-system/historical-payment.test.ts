import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { intakeSchema, type APIntake, type HistoricalPaymentHold } from "../../src/ap-system/contracts";
import { fixture, packet, refs } from "./accounting-fixture";
import { businessFixture, syncPrimary } from "./business-fixture";

afterEach(() => vi.unstubAllEnvs());
const casePayments = { request: makeFunctionReference<"mutation">("apCasePayments:request"), authorize: makeFunctionReference<"mutation">("apCasePayments:authorize") };
function hold(input: APIntake): HistoricalPaymentHold {
  const c = input.candidate!;
  return { version: "historical-payment-hold-v1", supplierId: c.supplierId!, invoiceNumber: c.invoiceNumber,
    currency: "USD", amountCents: c.totalCents, invoiceSourceSha256: input.documents[0]!.sha256,
    paidDate: "2026-10-20", reference: "HISTORICAL-CHECK-1", sourceSystem: "synthetic-test-ledger",
    sourceRevision: "fixture-v1", sourceRecordId: "HISTORICAL-BILL-1", evidence: [{ name: "ledger.csv", sha256: "a".repeat(64) }] };
}
function historicalPacket() { const input = packet(); input.historicalPaymentHold = hold(input); return input; }

it("persists a historical hold before field review and blocks business approval, legacy approval and payment", async () => {
  const input = historicalPacket(), f = await businessFixture({ input });
  expect(f.detail.historicalPaymentHold).toEqual(input.historicalPaymentHold);
  expect(f.detail.states).toMatchObject({ document: "reviewed", business: "held", accounting: "unposted", execution: "not_started" });
  expect(f.detail.exceptions).toContainEqual(expect.objectContaining({ code: "historical_payment_hold", blocking: true }));
  await expect(f.propose()).rejects.toThrow(/historical_payment_hold/);
  await expect(f.human.mutation(refs.approve, { scope: f.scope, input: { ...f.request(f.detail, "legacy"), acceptedCents: input.candidate!.totalCents } })).rejects.toThrow(/historical_payment_hold/);
  await expect(f.t.mutation(casePayments.request, { scope: f.scope, seatId: "payments", token: "token-payments", caseId: f.detail.caseId, expectedRevision: f.detail.revision, snapshotHash: f.detail.snapshotHash, idempotencyKey: "duplicate-payment" })).rejects.toThrow(/historical_payment_hold/);
  const state = await f.t.run(async ctx => ({ bills: await ctx.db.query("demoBills").collect(), versions: await ctx.db.query("demoVersions").collect(), commands: await ctx.db.query("demoCommands").collect(), journals: await ctx.db.query("journalEntries").collect() }));
  expect(state).toEqual({ bills: [], versions: [], commands: [], journals: [] });
});

it("keeps the hold through omission, renamed delivery, changed original revision and replay of old bytes", async () => {
  const input = historicalPacket(), f = await businessFixture({ input });
  const reimport = packet(); reimport.idempotencyKey = "without-history";
  reimport.documents[0]!.name = "renamed-invoice.pdf";
  reimport.documents[0]!.deliveryId = "renamed-delivery";
  const duplicate = await f.t.mutation(refs.ingest, { ...f.ap, input: reimport });
  expect(duplicate).toMatchObject({ caseId: f.detail.caseId, duplicate: true });
  const revised = packet(); revised.idempotencyKey = "revised-without-history"; revised.explicitRevisionOf = f.detail.caseId;
  revised.candidate!.revision = 2;
  const original = revised.documents[0]!;
  original.replaces = { sourceId: original.sourceId, revision: original.revision, sha256: original.sha256 };
  original.revision = 2; original.deliveryId = "revised-original";
  syncPrimary(revised);
  expect(original.sha256).not.toBe(input.documents[0]!.sha256);
  const changed = await f.reviewed(revised);
  expect(changed.historicalPaymentHold).toEqual(input.historicalPaymentHold);
  await expect(f.propose(changed)).rejects.toThrow(/historical_payment_hold/);
  const oldBytes = packet(); oldBytes.idempotencyKey = "old-original-new-supplier";
  oldBytes.candidate!.supplierId = "another-supplier";
  await expect(f.t.mutation(refs.ingest, { ...f.ap, input: oldBytes })).rejects.toThrow(/explicit_revision_required/);
  await expect(f.t.mutation(api.demoPayments.recordBill, { ...f.ap, vendor: input.candidate!.supplierId!, invoiceNumber: "INV GS-1042", invoiceDate: "2026-10-19", originalCents: 7700, expenseAccount: "5000", evidence: ["original invoice"] })).rejects.toThrow(/historical_payment_hold/);
  expect(await f.t.run(ctx => ctx.db.query("apCaseRecords").collect())).toHaveLength(1);
});

it.each(["recorded", "requested", "queued"] as const)("blocks an unlinked legacy bill when historical evidence arrives (%s)", async stage => {
  const f = await fixture(), input = historicalPacket();
  const record = { ...f.ap, vendor: input.candidate!.supplierId!, invoiceNumber: "INV GS-1042", invoiceDate: "2026-10-19", originalCents: 7700, expenseAccount: "5000", evidence: ["invoice"] };
  const bill = await f.t.mutation(api.demoPayments.recordBill, record);
  const accept = { scope: f.scope, billId: bill.billId, approvedCents: 7700 };
  const request = { scope: f.scope, seatId: "payments", token: "token-payments", requestKey: "legacy-before-history", billIds: [bill.billId], credits: [] };
  if (stage !== "recorded") await f.human.mutation(api.demoPayments.humanAcceptBill, accept);
  const payment = stage !== "recorded" ? await f.t.mutation(api.demoPayments.requestPayment, request) : null;
  const command = stage === "queued" ? await f.human.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...payment! }) : null;
  const imported = await f.t.mutation(refs.ingest, { ...f.ap, input });
  expect((await f.get(imported.caseId)).links.billId).toBeNull();
  await expect(f.t.mutation(api.demoPayments.recordBill, record)).rejects.toThrow(/historical_payment_hold/);
  await expect(f.human.mutation(api.demoPayments.humanAcceptBill, accept)).rejects.toThrow(/historical_payment_hold/);
  await expect(f.t.mutation(api.demoPayments.requestPayment, { ...request, requestKey: "legacy-after-history" })).rejects.toThrow(/historical_payment_hold/);
  if (stage === "requested") await expect(f.human.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...payment! })).rejects.toThrow(/historical_payment_hold/);
  if (command) {
    expect(await f.t.mutation(api.demoPayments.claim, { scope: f.scope, token: "test-dispatch", paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, workerId: "legacy-history", leaseToken: "legacy-history-lease" })).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(command.commandId))).toMatchObject({ attemptCount: 0 });
  }
  expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
});

it("cannot replace the original historical restriction or attach it to a different invoice", async () => {
  const input = historicalPacket(), f = await fixture();
  await f.t.mutation(refs.ingest, { ...f.ap, input });
  const changed = structuredClone(input); changed.idempotencyKey = "conflicting-history"; changed.historicalPaymentHold!.reference = "DIFFERENT";
  await expect(f.t.mutation(refs.ingest, { ...f.ap, input: changed })).rejects.toThrow(/historical_payment_conflict/);
  for (const patch of [{ invoiceNumber: "OTHER" }, { supplierId: "OTHER" }, { amountCents: 1 }, { invoiceSourceSha256: "f".repeat(64) }])
    expect(intakeSchema.safeParse({ ...input, historicalPaymentHold: { ...input.historicalPaymentHold, ...patch } }).success).toBe(false);
});

it("blocks votes on a proposal created before historical evidence arrived", async () => {
  const f = await businessFixture(), proposal = await f.propose();
  const input = structuredClone(f.input); input.idempotencyKey = "late-history"; input.historicalPaymentHold = hold(input);
  await f.t.mutation(refs.ingest, { ...f.ap, input });
  await expect(f.vote(proposal)).rejects.toThrow(/historical_payment_hold/);
  expect((await f.get(f.detail.caseId)).links.billId).toBeNull();
});

it.each([false, true])("blocks direct payment-engine authorization or first dispatch after late historical evidence (queued=%s)", async queued => {
  const f = await businessFixture(), bill = await f.recognize();
  const request = { scope: f.scope, seatId: "payments", token: "token-payments", requestKey: "before-history", billIds: [bill.billId], credits: [] };
  const payment = await f.t.mutation(api.demoPayments.requestPayment, request);
  const command = queued ? await f.humans.finance!.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...payment }) : null;
  const input = structuredClone(f.input); input.idempotencyKey = "late-history"; input.historicalPaymentHold = hold(input);
  await f.t.mutation(refs.ingest, { ...f.ap, input });
  await expect(f.t.mutation(api.demoPayments.requestPayment, { ...request, requestKey: "after-history" })).rejects.toThrow(/historical_payment_hold/);
  if (!queued) {
    await expect(f.humans.finance!.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...payment })).rejects.toThrow(/historical_payment_hold/);
    const detail = await f.get(f.detail.caseId);
    await expect(f.humans.finance!.mutation(casePayments.authorize, { scope: f.scope, caseId: detail.caseId, expectedRevision: detail.revision, snapshotHash: detail.snapshotHash, versionId: payment.versionId, paymentSnapshotHash: payment.snapshotHash })).rejects.toThrow(/historical_payment_hold/);
  } else {
    const lease = await f.t.mutation(api.demoPayments.claim, { scope: f.scope, token: "test-dispatch", paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, workerId: "history-test", leaseToken: "history-test-lease" });
    expect(lease).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(command!.commandId))).toMatchObject({ attemptCount: 0 });
  }
});
