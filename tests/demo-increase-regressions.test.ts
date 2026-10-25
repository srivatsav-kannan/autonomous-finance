import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { api, demoFixture } from "./demo-fixture";
import fixtures from "../src/integrations/fixtures/increase/lifecycle.json";
import { IncreaseSandboxBank, verifyIncreaseWebhook } from "../src/integrations/banking/increase";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { increaseMock, increaseRun } from "./helpers/increase-mock";

afterEach(() => vi.unstubAllEnvs());

async function fundedFixture() {
  const f = await demoFixture("review-ap50", { provider: "increase", environment: "sandbox", accountId: "account_demo" });
  await f.t.run(async ctx => {
    const config = await ctx.db.query("demoConfigs").first();
    await ctx.db.patch(config!._id, { beneficiary: { ...config!.beneficiary, externalAccountId: "external_account_vendor" } });
  });
  await f.queued(2500);
  const command = await f.t.run(async ctx => (await ctx.db.query("demoCommands").first())!.command);
  const transfer = { ...fixtures.settled, statement_descriptor: command.commandId, idempotency_key: command.idempotencyKey,
    created_at: "2026-10-23T00:01:00Z", settlement: { settled_at: "2026-10-23T00:02:00Z" } };
  const debit = { ...fixtures.debit, created_at: "2026-10-23T00:02:00Z" };
  const funding = { ...fixtures.unknown, id: "transaction_funding", amount: 100000,
    created_at: "2026-10-22T00:00:00Z", source: { category: "inbound_wire_transfer", inbound_wire_transfer: { id: "inbound_wire_transfer_funding" } } };
  const routes: Record<string, unknown> = {
    "/ach_transfers": transfer,
    "/ach_transfers/ach_transfer_demo": transfer,
    "/transactions/transaction_debit": debit,
    "/transactions/transaction_funding": funding,
    "/transactions": { data: [debit, funding], next_cursor: null },
  };
  const fetchMock: typeof fetch = async input => {
    const value = routes[new URL(String(input)).pathname];
    return new Response(JSON.stringify(value ?? {}), { status: value === undefined ? 404 : 200 });
  };
  const provider = new IncreaseSandboxBank({ scope: f.scope, apiKey: "test-only", fetch: fetchMock,
    resolveCommand: key => f.t.query(api.demoEvidence.resolveCommand, { scope: f.scope, token: f.evidenceToken, idempotencyKey: key }) });
  const transport = f.t as unknown as KernelTransport;
  const dispatcher = new PaymentDispatcher(transport, f.scope, f.dispatcherToken, provider, "review-dispatch");
  const worker = new EvidenceWorker(transport, f.scope, f.evidenceToken, provider);
  return { ...f, routes, provider, dispatcher, worker, debit, transfer, funding };
}

