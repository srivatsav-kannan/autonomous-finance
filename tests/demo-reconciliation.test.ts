import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { commandRequestHash, type BankCommand } from "../src/integrations/contracts";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";
import { PaymentDispatcher } from "../src/payments/dispatcher";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); });
async function fixture() {
  const f = await demoFixture(); const dir = mkdtempSync(join(tmpdir(), "ap-reconciliation-"));
  const bank = openFakeBank({ path: join(dir, "bank.sqlite"), scope: f.scope, seed: 7, startTime: "2026-10-23T00:00:00.000Z" });
  cleanup.push(() => { bank.close(); rmSync(dir, { recursive: true, force: true }); });
  const transport = f.t as unknown as KernelTransport;
  const evidence = new EvidenceWorker(transport, f.scope, f.evidenceToken, bank.provider);
  const dispatcher = new PaymentDispatcher(transport, f.scope, f.dispatcherToken, bank.provider, "dispatcher-1");
  const service = { scope: f.scope, token: f.evidenceToken };
  const state = () => f.t.run(async ctx => ({
    commands: await ctx.db.query("demoCommands").collect(), transactions: await ctx.db.query("demoTransactions").collect(),
    inbox: await ctx.db.query("demoInbox").collect(), observations: await ctx.db.query("demoObservations").collect(),
    journals: await ctx.db.query("journalEntries").collect(), balances: await ctx.db.query("balances").collect(),
    heads: await ctx.db.query("ledgerHeads").collect(), cursors: await ctx.db.query("demoCursors").collect(),
    bills: await ctx.db.query("demoBills").collect(), credits: await ctx.db.query("demoCredits").collect(), versions: await ctx.db.query("demoVersions").collect(),
  }));
  return { ...f, bank, evidence, dispatcher, service, state };
}

