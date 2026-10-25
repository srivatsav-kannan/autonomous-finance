import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "./demo-fixture";
import { openFakeBank } from "../src/integrations/banking/fake";
import { EvidenceWorker, type KernelTransport } from "../src/payments/evidence";
import { PaymentDispatcher } from "../src/payments/dispatcher";
import { PAYMENT_EXECUTOR_VERSION } from "../src/payments/contracts";
import { OperatorHealthPanel } from "../console/src/OperatorHealth";
import { formatAge, healthSignals, type OperatorHealth } from "../console/src/operatorHealthView";

// #56: the /ap-demo console shows demoOps.operatorHealth read-only. These tests render the panel
// from the real query (convex-test), not from a hand-written health object.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.unstubAllEnvs(); });

async function fixture(runId = "console-health") {
  const f = await demoFixture(runId);
  const dir = mkdtempSync(join(tmpdir(), "ap-console-health-"));
  const bank = openFakeBank({ path: join(dir, "bank.sqlite"), scope: f.scope, seed: 56, startTime: "2026-10-23T00:00:00.000Z" });
  cleanup.push(() => { bank.close(); rmSync(dir, { recursive: true, force: true }); });
  const transport = f.t as unknown as KernelTransport;
  const dispatcher = new PaymentDispatcher(transport, f.scope, f.dispatcherToken, bank.provider, "dispatcher-console");
  const evidence = new EvidenceWorker(transport, f.scope, f.evidenceToken, bank.provider);
  const health = (): Promise<OperatorHealth> => f.human.query(api.demoOps.operatorHealth, { scope: f.scope });
  return { ...f, bank, dispatcher, evidence, health };
}
const render = (health?: OperatorHealth, error?: string) => renderToStaticMarkup(<OperatorHealthPanel health={health} error={error} />);
const signal = (health: OperatorHealth, label: string, group?: string) =>
  healthSignals(health).find(s => s.label === label && (group === undefined || s.group === group))!;

describe("/ap-demo operator health panel", () => {
  it("is read-only and labels every threshold as a target, not a measurement", async () => {
    const f = await fixture();
    await f.queued();
    const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!);
    f.bank.harness.drainNotifications({ drop: true });
    expect(await f.evidence.tick()).toEqual({ posted: 1, errors: [] });
    const health = await f.health();
    expect(health.status).toBe("healthy");
    const html = render(health);
    expect(html).toContain("Operator health");
    expect(html).toContain("Healthy");
    expect(html).toContain("Targets, not measurements (target_not_measured)");
    expect(html).toContain("No alerts.");
    expect(html).not.toMatch(/<(button|input|form|textarea|select)\b/);
    // Healthy means no signal is past its target.
    expect(healthSignals(health).filter(s => s.overTarget)).toEqual([]);
    expect(signal(health, "Last pass", "Dispatcher worker")).toMatchObject({ target: "within 1 min", overTarget: false });
    expect(signal(health, "Polling cursor").observed).toMatch(/last full scan \d+ s ago/);
  });

  it("shows the browser demo's crash window: an attempted payment with no confirmed transfer and a silent dispatcher", async () => {
    const f = await fixture();
    await f.queued();
    // A dispatcher that claims and is killed before it records anything (as in demo:local).
    const lease = await f.t.mutation(api.demoPayments.claim, { scope: f.scope, token: f.dispatcherToken, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, workerId: "killed", leaseToken: "killed-worker-lease-token" });
    expect(lease).not.toBeNull();
    const health = await f.health();
    expect(health.status).toBe("unhealthy");
    expect(signal(health, "Attempted, no confirmed bank transfer").observed).toMatch(/^1 · oldest \d+ s$/);
    expect(signal(health, "Last pass", "Dispatcher worker")).toMatchObject({ observed: "No pass recorded for this run", overTarget: null });
    const html = render(health);
    expect(html).toContain("dispatcher_not_reporting");
    expect(html).toContain("Runbook:</span> Start npm run worker:dispatch");
    expect(html).toContain("Never generate a new provider key, resend a transfer, or free a reservation just to clear this warning.");
    for (const secret of ["killed-worker-lease-token", f.dispatcherToken, f.evidenceToken]) expect(html).not.toContain(secret);
  });

  it("marks stale and failing workers past target, matching the backend alerts", async () => {
    const f = await fixture();
    await f.queued();
    await f.dispatcher.tick();
    await f.evidence.tick();
    await f.t.run(async ctx => { for (const row of await ctx.db.query("demoWorkerHealth").collect()) await ctx.db.patch(row._id, { lastPassAt: Date.now() - 5 * 60_000 }); });
    for (let i = 0; i < 3; i++) await f.t.mutation(api.demoOps.recordEvidencePass, { scope: f.scope, token: f.evidenceToken, workerId: "evidence-console", outcome: "failed", errorClass: "authentication" });
    const health = await f.health();
    expect(health.alerts.map(a => a.state)).toEqual(expect.arrayContaining(["dispatcher_stale", "evidence_failing"]));
    expect(signal(health, "Last pass", "Dispatcher worker")).toMatchObject({ observed: "5 min ago (ok)", overTarget: true });
    expect(signal(health, "Consecutive failed passes", "Evidence worker")).toMatchObject({ observed: "3", target: "fewer than 3", overTarget: true });
    const html = render(health);
    expect(html).toContain("Unhealthy");
    expect(html).toContain("Repair credentials or configuration");
  });

  it("flags a bank-settled payment that failed to post locally", async () => {
    const f = await fixture();
    await f.queued();
    const sent = await f.dispatcher.tick();
    f.bank.harness.settle(sent.providerTransferId!);
    await f.t.run(async ctx => { const period = (await ctx.db.query("periods").first())!; await ctx.db.patch(period._id, { status: "closed" }); });
    expect((await f.evidence.tick()).posted).toBe(0);
    const health = await f.health();
    expect(signal(health, "Bank settled, not posted locally")).toMatchObject({ target: "0", overTarget: true });
    expect(render(health)).toContain("bank_settled_local_posting_failed");
  });

  it("degrades to a message when the health query is unavailable, without hiding the rest of the page", () => {
    expect(render(undefined, "Forbidden: independently authenticated human required")).toContain("Operator health is unavailable: Forbidden");
  });

  it("formats ages compactly", () => {
    expect([null, 0, 4_400, 60_000, 95_000, 3_600_000 + 120_000].map(formatAge)).toEqual(["never", "0 s", "4 s", "1 min", "1 min 35 s", "1 h 2 min"]);
  });
});
