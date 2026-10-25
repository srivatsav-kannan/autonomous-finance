import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "../demo-fixture";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { createPaymentCommandService } from "../../src/payments/application/payment-commands";
import { createConvexPaymentCommands } from "../../src/payments/adapters/convex-payment-commands";
import { ReleaseUnsentPayment } from "../../src/payments/application/release-unsent-payment";
import { RELEASE_SAFETY_WINDOW_MS } from "../../src/payments/domain/rules";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import { EvidenceWorker } from "../../src/payments/evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import type { PaymentRail } from "../../src/payments/ports/payment-rail";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); });

// #76: a worker that dies after claiming but before sending must not strand the bills forever.
async function crashedBeforeSend() {
  const f = await demoFixture("release-unsent");
  const dir = mkdtempSync(join(tmpdir(), "ap-release-"));
  const bank = openFakeBank({ path: join(dir, "bank.sqlite"), scope: f.scope, seed: 76, startTime: "2026-10-23T00:00:00.000Z" });
  cleanup.push(() => { bank.close(); rmSync(dir, { recursive: true, force: true }); });
  // Increase's real capability: lookup by operation key, never resend after an attempt.
  const rail: PaymentRail = { recovery: { lookup: "operation_key", sameKeyResend: { kind: "never", reason: "Provider retention not established" } },
    createTransfer: command => bank.provider.createTransfer(command), lookupTransfer: (command, id) => bank.provider.lookupTransfer(command, id) };
  const transport = f.t as unknown as KernelTransport;
  const queued = await f.queued(10_000);
  // 1. The worker claims (attempt recorded, in_flight) and is killed before the provider POST.
  const lease = await f.t.mutation(api.demoPayments.claim, { scope: f.scope, token: f.dispatcherToken, workerId: "doomed", leaseToken: "doomed-lease-token-0001", paymentExecutorVersion: "scoped-ap-v2" });
  expect(lease).toMatchObject({ action: "submit" });
  const command = async () => (await f.t.run(ctx => ctx.db.get(queued.commandId)))!;
  const age = (ms: number) => f.t.run(async ctx => {
    const row = (await ctx.db.get(queued.commandId))!;
    await ctx.db.patch(row._id, { firstAttemptAt: row.firstAttemptAt! - ms, leaseExpiresAt: Math.min(row.leaseExpiresAt ?? 0, Date.now() - 1) });
  });
  await age(0); // 2. The lease expires.
  const dispatcher = new PaymentDispatcher(transport, f.scope, f.dispatcherToken, rail, "recovery");
  // 3. Recovery lookup finds nothing; resend is not allowed, so the command needs review.
  expect(await dispatcher.tick()).toMatchObject({ error: "configuration" });
  expect(await command()).toMatchObject({ execution: "exception", attemptCount: 2 });
  const humanCommands = createPaymentCommandService(createConvexPaymentCommands(f.human as unknown as KernelTransport, f.scope, { kind: "human" }));
  const service = new ReleaseUnsentPayment(humanCommands, bank.provider);
  const candidate = async () => {
    const row = await command();
    return { commandId: row._id, command: row.command, execution: row.execution, firstAttemptAt: row.firstAttemptAt, providerTransferId: row.providerTransferId, release: row.release };
  };
  const bill = () => f.t.run(ctx => ctx.db.get(queued.billId));
  return { ...f, bank, rail, queued, dispatcher, command, age, service, candidate, bill, humanCommands };
}

