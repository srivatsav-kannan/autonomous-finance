import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./demo-fixture";
import { increaseMock, increaseRun } from "./helpers/increase-mock";
import { IncreaseSandboxBank } from "../src/integrations/banking/increase";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";

afterEach(() => vi.unstubAllEnvs());

// #75: one transaction that cannot be verified must not stall evidence for every payment.
async function threePayments(runId: string) {
  const mock = increaseMock();
  mock.setClock("2026-10-23T09:00:00Z");
  const run = await increaseRun(runId, mock);
  for (const amount of [1000, 2000, 3000]) await run.queued(amount);
  const transfers: string[] = [];
  for (let i = 0; i < 3; i++) transfers.push((await run.dispatcher.tick()).providerTransferId!);
  const rows = () => run.t.run(async ctx => ({
    journal: await ctx.db.query("journalEntries").collect(),
    transactions: await ctx.db.query("demoTransactions").collect(),
    retries: await ctx.db.query("demoEvidenceRetries").collect(),
    commands: await ctx.db.query("demoCommands").collect(),
  }));
  const cash = async () => (await rows()).journal.filter(entry => entry.lines.some(line => line.account === "1000"));
  return { ...run, mock, transfers, rows, cash };
}

describe("evidence worker isolates a failing bank transaction", () => {
  it("posts the rest of a page when the middle transaction's transfer lookup is rate limited, then retries it", async () => {
    const f = await threePayments("isolation-rate-limit");
    const debits = f.transfers.map((id, i) => f.mock.settle(id, `2026-10-23T10:0${i}:00Z`));
    // Newest-first page: debits[2], debits[1], debits[0]. Rate limit the middle row's transfer
    // for both its page lookup and this tick's transfer observation.
    f.mock.throttleTransfer(f.transfers[1]!, 2);
    const first = await f.worker.tick();
    expect(first.posted).toBe(2);
    expect(first.errors).toContain(`Bank transaction ${debits[1]} deferred: rate_limit`);
    let state = await f.rows();
    expect(state.transactions.map(row => row.transaction.id).sort()).toEqual([debits[0], debits[2]].sort());
    expect(state.retries).toEqual([expect.objectContaining({ transactionId: debits[1], open: true, errorClass: "rate_limit", attempts: 1 })]);
    expect((await f.cash()).map(entry => entry.lines.find(line => line.account === "1000")!.credit).sort()).toEqual([1000, 3000]);
    const blocked = await f.human.query(api.demoEvidence.humanView, { scope: f.scope });
    expect(blocked.blockers).toContainEqual({ kind: "transaction", id: debits[1], reason: "Bank evidence could not be verified (rate_limit); retrying" });

    // Later tick: the row is no longer on the first list page, so only the recorded retry finds it.
    f.mock.hidden.add(debits[1]!);
    await f.t.run(async ctx => { for (const retry of await ctx.db.query("demoEvidenceRetries").collect()) await ctx.db.patch(retry._id, { nextAttemptAt: 0 }); });
    expect(await f.worker.tick()).toEqual({ posted: 1, errors: [] });
    expect(f.mock.requests.some(({ method, url }) => method === "GET" && url.pathname === `/transactions/${debits[1]}`)).toBe(true);
    state = await f.rows();
    expect(state.retries).toEqual([expect.objectContaining({ transactionId: debits[1], open: false, resolvedAt: expect.any(Number) })]);
    expect(state.commands.every(c => c.execution === "settled" && c.posting === "posted")).toBe(true);
    expect(await f.cash()).toHaveLength(3);
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers).toEqual([]);
  });

  it("quarantines a debit posted before its transfer has settlement without blocking other payments", async () => {
    const f = await threePayments("isolation-unsettled");
    f.mock.settle(f.transfers[0]!, "2026-10-23T10:00:00Z");
    const early = f.mock.settle(f.transfers[1]!, "2026-10-23T10:01:00Z", false);
    f.mock.settle(f.transfers[2]!, "2026-10-23T10:02:00Z");
    const first = await f.worker.tick();
    expect(first.posted).toBe(2);
    expect(first.errors).toContain(`Bank transaction ${early} deferred: unknown`);
    let state = await f.rows();
    // Money safety: the unverified debit is neither imported nor journaled.
    expect(state.transactions.some(row => row.transaction.id === early)).toBe(false);
    expect(await f.cash()).toHaveLength(2);
    expect(state.retries).toEqual([expect.objectContaining({ transactionId: early, open: true, errorClass: "unknown" })]);
    await expect(f.human.mutation(api.demoEvidence.signClose, { scope: f.scope, period: "2026-10" })).rejects.toThrow("AP close blocked");

    expect((await f.worker.tick()).posted).toBe(0); // Still unsettled: still deferred, still not posted.
    expect(await f.cash()).toHaveLength(2);
    f.mock.completeSettlement(f.transfers[1]!, "2026-10-23T10:05:00Z");
    expect(await f.worker.tick()).toEqual({ posted: 1, errors: [] });
    state = await f.rows();
    expect(state.transactions.find(row => row.transaction.id === early)).toMatchObject({ state: "posted" });
    expect(state.retries.every(retry => !retry.open)).toBe(true);
    expect(await f.cash()).toHaveLength(3);
    expect((await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).blockers).toEqual([]);
  });

  it("keeps notices, observations and posting running when the whole transaction listing fails", async () => {
    const f = await threePayments("isolation-list-failure");
    f.transfers.forEach((id, i) => f.mock.settle(id, `2026-10-23T10:0${i}:00Z`));
    const fetch = f.mock.fetch;
    const failingList: typeof globalThis.fetch = async (input, init) =>
      new URL(String(input)).pathname === "/transactions" ? new Response("{}", { status: 503 }) : fetch(input, init);
    const provider = new IncreaseSandboxBank({ scope: f.scope, apiKey: "test-only", fetch: failingList,
      resolveCommand: key => f.t.query(api.demoEvidence.resolveCommand, { scope: f.scope, token: f.evidenceToken, idempotencyKey: key }) });
    const worker = new EvidenceWorker(f.t as unknown as KernelTransport, f.scope, f.evidenceToken, provider);
    const result = await worker.tick();
    expect(result.errors).toEqual(["Bank transaction polling failed: Increase outcome unknown"]);
    // Transfer observation still fetched and posted each payment's debit.
    expect(result.posted).toBe(3);
    expect(await f.t.run(ctx => ctx.db.query("demoCursors").collect())).toEqual([]);
  });
});
