import { afterEach, describe, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../tests/demo-fixture";
import { creditFixture } from "../../../tests/ap-system/quickbooks-business-fixture";
import { br } from "../../../tests/ap-system/business-fixture";
import { openFakeBank } from "../../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../../src/payments/adapters/convex-payment-evidence";

const closeView = makeFunctionReference<"query">("apClose:view");
const start = Date.parse("2026-10-25T12:00:00Z");
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach((c) => c()); vi.useRealTimers(); vi.unstubAllEnvs(); });
function bank(f: any) {
  const b = openFakeBank({ path: ":memory:", scope: f.scope, seed: "probe-c", startTime: new Date(start).toISOString() });
  closers.push(() => b.close());
  let n = 0;
  const worker = new ExecutePaymentEffect(createConvexPaymentKernel(f.t, f.scope, "test-dispatch"), b.provider, "probe-worker", { now: Date.now, newLeaseToken: () => `probe-credit-lease-${++n}`, startHeartbeat: () => () => {} });
  const rec = new ReconcilePaymentEvidence(createConvexPaymentEvidence(f.t, f.scope, "test-evidence"), b.provider, f.scope, Date.now);
  return { b, worker, rec };
}
const pay = async (f: any, key: string, credits: any[], amount?: number) => {
  const p = await f.t.mutation(api.demoPayments.requestPayment, { scope: f.scope, seatId: "payments", token: "token-payments", requestKey: key, billIds: [f.original.billId], credits, ...(amount ? { billAmounts: [{ billId: f.original.billId, amountCents: amount }] } : {}) });
  await f.humans.finance!.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...p });
  return p;
};
const lines = async (f: any, label: string) => {
  const js = await f.t.run((ctx: any) => ctx.db.query("journalEntries").collect());
  for (const j of js) console.log(`PROBE ${label} ${j.date} ${j.source.kind} ${j.lines.map((l: any) => (l.debit ? `Dr${l.account}:${l.debit}` : `Cr${l.account}:${l.credit}`)).join(" ")}`);
  const ap = js.flatMap((j: any) => j.lines).filter((l: any) => l.account === "2000").reduce((n: number, l: any) => n + l.credit - l.debit, 0);
  const cash = js.flatMap((j: any) => j.lines).filter((l: any) => l.account === "1000").reduce((n: number, l: any) => n + l.credit - l.debit, 0);
  console.log(`PROBE ${label} AP balance ${ap} cash paid ${cash}`);
};

describe("PROBE credits", () => {
  it("C1 recognized unapplied credit exists, payment of full gross without it is still allowed (overpayment)", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await creditFixture();
    const c = await f.credit();
    const { b, worker, rec } = bank(f);
    let o = "authorized";
    try { await pay(f, "full-no-credit", []); } catch (e) { o = (e as Error).message.slice(0, 200); }
    console.log("PROBE C1 pay 7700 gross ignoring available 3850 credit:", o);
    if (o === "authorized") { await worker.tick(); const t = b.harness.inspect().transfers[0]!; console.log("PROBE C1 transfer", t.amountCents); b.harness.settle(t.id); await rec.tick(); await rec.tick(); }
    await lines(f, "C1");
    const view = await f.humans.finance!.query(closeView, { scope: f.scope, period: "2026-10" });
    console.log("PROBE C1 recon", JSON.stringify(view.reconciliation), "blockers", view.blockers.map((x: any) => x.code).join(","));
    const credit = await f.t.run((ctx: any) => ctx.db.get(c.creditId));
    console.log("PROBE C1 credit row", JSON.stringify({ amount: credit.amountCents, reserved: credit.reservedCents, consumed: credit.consumedCents }));
  });
  it("C2 credit-only application equal to gross; payment with credit making cash zero; credit reused", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await creditFixture();
    const c = await f.credit();
    let o = ""; try { await pay(f, "zero-cash", [{ creditId: c.creditId, amountCents: 3850 }], 3850); o = "authorized"; } catch (e) { o = (e as Error).message.slice(0, 160); }
    console.log("PROBE C2 payment gross 3850 credit 3850 (cash 0):", o);
    let o2 = ""; try { await pay(f, "neg-cash", [{ creditId: c.creditId, amountCents: 3850 }], 2000); o2 = "authorized"; } catch (e) { o2 = (e as Error).message.slice(0, 160); }
    console.log("PROBE C2 payment gross 2000 credit 3850 (cash negative):", o2);
    const d = await f.get(f.detail.caseId);
    const bill = await f.t.run((ctx: any) => ctx.db.get(f.original.billId));
    const r = await f.humans.finance!.mutation(br.applyCredits!, { scope: f.scope, caseId: f.detail.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, billVersion: bill.version, idempotencyKey: "apply", reason: "apply", credits: [{ creditId: c.creditId, amountCents: 3850 }] });
    console.log("PROBE C2 credit-only applied", JSON.stringify(r));
    const bill2 = await f.t.run((ctx: any) => ctx.db.get(f.original.billId));
    let o3 = ""; try { await pay(f, "reuse", [{ creditId: c.creditId, amountCents: 100 }], 1000); o3 = "authorized"; } catch (e) { o3 = (e as Error).message.slice(0, 160); }
    console.log("PROBE C2 reuse consumed credit:", o3);
    let o4 = ""; try { await f.humans.finance!.mutation(br.applyCredits!, { scope: f.scope, caseId: f.detail.caseId, expectedRevision: d.revision, snapshotHash: d.snapshotHash, billVersion: bill2.version, idempotencyKey: "apply2", reason: "apply again", credits: [{ creditId: c.creditId, amountCents: 1 }] }); o4 = "applied"; } catch (e) { o4 = (e as Error).message.slice(0, 160); }
    console.log("PROBE C2 apply again:", o4);
    await lines(f, "C2");
  });
  it("C3 credit recognized after the bill is fully paid creates a supplier debit balance", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await creditFixture();
    const { b, worker, rec } = bank(f);
    await pay(f, "full", []); await worker.tick(); const t = b.harness.inspect().transfers[0]!; b.harness.settle(t.id); await rec.tick(); await rec.tick();
    let o = ""; try { await f.credit(); o = "credit recognized"; } catch (e) { o = (e as Error).message.slice(0, 160); }
    console.log("PROBE C3 credit after full payment:", o);
    await lines(f, "C3");
    const view = await f.humans.finance!.query(closeView, { scope: f.scope, period: "2026-10" });
    console.log("PROBE C3 recon", JSON.stringify(view.reconciliation), "unpaid", JSON.stringify(view.unpaidBills), "blockers", view.blockers.map((x: any) => x.code).join(","));
  });
});
