import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";
import { PaymentDispatcher } from "../src/payments/dispatcher";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); });

// #56: operators must tell a running process from a worker that is making progress.
async function fixture(runId = "ops-health") {
  const f = await demoFixture(runId);
  const dir = mkdtempSync(join(tmpdir(), "ap-ops-"));
  const bank = openFakeBank({ path: join(dir, "bank.sqlite"), scope: f.scope, seed: 56, startTime: "2026-10-23T00:00:00.000Z" });
  cleanup.push(() => { bank.close(); rmSync(dir, { recursive: true, force: true }); });
  const transport = f.t as unknown as KernelTransport;
  const dispatcher = new PaymentDispatcher(transport, f.scope, f.dispatcherToken, bank.provider, "dispatcher-ops");
  const evidence = new EvidenceWorker(transport, f.scope, f.evidenceToken, bank.provider);
  const health = () => f.human.query(api.demoOps.operatorHealth, { scope: f.scope });
  const states = async () => (await health()).alerts.map(alert => alert.state);
  return { ...f, bank, dispatcher, evidence, health, states };
}
// Affirmative operator advice must never be to mint a key, resend, or free a hold.
const unsafeAdvice = /new (provider |idempotency )?key|resend|re-send|release|free (the )?(hold|reservation)/i;

describe("operator health and recovery runbooks", () => {
  it("is healthy after a missing webhook is recovered by polling", async () => {
    const f = await fixture();
    await f.queued();
    const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!);
    expect(f.bank.harness.drainNotifications({ drop: true })).toEqual([]);
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    const health = await f.health();
    expect(health).toMatchObject({ status: "healthy", clock: "server_wall_clock", alerts: [],
      workers: { dispatcher: { workerId: "dispatcher-ops", lastOutcome: "ok", consecutiveFailures: 0 }, evidence: { lastOutcome: "ok" } },
      evidence: { pendingNotices: { count: 0 }, unpostedTransactions: { count: 0 }, cursor: { scanCompletedAt: expect.any(Number) } },
      commands: { eligible: { count: 0 }, unknownOutcome: { count: 0 }, retryExhausted: { count: 0 } } });
    expect(health.evidence.cursor!.lastImportAgeMs).toBeLessThan(60_000);
    expect(health.sloTargets.basis).toBe("target_not_measured");
  });

  it("flags stale heartbeats and repeatedly failing passes with the matching operator action", async () => {
    const f = await fixture();
    await f.queued();
    await f.dispatcher.tick();
    await f.evidence.tick();
    await f.t.run(async ctx => { for (const row of await ctx.db.query("demoWorkerHealth").collect()) await ctx.db.patch(row._id, { lastPassAt: Date.now() - 5 * 60_000 }); });
    const stale = await f.health();
    expect(stale.status).toBe("unhealthy");
    expect(stale.alerts.find(a => a.state === "dispatcher_stale")!.action).toMatch(/Restore dispatcher connectivity.*npm run worker:dispatch/);
    expect(stale.alerts.find(a => a.state === "evidence_stale")!.action).toMatch(/Restore evidence connectivity/);
    // The process may still run while every pass fails, for example with a revoked credential.
    for (let i = 0; i < 3; i++) await f.t.mutation(api.demoOps.recordDispatcherPass, { scope: f.scope, token: f.dispatcherToken, workerId: "dispatcher-ops", outcome: "failed", errorClass: "authentication", paymentExecutorVersion: "scoped-ap-v2" });
    const failing = (await f.health()).alerts.find(a => a.state === "dispatcher_failing")!;
    expect(failing).toMatchObject({ severity: "critical", observed: "3 failed passes (authentication)" });
    expect(failing.action).toMatch(/Repair credentials/);
    // A worker reports only through its own service credential and an allowlisted class.
    await expect(f.t.mutation(api.demoOps.recordDispatcherPass, { scope: f.scope, token: f.evidenceToken, workerId: "x", outcome: "ok", paymentExecutorVersion: "scoped-ap-v2" })).rejects.toThrow("Forbidden");
    await expect(f.t.mutation(api.demoOps.recordEvidencePass, { scope: f.scope, token: f.evidenceToken, workerId: "x", outcome: "failed", errorClass: "secret: sk_live" })).rejects.toThrow("Invalid worker health report");
  });

  it("counts retry exhaustion and advises inspection and audited resume", async () => {
    const f = await fixture();
    f.bank.harness.scheduleFault({ operation: "createTransfer", call: 1, kind: "disconnect" });
    const { commandId } = await f.queued();
    expect(await f.dispatcher.tick()).toMatchObject({ error: "transport" });
    await f.t.run(async ctx => ctx.db.patch(commandId, { budgetAttemptCount: 8, nextAttemptAt: 0 }));
    expect(await f.dispatcher.tick()).toEqual({ dispatched: false }); // Claim marks the budget exhausted.
    const health = await f.health();
    expect(health.commands.retryExhausted).toMatchObject({ count: 1, ids: [commandId] });
    expect(health.commands.unknownOutcome.count).toBe(1);
    const alert = health.alerts.find(a => a.state === "retry_exhausted")!;
    expect(alert.action).toMatch(/audited resume/);
    expect(alert.never).toMatch(/Never generate a new provider key, resend/);
    for (const { action } of health.alerts) expect(action).not.toMatch(unsafeAdvice);
  });

  it("separates a bank-settled payment whose local posting failed and advises evidence reconciliation, not dispatch", async () => {
    const f = await fixture();
    await f.queued();
    const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!);
    await f.t.run(async ctx => { const period = (await ctx.db.query("periods").first())!; await ctx.db.patch(period._id, { status: "closed" }); });
    const result = await f.evidence.tick();
    expect(result.posted).toBe(0);
    const health = await f.health();
    expect(health.commands.bankSettledLocalUnposted.count).toBeGreaterThan(0);
    expect(health.workers.evidence).toMatchObject({ lastOutcome: "partial", lastErrorClass: "item_errors" });
    const alert = health.alerts.find(a => a.state === "bank_settled_local_posting_failed")!;
    expect(alert.action).toMatch(/Reconcile evidence.*Do not dispatch again/);
    for (const { action } of health.alerts) expect(action).not.toMatch(unsafeAdvice);
    // Repairing the local invariant lets the evidence worker post once; health returns to normal.
    await f.t.run(async ctx => { const period = (await ctx.db.query("periods").first())!; await ctx.db.patch(period._id, { status: "open" }); });
    expect((await f.evidence.tick()).posted).toBe(1);
    expect(await f.states()).toEqual([]);
    expect(f.bank.harness.inspect().calls.createTransfer).toBe(1);
  });

  it("is scoped to an authenticated human of this run and redacts payloads, keys and tokens", async () => {
    const f = await fixture();
    await f.queued();
    await f.dispatcher.tick();
    await expect(f.t.query(api.demoOps.operatorHealth, { scope: f.scope })).rejects.toThrow("authenticated human");
    await expect(f.human.query(api.demoOps.operatorHealth, { scope: { ...f.scope, accountId: "other" } })).rejects.toThrow("Forbidden");
    const command = (await f.t.run(ctx => ctx.db.query("demoCommands").first()))!;
    const text = JSON.stringify(await f.health());
    for (const secret of [command.command.idempotencyKey, command.command.requestHash, f.dispatcherToken, f.evidenceToken]) expect(text).not.toContain(secret);
  });
});