describe("Increase account evidence regressions", () => {
  it.each(["controller", "human"] as const)("expires the %s close signature after a later funding journal", async first => {
    const f = await fundedFixture();
    f.routes["/transactions"] = { data: [f.debit], next_cursor: null };
    await f.dispatcher.tick();
    expect(await f.worker.tick()).toEqual({ posted: 1, errors: [] });
    const sign = (actor: "controller" | "human") => actor === "controller"
      ? f.t.mutation(api.demoEvidence.signClose, { ...f.controller, period: "2026-10" })
      : f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" });
    const second = first === "controller" ? "human" : "controller";
    expect(await sign(first)).toEqual({ status: "open" });
    const before = (await f.t.run(ctx => ctx.db.query("periods").first()))!;
    f.routes["/transactions"] = { data: [f.debit, f.funding], next_cursor: null };
    expect((await f.worker.tick()).errors).toEqual(["Unmatched bank transaction"]);
    await expect(sign(second)).rejects.toThrow("AP close blocked");
    const approval = { scope: f.scope, transactionId: f.funding.id, expectedAmountCents: 100000, reason: "Newly received sandbox capital" };
    await f.human.mutation(api.demoEvidence.approveSandboxFunding, approval);
    expect(await sign(second)).toEqual({ status: "open" });
    const after = (await f.t.run(ctx => ctx.db.query("periods").first()))!;
    expect(after.closeSnapshotHash).not.toBe(before.closeSnapshotHash);
    expect(after.closedBy).toEqual([second === "human" ? "human_cfo" : "controller"]);
    expect((await f.human.mutation(api.demoEvidence.approveSandboxFunding, approval)).replayed).toBe(true);
    expect(await f.worker.tick()).toEqual({ posted: 0, errors: [] });
    expect(await sign(first)).toEqual({ status: "closed" });
    expect((await f.t.run(ctx => ctx.db.query("periods").first()))!.closeSnapshotHash).toBe(after.closeSnapshotHash);
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(3);
    expect(await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "sandbox_funding_approved")).collect())).toHaveLength(1);
  });

  it("reconciles explicitly approved funding, pays once and closes with both signatures", async () => {
    const f = await fundedFixture();
    await f.t.mutation(api.demoEvidence.ingestNotice, { scope: f.scope, token: f.evidenceToken, eventId: "event_funding", transactionId: "transaction_funding", bodyHash: "b".repeat(64) });
    expect((await f.dispatcher.tick()).providerTransferId).toBe("ach_transfer_demo");
    expect(await f.worker.tick()).toEqual({ posted: 1, errors: ["Unmatched bank transaction"] });
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review.commands[0]).toMatchObject({ execution: "settled", posting: "posted", reconciliation: "matched" });
    const evidence = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(evidence.transactions).toHaveLength(2);
    expect(evidence.blockers).toEqual([{ kind: "transaction", id: "transaction_funding", reason: "Unmatched bank transaction" }]);
    const approval = { scope: f.scope, transactionId: "transaction_funding", expectedAmountCents: 100000, reason: "Verified sandbox capital wire" };
    await expect(f.t.mutation(api.demoEvidence.approveSandboxFunding, approval)).rejects.toThrow("authenticated human");
    await expect(f.human.mutation(api.demoEvidence.approveSandboxFunding, { ...approval, expectedAmountCents: 99999 })).rejects.toThrow("exact amount");
    await expect(f.human.mutation(api.demoEvidence.approveSandboxFunding, { ...approval, transactionId: f.debit.id, expectedAmountCents: 2500 })).rejects.toThrow("funding wire");
    const funded = await f.human.mutation(api.demoEvidence.approveSandboxFunding, approval);
    expect(await f.human.mutation(api.demoEvidence.approveSandboxFunding, approval)).toEqual({ ...funded, replayed: true });
    expect(await f.worker.tick()).toEqual({ posted: 0, errors: [] });
    const explained = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(explained.transactions).toHaveLength(2);
    expect(explained.transactions.every(tx => tx.entryId)).toBe(true);
    expect(explained.blockers).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("demoInbox").first())).toMatchObject({ eventId: "event_funding", processed: true });
    const journal = await f.t.run(ctx => ctx.db.query("journalEntries").collect());
    expect(journal).toHaveLength(3); // Accrual, one bank debit and the approved funding.
    const balances = await f.t.run(ctx => ctx.db.query("balances").collect());
    const cash = balances.filter(b => b.account === "1000");
    expect(cash.reduce((n, b) => n + b.debits - b.credits, 0)).toBe(97500);
    expect(await f.t.mutation(api.demoEvidence.signClose, { ...f.controller, period: "2026-10" })).toEqual({ status: "open" });
    expect(await f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" })).toEqual({ status: "closed" });
  });

  it("preserves a valid unrelated ACH collection while posting this payable", async () => {
    const f = await fundedFixture();
    f.routes["/ach_transfers/ach_transfer_collection"] = { ...f.transfer, id: "ach_transfer_collection", amount: -10000,
      idempotency_key: "another-flow", transaction_id: "transaction_collection" };
    const collection = { ...f.debit, id: "transaction_collection", amount: 10000,
      source: { category: "ach_transfer_intention", ach_transfer_intention: { transfer_id: "ach_transfer_collection" } } };
    f.routes["/transactions"] = { data: [f.debit, collection], next_cursor: null };
    await f.dispatcher.tick();
    expect((await f.worker.tick()).posted).toBe(1);
    const evidence = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(evidence.transactions).toHaveLength(2);
    expect(evidence.transactions.find(t => t.transaction.id === "transaction_collection")!.transaction).toMatchObject({ amountCents: 10000, purpose: "other", commandId: "" });
    expect(evidence.blockers).toContainEqual({ kind: "transaction", id: "transaction_collection", reason: "Unmatched bank transaction" });
    await expect(f.human.mutation(api.demoEvidence.approveSandboxFunding, { scope: f.scope, transactionId: "transaction_collection", expectedAmountCents: 10000, reason: "Not a funding wire" })).rejects.toThrow("funding wire");
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review.commands[0]!.posting).toBe("posted");
  });

  it.each(["ach_transfer", "transaction"])("audits a verified foreign %s notification without blocking this account", async resourceType => {
    const f = await fundedFixture();
    f.routes["/transactions"] = { data: [f.debit], next_cursor: null };
    f.routes["/ach_transfers/ach_transfer_foreign"] = { ...f.transfer, id: "ach_transfer_foreign", account_id: "account_foreign" };
    f.routes["/transactions/transaction_foreign"] = { ...f.debit, id: "transaction_foreign", account_id: "account_foreign" };
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const secret = "test-webhook-secret";
    const rawBody = Buffer.from(JSON.stringify({ ...fixtures.event, id: "event_foreign", associated_object_type: resourceType, associated_object_id: resourceType === "ach_transfer" ? "ach_transfer_foreign" : "transaction_foreign" }));
    const headers = { "webhook-id": "event_foreign", "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`event_foreign.${timestamp}.`).update(rawBody).digest("base64")}` };
    const verifier = { verifyWebhook: async (raw: Uint8Array, h: Record<string,string>) => verifyIncreaseWebhook({ rawBody: raw, headers: h, scope: f.scope, signingSecret: secret, now }) };
    await f.worker.receive(rawBody, headers, verifier);
    await f.dispatcher.tick();
    expect((await f.worker.tick()).errors).toEqual([]);
    expect((await f.worker.tick()).errors).toEqual([]);
    const evidence = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(evidence.blockers).toEqual([]);
    expect(await f.worker.receive(rawBody, headers, verifier)).toEqual({ duplicate: true });
    expect((await f.worker.tick()).errors).toEqual([]);
    const inbox = await f.t.run(ctx => ctx.db.query("demoInbox").collect());
    expect(inbox[0]).toMatchObject({ processed: true, ignoredResource: { resourceType, accountId: "account_foreign" } });
    expect(await f.t.run(ctx => ctx.db.query("activity").filter(q => q.eq(q.field("kind"), "notification_ignored_out_of_scope")).collect())).toHaveLength(1);
  });
});

