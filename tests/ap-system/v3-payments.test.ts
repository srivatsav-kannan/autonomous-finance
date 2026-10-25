import { br, syncPrimary } from "./business-fixture";
import { creditFixture } from "./quickbooks-business-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { fixture, packet, refs } from "./accounting-fixture";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";

const request = makeFunctionReference<"mutation">("apCasePayments:request");
const authorize = makeFunctionReference<"mutation">("apCasePayments:authorize");
const cancel = makeFunctionReference<"mutation">("apCasePayments:cancel");
const runPrepare = makeFunctionReference<"mutation">("apPaymentRuns:prepare");
const runAuthorize = makeFunctionReference<"mutation">(
  "apPaymentRuns:authorize",
);
const runCancel = makeFunctionReference<"mutation">("apPaymentRuns:cancel");
const start = Date.parse("2026-10-25T12:00:00Z");
const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach((f) => f());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
type F = Pick<Awaited<ReturnType<typeof fixture>>, "t"|"scope"|"payer"|"human"|"ap"|"get"|"request"|"fieldReviewer">;
async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  return fixture();
}
async function approved(f: F, number = "V3-1") {
  const ingested = await f.t.mutation(refs.ingest, {
    ...f.ap,
    input: packet(number),
  });
  const d = await f.get(ingested.caseId);
  await f.fieldReviewer.mutation(refs.review, {
    scope: f.scope,
    input: f.request(d, "review-" + number),
  });
  await f.human.mutation(refs.approve, {
    scope: f.scope,
    input: { ...f.request(d, "approve-" + number), acceptedCents: 7700 },
  });
  const detail = await f.get(d.caseId);
  return {
    scope: f.scope,
    caseId: d.caseId,
    expectedRevision: d.revision,
    snapshotHash: d.snapshotHash,
    billId: detail.links.billId as Id<"demoBills">,
  };
}
type C = Awaited<ReturnType<typeof approved>>;
const binding = (c: C) => ({
  scope: c.scope,
  caseId: c.caseId,
  expectedRevision: c.expectedRevision,
  snapshotHash: c.snapshotHash,
});
const auth = (f: F) => ({
  scope: f.scope,
  seatId: "payments",
  token: "token-payments",
});
const propose = (
  f: F,
  c: C,
  key: string,
  extra: Record<string, unknown> = {},
) =>
  f.t.mutation(request, {
    ...auth(f),
    ...binding(c),
    idempotencyKey: key,
    ...extra,
  });
const approve = (f: F, c: C, r: any) =>
  f.payer.mutation(authorize, {
    ...binding(c),
    versionId: r.versionId,
    paymentSnapshotHash: r.snapshotHash,
  });
function bankRuntime(f: F) {
  const bank = openFakeBank({
    path: ":memory:",
    scope: f.scope,
    seed: "v3-independent",
    startTime: new Date(start).toISOString(),
  });
  close.push(() => bank.close());
  const t = f.t as unknown as KernelTransport;
  let n = 0;
  const worker = new ExecutePaymentEffect(
    createConvexPaymentKernel(t, f.scope, "test-dispatch"),
    bank.provider,
    "v3-worker",
    {
      now: Date.now,
      newLeaseToken: () => `v3-independent-lease-${++n}`,
      startHeartbeat: () => () => {},
    },
  );
  const reconcile = new ReconcilePaymentEvidence(
    createConvexPaymentEvidence(t, f.scope, "test-evidence"),
    bank.provider,
    f.scope,
    Date.now,
  );
  return { bank, worker, reconcile };
}
const journals = (f: F) =>
  f.t.run((ctx) => ctx.db.query("journalEntries").collect());
const apNet = async (f: F) =>
  (await journals(f))
    .flatMap((j) => j.lines)
    .filter((l) => l.account === "2000")
    .reduce((n, l) => n + l.credit - l.debit, 0);
