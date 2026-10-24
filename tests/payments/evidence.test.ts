import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../demo-fixture";
import { PaymentDispatcher } from "../../src/payments/dispatcher";
import { EvidenceWorker, type KernelTransport } from "../../src/payments/evidence";
import { recoveryFixture } from "./fixtures";
import { commandRequestHash, type BankCommand } from "../../src/payments/contracts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); });
async function fixture() {
  const f = await recoveryFixture(); cleanup.push(f.dispose);
  const transport = f.t as KernelTransport;
  return { ...f, dispatcher: new PaymentDispatcher(transport, f.scope, f.dispatcherToken, f.provider, "independent-evidence"),
    evidence: new EvidenceWorker(transport, f.scope, f.evidenceToken, f.provider) };
}
const cashEntries = (rows: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["state"]>>) => rows.journals.filter(entry => entry.lines.some(line => line.account === "1000"));

describe("independent economic evidence acceptance", () => {
  it("retains verified account activity with no local payment as visible unresolved evidence", async () => {
    const f = await fixture();
    const request = { commandId: "external-operation", approvalVersion: "external-approval", scope: f.scope,
      amountCents: 2000, currency: "USD" as const, destination: { externalAccountId: "external-beneficiary", version: "external-v1" },
      idempotencyKey: "outside-application-operation" };
    const command: BankCommand = { ...request, requestHash: await commandRequestHash(request) };
    const observation = await f.provider.createTransfer(command);
    const notice = f.bank.harness.drainNotifications()[0]!;
    await f.evidence.receive(notice.rawBody, notice.headers, f.bank.events);
    expect((await f.evidence.tick()).posted).toBe(0);
    const pending = await f.state();
    expect(pending.observations).toEqual([expect.objectContaining({ transferId: observation.id, observation })]);
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: observation.id })]));
    expect(pending.commands).toEqual([]); expect(pending.journals).toEqual([]);
    f.bank.harness.settle(observation.id);
    expect((await f.evidence.tick()).posted).toBe(0);
    const settled = await f.state();
    expect(settled.transactions).toHaveLength(1);
    expect(settled.transactions[0]?.entryId).toBeUndefined();
    expect(settled.journals).toEqual([]);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("acceptance and duplicate reconciliation leave bills unpaid and cash untouched until the bank posts", async () => {
    const f = await fixture(); const q = await f.queued();
    const result = await f.dispatcher.tick();
    expect(result.providerTransferId).toBeTruthy();
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const pending = await f.state();
    expect(cashEntries(pending)).toEqual([]);
    expect(pending.bills[0]).toMatchObject({ paidCents: 0, status: "approved", reservedVersionId: q.versionId });
    expect(pending.commands[0]).toMatchObject({ execution: "pending", posting: "unposted", reconciliation: "unmatched" });
    expect(pending.versions[0]).toMatchObject({ reservations: "reserved" });
    const settled = f.bank.harness.settle(result.providerTransferId!);
    f.bank.harness.drainNotifications({ drop: true });
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const posted = await f.state();
    expect(cashEntries(posted)).toHaveLength(1);
    expect(posted.transactions[0]).toMatchObject({ transaction: { id: settled.originalTransactionId }, entryId: cashEntries(posted)[0]!._id, state: "posted" });
    expect(posted.bills[0]).toMatchObject({ paidCents: 10_000, status: "paid" });
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("retries failed local accounting atomically without another send or consuming credit twice", async () => {
    const f = await fixture();
    const { creditId } = await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "independent-credit", amountCents: 2500, evidence: "reviewed-credit", date: "2026-10-23", expenseAccount: "5000" });
    const q = await f.queued(10_000, [{ creditId, amountCents: 2500 }]);
    const sent = await f.dispatcher.tick(); f.bank.harness.settle(sent.providerTransferId!);
    await f.t.run(ctx => ctx.db.patch(q.billId, { reservedVersionId: undefined }));
    const before = await f.state();
    const failedTick = await f.evidence.tick();
    expect(failedTick.posted).toBe(0);
    expect(failedTick.errors).toEqual([expect.stringMatching(/reservation ownership/i)]);
    const failed = await f.state();
    for (const field of ["journals", "balances", "heads", "bills", "credits", "versions"] as const) expect(failed[field]).toEqual(before[field]);
    expect(failed.transactions[0]).toMatchObject({ state: "exception" });
    expect(failed.transactions[0]?.entryId).toBeUndefined();
    expect(failed.commands[0]).toMatchObject({ execution: "settled", posting: "unposted" });
    expect(await f.dispatcher.tick()).toEqual({ dispatched: false });
    await f.t.run(ctx => ctx.db.patch(q.billId, { reservedVersionId: q.versionId }));
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const recovered = await f.state();
    expect(cashEntries(recovered)).toHaveLength(1);
    expect(recovered.credits[0]).toMatchObject({ consumedCents: 2500, reservedCents: 0 });
    expect(recovered.bills[0]).toMatchObject({ paidCents: 10_000, status: "paid" });
    expect(f.bank.harness.inspect().transfers).toHaveLength(1);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("posts return-first deliveries as two linked economic effects and cannot regress with a delayed acceptance", async () => {
    const f = await fixture(); const q = await f.queued(); const sent = await f.dispatcher.tick();
    const pending = await f.provider.getTransfer(f.scope, sent.providerTransferId!);
    f.bank.harness.settle(sent.providerTransferId!);
    const returned = f.bank.harness.returnTransfer(sent.providerTransferId!);
    for (const event of f.bank.harness.drainNotifications({ reverse: true, duplicate: true })) await f.evidence.receive(event.rawBody, event.headers, f.bank.events);
    expect(await f.evidence.tick()).toEqual({ posted: 2, errors: [] });
    await f.t.mutation(api.demoEvidence.observeTransfer, { scope: f.scope, token: f.evidenceToken, observation: pending, transactions: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const rows = await f.state();
    expect(rows.commands[0]).toMatchObject({ execution: "returned", posting: "returned", reconciliation: "matched" });
    expect(rows.transactions).toHaveLength(2);
    const original = rows.transactions.find(row => row.transaction.purpose === "debit")!;
    const reversal = rows.transactions.find(row => row.transaction.purpose === "return")!;
    expect(original.transaction).toMatchObject({ id: returned.originalTransactionId, amountCents: -10_000 });
    expect(reversal.transaction).toMatchObject({ id: returned.returnTransactionId, amountCents: 10_000, originalTransactionId: original.transaction.id });
    expect(new Set([original.entryId, reversal.entryId]).size).toBe(2);
    expect(cashEntries(rows)).toHaveLength(2);
    expect(rows.balances.find(balance => balance.account === "1000")).toMatchObject({ debits: 10_000, credits: 10_000 });
    expect(rows.bills.find(bill => bill._id === q.billId)).toMatchObject({ paidCents: 0, status: "approved" });
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });
});