it.each(["missing", "wrong-identity", "foreign-nested-transaction"])("keeps %s notification failures unresolved", async failure => {
  const f = await fundedFixture();
  f.routes["/transactions"] = { data: [], next_cursor: null };
  const transferId = failure === "missing" ? "ach_transfer_missing" : "ach_transfer_demo";
  if (failure === "wrong-identity") f.routes["/ach_transfers/ach_transfer_demo"] = { ...f.transfer, id: "ach_transfer_wrong", account_id: "account_foreign" };
  if (failure === "foreign-nested-transaction") f.routes["/transactions/transaction_debit"] = { ...f.debit, account_id: "account_foreign" };
  await f.t.mutation(api.demoEvidence.ingestNotice, { scope: f.scope, token: f.evidenceToken, eventId: "event_unresolved", transferId, bodyHash: "a".repeat(64) });
  await f.worker.tick();
  const inbox = await f.t.run(ctx => ctx.db.query("demoInbox").first());
  expect(inbox).toMatchObject({ processed: false });
  expect(inbox!.ignoredResource).toBeUndefined();
  expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers.some(b => b.id === "event_unresolved")).toBe(true);
});

it("keeps unselected funding unexplained and rolls back a failed funding journal", async () => {
  const f = await fundedFixture();
  const extra = { ...f.funding, id: "transaction_unselected", amount: 8000 };
  f.routes["/transactions"] = { data: [f.debit, f.funding, extra], next_cursor: null };
  await f.dispatcher.tick();
  await f.worker.tick();
  await f.t.run(async ctx => {
    const period = (await ctx.db.query("periods").first())!;
    await ctx.db.patch(period._id, { status: "closed" });
  });
  const args = { scope: f.scope, transactionId: "transaction_funding", expectedAmountCents: 100000, reason: "Reviewed wire" };
  await expect(f.human.mutation(api.demoEvidence.approveSandboxFunding, args)).rejects.toThrow("Funding posting blocked");
  let funding = await f.t.run(ctx => ctx.db.query("demoTransactions").filter(q => q.eq(q.field("transaction.id"), "transaction_funding")).first());
  expect(funding!.fundingApproval).toBeUndefined();
  expect(funding!.entryId).toBeUndefined();
  await f.t.run(async ctx => {
    const period = (await ctx.db.query("periods").first())!;
    await ctx.db.patch(period._id, { status: "open" });
  });
  await f.human.mutation(api.demoEvidence.approveSandboxFunding, args);
  const evidence = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
  expect(evidence.blockers).toEqual([{ kind: "transaction", id: "transaction_unselected", reason: "Unmatched bank transaction" }]);
});