async function runFixture() {
  const f = await setup(),
    cases = [await approved(f, "V3-RUN-1"), await approved(f, "V3-RUN-2")];
  const selection = cases.map((c) => ({
    caseId: c.caseId,
    expectedRevision: c.expectedRevision,
    snapshotHash: c.snapshotHash,
    amountCents: 2000,
  }));
  return {
    f,
    cases,
    args: { ...auth(f), requestKey: "independent-run", selection },
  };
}

describe("V3 independent payment conservation and schedule", () => {
  it("retains the applied credit when first partial cash is returned after a second settlement", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = await creditFixture();
    const d = await f.get(f.detail.caseId);
    const c = {scope:f.scope,caseId:d.caseId,expectedRevision:d.revision,snapshotHash:d.snapshotHash,billId:f.original.billId as Id<"demoBills">};
    const { bank, worker, reconcile } = bankRuntime(f);
    const input=packet("V3-CREDIT");const candidate=input.candidate!;
    candidate.kind="credit_note";input.documents[0]!.kind="credit_note";
    candidate.lines[0]!.quantity.decimal="1";candidate.lines[0]!.unitPriceCents=1200;candidate.lines[0]!.amountCents=1200;candidate.lines[0]!.allocations[0]!.amountCents=1200;candidate.subtotalCents=1200;candidate.totalCents=1200;
    syncPrimary(input);const creditCase=await f.reviewed(input);
    const proposal=await f.t.mutation(br.propose!,{...f.ap,input:{caseId:creditCase.caseId,expectedRevision:creditCase.revision,snapshotHash:creditCase.snapshotHash,idempotencyKey:"v3-linked-credit",policyVersion:f.policy.version,supplierRevision:1,credit:{originalCaseId:f.detail.caseId,originalApprovalId:f.original.proposal.proposalId,freightCents:0,discountCents:0,lines:[{creditLineId:"line-1",originalLineId:"line-1",basis:"price_adjustment",quantity:"0",netCents:1200,taxCents:0,returnEvidence:[]}],reason:"Supplier price adjustment against approved original allocation"}}});
    let creditResult=await f.vote(proposal);if(creditResult.status==="pending")creditResult=await f.vote(proposal,"finance");
    const {creditId}=creditResult;
    const first = await propose(f, c, "partial-1", {
      amountCents: 5000,
      credits: [{ creditId, amountCents: 1200 }],
    });
    await approve(f, c, first);
    await worker.tick();
    const firstTransfer = bank.harness.inspect().transfers[0]!;
    expect(firstTransfer.amountCents).toBe(3800);
    bank.harness.settle(firstTransfer.id);
    await reconcile.tick();
    expect(await f.t.run((ctx) => ctx.db.get(c.billId))).toMatchObject({
      originalCents: 7700,
      approvedCents: 7700,
      paidCents: 5000,
      status: "approved",
    });
    expect(await apNet(f)).toBe(2700);
    const second = await propose(f, c, "partial-2");
    await approve(f, c, second);
    await worker.tick();
    const secondTransfer = bank.harness
      .inspect()
      .transfers.find((t) => t.commandId === second.versionId)!;
    expect(secondTransfer.amountCents).toBe(2700);
    bank.harness.settle(secondTransfer.id);
    await reconcile.tick();
    expect(await apNet(f)).toBe(0);
    bank.harness.returnTransfer(firstTransfer.id);
    await reconcile.tick();
    await reconcile.tick();
    expect(await f.t.run((ctx) => ctx.db.get(c.billId))).toMatchObject({
      paidCents: 3900,
      status: "approved",
    });
    expect(await f.t.run((ctx) => ctx.db.get(creditId))).toMatchObject({
      consumedCents: 1200,
      reservedCents: 0,
    });
    expect(await apNet(f)).toBe(3800);
    await expect(
      propose(f, c, "double-credit", {
        amountCents: 3800,
        credits: [{ creditId, amountCents: 1200 }],
      }),
    ).rejects.toThrow(/Credit unavailable/);
    const third = await propose(f, c, "returned-cash-replacement");
    await worker.tick();
    expect(bank.harness.inspect().transfers).toHaveLength(2);
    await approve(f, c, third);
    await worker.tick();
    const thirdTransfer = bank.harness
      .inspect()
      .transfers.find((t) => t.commandId === third.versionId)!;
    expect(thirdTransfer.amountCents).toBe(3800);
    bank.harness.settle(thirdTransfer.id);
    await reconcile.tick();
    await reconcile.tick();
    expect(await f.t.run((ctx) => ctx.db.get(c.billId))).toMatchObject({
      paidCents: 7700,
      status: "paid",
    });
    expect(await apNet(f)).toBe(0);
    expect(await journals(f)).toHaveLength(6);
    const cash = (await journals(f))
      .flatMap((j) => j.lines)
      .filter((l) => l.account === "1000")
      .reduce((n, l) => n + l.credit - l.debit, 0);
    expect(cash).toBe(6500);
    expect(bank.harness.inspect().transfers).toHaveLength(3);
    expect(
      await propose(f, c, "partial-1", {
        amountCents: 5000,
        credits: [{ creditId, amountCents: 1200 }],
      }),
    ).toEqual(first);
  });
  it("skips an earlier future command, cancels and reschedules without inheriting authority", async () => {
    const f = await setup(),
      a = await approved(f, "V3-FUTURE"),
      b = await approved(f, "V3-TODAY"),
      { bank, worker } = bankRuntime(f);
    const future = await propose(f, a, "future", {
      executionDate: "2026-10-28",
      amountCents: 2000,
    });
    const queued = await approve(f, a, future);
    await f.t.run((ctx) =>
      ctx.db.patch(queued.commandId as Id<"demoCommands">, {
        nextAttemptAt: 0,
      }),
    );
    const now = await propose(f, b, "today", { executionDate: "2026-10-25" });
    await approve(f, b, now);
    await worker.tick();
    expect(bank.harness.inspect().transfers.map((t) => t.commandId)).toEqual([
      now.versionId,
    ]);
    expect(
      await f.t.run((ctx) =>
        ctx.db.get(queued.commandId as Id<"demoCommands">),
      ),
    ).toMatchObject({ attemptCount: 0, generation: 0 });
    await f.human.mutation(cancel, {
      ...binding(a),
      versionId: future.versionId,
    });
    const replacement = await propose(f, a, "rescheduled", {
      executionDate: "2026-10-29",
      amountCents: 2000,
    });
    expect(replacement.snapshotHash).not.toBe(future.snapshotHash);
    vi.setSystemTime(Date.parse("2026-10-29T00:00:00Z"));
    await worker.tick();
    expect(bank.harness.inspect().transfers).toHaveLength(1);
    await approve(f, a, replacement);
    await worker.tick();
    expect(bank.harness.inspect().transfers).toHaveLength(2);
  });
  it("recovers a scheduled possible send with original key after the business date, never through rescheduling", async () => {
    const f = await setup(),
      c = await approved(f),
      { bank, worker, reconcile } = bankRuntime(f);
    bank.harness.scheduleFault({
      operation: "createTransfer",
      call: 1,
      kind: "accept_then_lost_response",
    });
    const r = await propose(f, c, "dated", {
        executionDate: "2026-10-28",
        amountCents: 3300,
      }),
      q = await approve(f, c, r);
    vi.setSystemTime(Date.parse("2026-10-27T23:59:59.999Z"));
    expect(await worker.tick()).toEqual({ dispatched: false });
    vi.setSystemTime(Date.parse("2026-10-28T00:00:00Z"));
    await worker.tick();
    const original = (await f.t.run((ctx) =>
      ctx.db.get(q.commandId as Id<"demoCommands">),
    ))!;
    await expect(
      f.human.mutation(cancel, { ...binding(c), versionId: r.versionId }),
    ).rejects.toThrow(/Submission/);
    await expect(
      propose(f, c, "replacement", {
        executionDate: "2026-10-29",
        amountCents: 3300,
      }),
    ).rejects.toThrow(/available/);
    vi.setSystemTime(original.nextAttemptAt);
    await worker.tick();
    const after = (await f.t.run((ctx) =>
      ctx.db.get(q.commandId as Id<"demoCommands">),
    ))!;
    expect(after.command).toEqual(original.command);
    expect(after.firstAttemptAt).toBe(Date.parse("2026-10-28T00:00:00Z"));
    expect(after.command.idempotencyKey).toBe(`demo:${r.versionId}`);
    expect(bank.harness.inspect().transfers).toHaveLength(1);
    bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
    await reconcile.tick();
    expect(await apNet(f)).toBe(4400);
  });
  it("rolls back earlier run preparation if the final member is stale", async () => {
    const { f, cases, args } = await runFixture();
    const sorted = [...args.selection].sort((a, b) =>
      a.caseId.localeCompare(b.caseId),
    );
    sorted[1] = { ...sorted[1]!, expectedRevision: 2 };
    await expect(
      f.t.mutation(runPrepare, { ...args, selection: sorted }),
    ).rejects.toThrow(/stale/);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoVersions").collect()),
    ).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("apPaymentRuns").collect()),
    ).toEqual([]);
    for (const c of cases)
      expect(
        (await f.t.run((ctx) => ctx.db.get(c.billId)))?.reservedVersionId,
      ).toBeUndefined();
    expect(await journals(f)).toHaveLength(2);
  });
  it("rolls back authorization of the first member when the last member was cancelled", async () => {
    const { f, args } = await runFixture(),
      r = await f.t.mutation(runPrepare, args),
      run = (await f.t.run((ctx) =>
        ctx.db.get(r.runId as Id<"apPaymentRuns">),
      ))!;
    await f.human.mutation(api.demoPayments.cancel, {
      scope: f.scope,
      versionId: run.items.at(-1)!.versionId,
    });
    await expect(
      f.payer.mutation(runAuthorize, { scope: f.scope, ...r }),
    ).rejects.toThrow(/Stale/);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toEqual([]);
    expect(
      (await f.t.run((ctx) => ctx.db.query("demoVersions").collect())).every(
        (v) => v.approvals.length === 0,
      ),
    ).toBe(true);
  });
  it("rolls back cancellation of the first member when the last member may have sent", async () => {
    const { f, args } = await runFixture(),
      r = await f.t.mutation(runPrepare, args),
      run = (await f.t.run((ctx) =>
        ctx.db.get(r.runId as Id<"apPaymentRuns">),
      ))!;
    await f.payer.mutation(runAuthorize, { scope: f.scope, ...r });
    const commands = await f.t.run((ctx) =>
      ctx.db.query("demoCommands").collect(),
    );
    for (const c of commands)
      await f.t.run((ctx) =>
        ctx.db.patch(c._id, {
          nextAttemptAt:
            c.versionId === run.items.at(-1)!.versionId ? 0 : start + 60000,
        }),
      );
    const lease = await f.t.mutation(api.demoPayments.claim, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      workerId: "last-member",
      leaseToken: "v3-last-member-possible-send",
    });
    expect(lease?.command.commandId).toBe(run.items.at(-1)!.versionId);
    await expect(
      f.human.mutation(runCancel, { scope: f.scope, ...r }),
    ).rejects.toThrow(/Submission/);
    const versions = await f.t.run((ctx) =>
      ctx.db.query("demoVersions").collect(),
    );
    expect(
      versions.every(
        (v) => v.status === "queued" && v.reservations === "reserved",
      ),
    ).toBe(true);
    expect(
      (await f.t.run((ctx) => ctx.db.query("demoCommands").collect()))
        .map((c) => c.execution)
        .sort(),
    ).toEqual(["in_flight", "queued"]);
  });
});