describe("verified AP evidence and reconciliation", () => {
  it("recovers a missing webhook by polling and links one debit to one cash journal", async () => {
    const f = await fixture(); await f.queued();
    const sent = await f.dispatcher.tick(); expect(sent.providerTransferId).toBeTruthy();
    const settled = f.bank.harness.settle(sent.providerTransferId!);
    expect(f.bank.harness.drainNotifications({ drop: true })).toEqual([]);
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const rows = await f.state();
    expect(rows.journals).toHaveLength(2); // One invoice accrual and one evidenced cash settlement.
    expect(rows.journals.filter(entry => entry.lines.some(line => line.account === "1000"))).toHaveLength(1);
    expect(rows.transactions).toHaveLength(1);
    expect(rows.transactions[0]).toMatchObject({ transaction: { id: settled.originalTransactionId }, state: "posted", entryId: rows.journals[1]!._id });
    expect(rows.transactions[0]!.matchedAt).toBeDefined();
    expect(rows.commands[0]).toMatchObject({ execution: "settled", posting: "posted", reconciliation: "matched" });
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers).toEqual([]);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("handles duplicate, reordered, return-first hints and keeps applied credits consumed", async () => {
    const f = await fixture();
    const { creditId } = await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "credit-1", amountCents: 2500, evidence: "credit-note:1", date: "2026-10-23", expenseAccount: "5000" });
    const queued = await f.queued(10_000, [{ creditId, amountCents: 2500 }]);
    const sent = await f.dispatcher.tick(); f.bank.harness.settle(sent.providerTransferId!); const returned = f.bank.harness.returnTransfer(sent.providerTransferId!);
    const deliveries = f.bank.harness.drainNotifications({ duplicate: true, reverse: true }); expect(deliveries).toHaveLength(6);
    for (const delivery of deliveries) await f.evidence.receive(delivery.rawBody, delivery.headers, f.bank.events);
    expect(await f.evidence.tick()).toEqual({ posted: 2, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    const rows = await f.state();
    expect(rows.inbox).toHaveLength(3); expect(rows.inbox.every(notice => notice.processed)).toBe(true);
    expect(rows.transactions).toHaveLength(2); expect(rows.transactions.every(tx => tx.entryId && tx.matchedAt)).toBe(true);
    expect(new Set(rows.transactions.map(tx => tx.transaction.id))).toEqual(new Set([returned.originalTransactionId, returned.returnTransactionId]));
    expect(rows.journals).toHaveLength(4); // Invoice, approved credit, original debit, separate return.
    expect(rows.balances.find(balance => balance.account === "1000")).toMatchObject({ debits: 7500, credits: 7500 });
    expect(rows.credits[0]).toMatchObject({ consumedCents: 2500, reservedCents: 0 });
    expect(rows.bills.find(bill => bill._id === queued.billId)).toMatchObject({ paidCents: 2500, status: "approved" });
    expect(rows.commands[0]).toMatchObject({ execution: "returned", posting: "returned", reconciliation: "matched" });
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers.some((blocker: { kind: string }) => blocker.kind === "bill")).toBe(true);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("rolls back failed local posting after journal construction and retries without a bank resend", async () => {
    const f = await fixture(); const queued = await f.queued(); const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!); f.bank.harness.drainNotifications({ drop: true });
    // A corrupted reservation forces failure after appendEntry has attempted all journal/balance writes.
    await f.t.run(async ctx => { await ctx.db.patch(queued.billId, { reservedVersionId: undefined }); });
    const before = await f.state(); const failure = await f.evidence.tick();
    expect(failure.posted).toBe(0); expect(failure.errors.some(message => message.includes("reservation ownership"))).toBe(true);
    const failed = await f.state();
    expect(failed.journals).toEqual(before.journals); expect(failed.balances).toEqual(before.balances); expect(failed.heads).toEqual(before.heads);
    expect(failed.transactions[0]).toMatchObject({ state: "exception" }); expect(failed.transactions[0]!.entryId).toBeUndefined();
    expect(failed.commands[0]).toMatchObject({ execution: "settled", posting: "unposted" });
    expect(await f.dispatcher.tick()).toEqual({ dispatched: false });
    await f.t.run(async ctx => { await ctx.db.patch(queued.billId, { reservedVersionId: queued.versionId }); });
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
    expect((await f.state()).journals).toHaveLength(2);
  });

  it("imports a page and its checkpoint atomically and safely replays after a failed import", async () => {
    const f = await fixture(); await f.queued(); const sent = await f.dispatcher.tick(); f.bank.harness.settle(sent.providerTransferId!);
    const page = await f.bank.provider.listTransactions(f.scope); const tx = page.items[0]!;
    const invalid = { ...tx, id: "bad-foreign-tx", scope: { ...f.scope, accountId: "another-account" } };
    await expect(f.t.mutation(api.demoEvidence.importPage, { ...f.service, expectedCursor: null, cursor: page.cursor, transactions: [tx, invalid] })).rejects.toThrow("scope mismatch");
    expect((await f.state()).transactions).toHaveLength(0); expect((await f.state()).cursors).toHaveLength(0);
    expect(await f.t.mutation(api.demoEvidence.importPage, { ...f.service, expectedCursor: null, cursor: page.cursor, transactions: page.items })).toEqual({ stale: false });
    expect(await f.t.mutation(api.demoEvidence.importPage, { ...f.service, expectedCursor: null, cursor: "incorrect-stale-checkpoint", transactions: [] })).toEqual({ stale: true });
    await f.t.mutation(api.demoEvidence.importPage, { ...f.service, expectedCursor: page.cursor, cursor: page.cursor, transactions: page.items });
    const imported = await f.state(); expect(imported.transactions).toHaveLength(1); expect(imported.cursors[0]!.cursor).toBe(page.cursor);
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect((await f.state()).transactions).toHaveLength(1);
  });

  it("deduplicates concurrent financial posting separately from notification identity conflicts", async () => {
    const f = await fixture(); await f.queued(); const sent = await f.dispatcher.tick();
    const settled = f.bank.harness.settle(sent.providerTransferId!);
    const tx = await f.bank.provider.getTransaction(f.scope, settled.originalTransactionId!);
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: settled, transactions: [tx] });
    const results = await Promise.all(Array.from({ length: 6 }, () => f.t.mutation(api.demoEvidence.postTransaction, { ...f.service, transactionId: tx.id })));
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map(result => result.entryId)).size).toBe(1);
    expect((await f.state()).journals).toHaveLength(2);
    const notice = { ...f.service, eventId: "duplicate-event", transferId: settled.id, bodyHash: "a".repeat(64) };
    expect(await f.t.mutation(api.demoEvidence.ingestNotice, notice)).toEqual({ duplicate: false });
    expect(await f.t.mutation(api.demoEvidence.ingestNotice, notice)).toEqual({ duplicate: true });
    await expect(f.t.mutation(api.demoEvidence.ingestNotice, { ...notice, bodyHash: "b".repeat(64) })).rejects.toThrow("payload conflict");
    expect((await f.state()).inbox).toHaveLength(1);
    expect((await f.state()).inbox[0]!.bodyHash).toBe(notice.bodyHash);
  });

  it("persists an early authenticated hint before the dispatch response and fences stale completion", async () => {
    const f = await fixture(); await f.queued();
    const dispatchAuth = { scope: f.scope, token: f.dispatcherToken };
    const claim = await f.t.mutation(api.demoPayments.claim, { ...dispatchAuth, workerId: "worker-before-response", leaseToken: "unique-first-worker-lease" });
    assert(claim);
    const transfer = await f.bank.provider.createTransfer(claim.command);
    const notice = f.bank.harness.drainNotifications()[0]!;
    await f.evidence.receive(notice.rawBody, notice.headers, f.bank.events);
    expect((await f.state()).inbox[0]!.processed).toBe(false);
    expect(await f.evidence.tick()).toEqual({ posted: 0, errors: [] });
    expect((await f.state()).commands[0]).toMatchObject({ execution: "pending", providerTransferId: transfer.id });
    await expect(f.t.mutation(api.demoPayments.complete, { ...dispatchAuth, commandId: claim.commandId, generation: claim.generation, leaseToken: claim.leaseToken, providerTransferId: transfer.id })).rejects.toThrow();
    f.bank.harness.settle(transfer.id);
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    expect(f.bank.harness.inspect().transfers).toHaveLength(1);
  });

  it("rejects unauthorized/cross-account evidence and signed-body tampering before posting", async () => {
    const f = await fixture(); await f.queued(); const sent = await f.dispatcher.tick(); const transfer = f.bank.harness.settle(sent.providerTransferId!);
    const tx = await f.bank.provider.getTransaction(f.scope, transfer.originalTransactionId!); const delivery = f.bank.harness.drainNotifications()[0]!;
    await expect(f.evidence.receive(Buffer.from("{}"), delivery.headers, f.bank.events)).rejects.toThrow("signature");
    expect((await f.state()).inbox).toHaveLength(0);
    for (const token of [f.ap.token, f.payments.token, f.controller.token, f.dispatcherToken]) {
      await expect(f.t.mutation(api.demoEvidence.importPage, { scope: f.scope, token, expectedCursor: null, cursor: "x", transactions: [tx] })).rejects.toThrow("credential");
      await expect(f.t.mutation(api.demoEvidence.observeTransfer, { scope: f.scope, token, observation: transfer, transactions: [tx] })).rejects.toThrow("credential");
    }
    await expect(f.t.mutation(api.demoEvidence.importPage, { ...f.service, scope: { ...f.scope, accountId: "other" }, expectedCursor: null, cursor: "x", transactions: [tx] })).rejects.toThrow("mismatch");
    await expect(f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: { ...transfer, amountCents: 1 }, transactions: [tx] })).rejects.toThrow("approved command");
    await expect(f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: transfer, transactions: [{ ...tx, scope: { ...f.scope, organizationId: "foreign" } }] })).rejects.toThrow("scope mismatch");
    expect((await f.state()).observations).toHaveLength(0); expect((await f.state()).transactions).toHaveLength(0);
    expect((await f.state()).journals).toHaveLength(1);
  });

  it("requires verified original evidence before posting a return", async () => {
    const f = await fixture(); await f.queued(); const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!); const returned = f.bank.harness.returnTransfer(sent.providerTransferId!);
    const returning = await f.bank.provider.getTransaction(f.scope, returned.returnTransactionId!);
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: returned, transactions: [returning] });
    await expect(f.t.mutation(api.demoEvidence.postTransaction, { ...f.service, transactionId: returning.id })).rejects.toThrow("original debit");
    expect((await f.state()).journals).toHaveLength(1);
    expect((await f.state()).credits).toHaveLength(0); expect((await f.state()).versions[0]!.reservations).toBe("reserved");
    expect(await f.evidence.tick()).toEqual({ posted: 2, errors: [] });
  });

  it("does not release reservations when a rejected observation contradicts imported cash evidence", async () => {
    const f = await fixture(); const queued = await f.queued(); const sent = await f.dispatcher.tick();
    const settled = f.bank.harness.settle(sent.providerTransferId!);
    const tx = await f.bank.provider.getTransaction(f.scope, settled.originalTransactionId!);
    await f.t.mutation(api.demoEvidence.importPage, { ...f.service, expectedCursor: null, cursor: "saved-bank-checkpoint", transactions: [tx] });
    const rejected = { ...settled, status: "rejected" as const, rejectionReason: "contradictory-provider-observation" };
    delete rejected.originalTransactionId;
    await expect(f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: rejected, transactions: [] })).rejects.toThrow();
    const rows = await f.state();
    expect(rows.versions[0]!.reservations).toBe("reserved");
    expect(rows.bills[0]!.reservedVersionId).toBe(queued.versionId);
    expect(rows.commands[0]!.execution).not.toBe("rejected");
    expect(rows.journals).toHaveLength(1);
    expect(rows.transactions[0]!.entryId).toBeUndefined();
  });

  it("retains unknown external activity as a close blocker, including pending transfers without cash", async () => {
    const f = await fixture();
    const request = { commandId: "unknown-command", scope: f.scope, amountCents: 2000, currency: "USD" as const, destination: { externalAccountId: "external-account-1", version: "beneficiary-v1" }, approvalVersion: "unknown-version", idempotencyKey: "external-command" };
    const command: BankCommand = { ...request, requestHash: await commandRequestHash(request) };
    const transfer = await f.bank.provider.createTransfer(command);
    const delivery = f.bank.harness.drainNotifications()[0]!; await f.evidence.receive(delivery.rawBody, delivery.headers, f.bank.events);
    expect((await f.evidence.tick()).posted).toBe(0);
    const pending = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(pending.blockers.some((blocker: { id: string }) => blocker.id === transfer.id)).toBe(true);
    f.bank.harness.settle(transfer.id);
    const result = await f.evidence.tick(); expect(result.posted).toBe(0); expect(result.errors.length).toBeGreaterThan(0);
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers.some((blocker: { kind: string }) => blocker.kind === "transaction")).toBe(true);
    expect((await f.state()).journals).toHaveLength(0);
  });

  it("prevents stale observations from regressing a returned transfer or deleting economic identities", async () => {
    const f = await fixture(); await f.queued(); const sent = await f.dispatcher.tick(); const pending = await f.bank.provider.getTransfer(f.scope, sent.providerTransferId!);
    const settled = f.bank.harness.settle(pending.id); const returned = f.bank.harness.returnTransfer(pending.id);
    expect(await f.evidence.tick()).toEqual({ posted: 2, errors: [] });
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: pending, transactions: [] });
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: settled, transactions: [] });
    expect((await f.state()).observations[0]!.observation).toEqual(returned);
    const missingIds = { ...returned }; delete missingIds.originalTransactionId; delete missingIds.returnTransactionId;
    await expect(f.t.mutation(api.demoEvidence.observeTransfer, { ...f.service, observation: missingIds, transactions: [] })).rejects.toThrow();
    expect((await f.state()).observations[0]!.observation).toEqual(returned);
    expect((await f.state()).journals).toHaveLength(3);
  });
});