// #74: the sandbox demo must work more than once per Increase account.
describe("reused Increase account", () => {
  const cashFor = (journal: { runId: string; lines: { account: string; debit: number; credit: number }[] }[], runId: string) =>
    journal.filter(entry => entry.runId === runId).flatMap(entry => entry.lines).filter(line => line.account === "1000");
  async function closeBoth(run: Awaited<ReturnType<typeof increaseRun>>) {
    expect(await run.t.mutation(api.demoEvidence.signClose, { ...run.controller, period: "2026-10" })).toEqual({ status: "open" });
    expect(await run.human.mutation(api.demoEvidence.signClose, { scope: run.scope, period: "2026-10" })).toEqual({ status: "closed" });
  }

  it("closes a second run without blockers and never posts the first run's debit in it", async () => {
    const mock = increaseMock(); // Ignores created_at filters: the worst case of a full history rescan.
    mock.setClock("2026-10-22T10:00:00Z");
    const run1 = await increaseRun("reuse-run-1", mock, { activitySince: "2026-10-22T00:00:00Z" });
    await run1.queued(2500);
    const first = (await run1.dispatcher.tick()).providerTransferId!;
    const firstDebit = mock.settle(first, "2026-10-22T10:05:00Z");
    expect(await run1.worker.tick()).toEqual({ posted: 1, errors: [] });
    await closeBoth(run1);

    // Same deployment and bank account; the operator rebinds AP_BANK_SCOPE to the fresh run.
    mock.setClock("2026-10-24T10:00:00Z");
    const run2 = await increaseRun("reuse-run-2", mock, { t: run1.t, activitySince: "2026-10-24T00:00:00Z" });
    await run2.queued(4000);
    const second = (await run2.dispatcher.tick()).providerTransferId!;
    mock.settle(second, "2026-10-24T10:05:00Z");
    expect(await run2.worker.tick()).toEqual({ posted: 1, errors: [] });
    expect(await run2.worker.tick()).toEqual({ posted: 0, errors: [] });

    const evidence = await run2.human.query(api.demoEvidence.humanView, { scope: run2.scope });
    expect(evidence.blockers).toEqual([]);
    const prior = evidence.transactions.find(row => row.transaction.id === firstDebit)!;
    expect(prior).toMatchObject({ state: "prior_activity", transaction: { purpose: "other", commandId: "", transferId: first } });
    expect(prior.entryId).toBeUndefined();
    const journal = await run2.t.run(ctx => ctx.db.query("journalEntries").collect());
    // Run 2 holds its accrual and exactly its own debit; run 1's debit is never cash in run 2.
    expect(journal.filter(entry => entry.runId === "reuse-run-2")).toHaveLength(2);
    expect(cashFor(journal, "reuse-run-2")).toEqual([expect.objectContaining({ debit: 0, credit: 4000 })]);
    expect(cashFor(journal, "reuse-run-1")).toEqual([expect.objectContaining({ debit: 0, credit: 2500 })]);
    // The worker also asks Increase to start the scan at the run's boundary.
    expect(mock.requests.some(({ url }) => url.pathname === "/transactions" &&
      url.searchParams.get("created_at.on_or_after") === "2026-10-24T00:00:00Z")).toBe(true);
    await closeBoth(run2);
  });

  it("still blocks a genuinely unexplained debit created during the current run", async () => {
    const mock = increaseMock();
    mock.setClock("2026-10-24T10:00:00Z");
    const run = await increaseRun("reuse-unexplained", mock, { activitySince: "2026-10-24T00:00:00Z" });
    await run.queued(2500);
    mock.settle((await run.dispatcher.tick()).providerTransferId!, "2026-10-24T10:05:00Z");
    mock.addTransaction({ ...fixtures.unknown, id: "transaction_current", created_at: "2026-10-24T11:00:00Z" });
    mock.addTransaction({ ...fixtures.unknown, id: "transaction_history", created_at: "2026-10-20T11:00:00Z" });
    mock.addTransaction({ ...fixtures.unknown, id: "transaction_wire", amount: 100000, created_at: "2026-10-20T09:00:00Z",
      source: { category: "inbound_wire_transfer", inbound_wire_transfer: { id: "inbound_wire_transfer_funding" } } });
    expect((await run.worker.tick()).posted).toBe(1);
    const evidence = await run.human.query(api.demoEvidence.humanView, { scope: run.scope });
    expect(evidence.blockers).toEqual([{ kind: "transaction", id: "transaction_current", reason: "Unmatched bank transaction" }]);
    expect(evidence.transactions.find(row => row.transaction.id === "transaction_history")!.state).toBe("prior_activity");
    await expect(run.human.mutation(api.demoEvidence.signClose, { scope: run.scope, period: "2026-10" })).rejects.toThrow("AP close blocked");
    // Explicitly reviewed capital from before the run can still be classified, as demo:sandbox does.
    await run.human.mutation(api.demoEvidence.approveSandboxFunding, { scope: run.scope, transactionId: "transaction_wire", expectedAmountCents: 100000, reason: "Reviewed capital" });
    const wire = (await run.human.query(api.demoEvidence.humanView, { scope: run.scope })).transactions.find(row => row.transaction.id === "transaction_wire")!;
    expect(wire).toMatchObject({ state: "posted", fundingApproval: { reason: "Reviewed capital" } });
  });

  it("rejects a malformed activity boundary at configuration", async () => {
    await expect(demoFixture("reuse-bad-boundary", {}, { activitySince: "yesterday" })).rejects.toThrow("activitySince");
  });
});