describe("operator release of a payment claimed but never sent", () => {
  it("reproduces the stuck exception, then releases it after the safety window with an audit trail", async () => {
    const f = await crashedBeforeSend();
    // 4-5. Resume repeats the same lookup; cancel is refused once any attempt exists.
    await f.human.mutation(api.demoPayments.resume, { scope: f.scope, commandId: f.queued.commandId, reason: "Retry recovery" });
    expect(await f.dispatcher.tick()).toMatchObject({ error: "configuration" });
    expect((await f.command()).execution).toBe("exception");
    await expect(f.human.mutation(api.demoPayments.cancel, { scope: f.scope, versionId: f.queued.versionId })).rejects.toThrow("Submission may have started");
    expect((await f.bill())!.reservedVersionId).toBe(f.queued.versionId);

    await f.age(RELEASE_SAFETY_WINDOW_MS + 1000);
    const check = await f.service.release(await f.candidate(), "Worker killed before POST; bank shows no transfer");
    expect(check).toMatchObject({ lookup: "not_found", matchingTransferIds: [], matchingTransactionIds: [] });
    expect(await f.command()).toMatchObject({ execution: "cancelled", release: { seatId: "human_cfo", reason: "Worker killed before POST; bank shows no transfer" } });
    expect(await f.t.run(ctx => ctx.db.get(f.queued.versionId))).toMatchObject({ status: "cancelled", reservations: "released" });
    expect((await f.bill())!.reservedVersionId).toBeUndefined();
    const audit = await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "unsent_payment_released")).collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ seatId: "human_cfo", refs: { reason: "Worker killed before POST; bank shows no transfer", providerCheck: { lookup: "not_found", scanComplete: true } } });
    // The bill can now be paid by a fresh, separately approved payment.
    await f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "replacement", billIds: [f.queued.billId], credits: [] });
    expect(await f.dispatcher.tick()).toEqual({ dispatched: false }); // The released command is never claimed again.
    expect(f.bank.harness.inspect().calls.createTransfer ?? 0).toBe(0);
  });

  it("refuses an agent seat and a release before the safety window", async () => {
    const f = await crashedBeforeSend();
    await expect(f.service.release(await f.candidate(), "too early")).rejects.toThrow("safety window");
    const early = { lookup: "not_found" as const, searchedBy: "operation_key" as const, checkedAt: Date.now(), scanComplete: true as const,
      scannedFrom: 0, transfersScanned: 0, transactionsScanned: 0, matchingTransferIds: [], matchingTransactionIds: [] };
    await expect(f.human.mutation(api.demoPayments.releaseUnsent, { scope: f.scope, commandId: f.queued.commandId, reason: "too early", providerCheck: early })).rejects.toThrow("safety window");
    await f.age(RELEASE_SAFETY_WINDOW_MS + 1000);
    // No human JWT: an agent or service process cannot release reservations.
    await expect(f.t.mutation(api.demoPayments.releaseUnsent, { scope: f.scope, commandId: f.queued.commandId, reason: "agent", providerCheck: early })).rejects.toThrow("authenticated human");
    // A check made before the window ended, or a stale one, does not count.
    const firstAttemptAt = (await f.command()).firstAttemptAt!;
    await expect(f.human.mutation(api.demoPayments.releaseUnsent, { scope: f.scope, commandId: f.queued.commandId, reason: "stale",
      providerCheck: { ...early, checkedAt: firstAttemptAt + 1000 } })).rejects.toThrow("stale");
    await expect(f.human.mutation(api.demoPayments.releaseUnsent, { scope: f.scope, commandId: f.queued.commandId, reason: "match",
      providerCheck: { ...early, matchingTransactionIds: ["txn_x"] } })).rejects.toThrow("possible matching transfer");
    expect((await f.command()).execution).toBe("exception");
  });

  it("refuses when the provider shows a transfer for the command", async () => {
    const f = await crashedBeforeSend();
    await f.age(RELEASE_SAFETY_WINDOW_MS + 1000);
    // The POST did land after all (for example a lagging lookup); release must not proceed.
    const late = await f.bank.provider.createTransfer((await f.command()).command);
    await expect(f.service.release(await f.candidate(), "looks unsent")).rejects.toThrow(`Provider shows transfer ${late.id}`);
    // A same-amount transfer to the beneficiary under another key is also a possible send.
    const lookupMiss = { ...f.bank.provider, lookupTransfer: async (command: Parameters<PaymentRail["lookupTransfer"]>[0]) =>
      ({ scope: command.scope, commandId: command.commandId, idempotencyKey: command.idempotencyKey, requestHash: command.requestHash, checkedAt: Date.now(), kind: "not_found" as const, searchedBy: "operation_key" as const }) };
    await expect(new ReleaseUnsentPayment(f.humanCommands, lookupMiss).release(await f.candidate(), "looks unsent")).rejects.toThrow("possible matching transfer");
    expect(await f.command()).toMatchObject({ execution: "exception" });
    expect((await f.bill())!.reservedVersionId).toBe(f.queued.versionId);
  });

  it("flags a transfer that appears after release and never posts it", async () => {
    const f = await crashedBeforeSend();
    await f.age(RELEASE_SAFETY_WINDOW_MS + 1000);
    await f.service.release(await f.candidate(), "No transfer at the bank");
    // The original POST surfaces later anyway, and settles.
    const late = await f.bank.provider.createTransfer((await f.command()).command);
    f.bank.harness.settle(late.id);
    const worker = new EvidenceWorker(f.t as unknown as KernelTransport, f.scope, f.evidenceToken, f.bank.provider);
    const result = await worker.tick();
    expect(result.posted).toBe(0);
    expect(await f.command()).toMatchObject({ execution: "cancelled", lateTransferId: late.id });
    const journal = await f.t.run(ctx => ctx.db.query("journalEntries").collect());
    expect(journal.filter(entry => entry.lines.some(line => line.account === "1000"))).toEqual([]);
    const transactions = await f.t.run(ctx => ctx.db.query("demoTransactions").collect());
    expect(transactions).toEqual([expect.objectContaining({ state: "exception" })]);
    expect(transactions[0]!.entryId).toBeUndefined();
    const blockers = (await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers;
    expect(blockers).toContainEqual(expect.objectContaining({ kind: "payment", reason: expect.stringContaining("after operator release") }));
    expect(await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "released_payment_transfer_appeared")).collect())).toHaveLength(1);
    expect((await worker.tick()).posted).toBe(0);
    expect(await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "released_payment_transfer_appeared")).collect())).toHaveLength(1);
  });
});
