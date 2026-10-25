import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { fixture, packet, refs } from "./accounting-fixture";
import { APCaseAgentWorker } from "../../src/agents/ap-case-worker";
import { createAPCaseAgentTools } from "../../src/agents/ap-case-tools";
import { planAPCase } from "../../src/ap-system/agent-policy";
import { caseDetailSchema } from "../../src/ap-system/contracts";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";

const claim = makeFunctionReference<"mutation">("apCaseAgent:claim"),
  advance = makeFunctionReference<"mutation">("apCaseAgent:advance"),
  inspect = makeFunctionReference<"query">("apCaseAgent:inspect"),
  control = makeFunctionReference<"mutation">("apCaseAgent:control");
const authorize = makeFunctionReference<"mutation">("apCasePayments:authorize"),
  cancel = makeFunctionReference<"mutation">("apCasePayments:cancel");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
  const f = await fixture(),
    payments = { scope: f.scope, seatId: "payments", token: "token-payments" };
  const transport = {
    query: f.t.query.bind(f.t),
    mutation: f.t.mutation.bind(f.t),
  } as unknown as KernelTransport;
  const newWorker = () =>
    new APCaseAgentWorker(transport, f.scope, [
      { seatId: f.ap.seatId, token: f.ap.token },
      { seatId: payments.seatId, token: payments.token },
    ]);
  const state = () =>
    f.t.run(async (ctx) => ({
      work: await ctx.db.query("apCaseWork").collect(),
      events: await ctx.db.query("apCaseWorkEvents").collect(),
      versions: await ctx.db.query("demoVersions").collect(),
      commands: await ctx.db.query("demoCommands").collect(),
      bills: await ctx.db.query("demoBills").collect(),
      journals: await ctx.db.query("journalEntries").collect(),
    }));
  const tick = async () => {
    vi.setSystemTime(Date.now() + 5_001);
    return newWorker().tick();
  };
  const ingest = async (input = packet()) =>
    (await f.t.mutation(refs.ingest, { ...f.ap, input })).caseId as string;
  async function review(caseId: string) {
    const d = await f.get(caseId);
    await f.fieldReviewer.mutation(refs.review, {
      scope: f.scope,
      input: f.request(d, `review-${d.revision}`),
    });
  }
  async function approve(caseId: string) {
    const d = await f.get(caseId);
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: {
        ...f.request(d, `bill-${d.revision}`),
        acceptedCents: d.candidate!.totalCents,
      },
    });
  }
  async function recognized() {
    const id = await ingest();
    await review(id);
    await approve(id);
    return id;
  }
  const work = async (caseId: string) =>
    (await f.t.query(inspect, { ...f.ap, caseId })).work;
  const take = (auth = f.ap, requestId = randomUUID()) =>
    f.t.mutation(claim, { ...auth, requestId });
  const advanceLease = (
    lease: { caseId: string; generation: number },
    auth = f.ap,
  ) =>
    f.t.mutation(advance, {
      ...auth,
      caseId: lease.caseId,
      generation: lease.generation,
    });
  return {
    ...f,
    payments,
    transport,
    newWorker,
    state,
    tick,
    ingest,
    review,
    approve,
    recognized,
    work,
    take,
    advanceLease,
  };
}

describe("new AP case agent integration", () => {
  it("waits for missing receipt, restarts, resumes the same case, waits for independent approval and reconciles one FakeBank payment", async () => {
    const f = await setup(),
      full = packet(),
      missing = structuredClone(full);
    missing.documents = missing.documents.filter((d) => d.kind !== "receipt");
    missing.candidate!.sources = missing.candidate!.sources.filter(
      (s) => !s.sourceId.startsWith("receipt"),
    );
    missing.purchasingEvidence = missing.purchasingEvidence.filter(
      (p) => p.kind !== "receipt",
    );
    const id = await f.ingest(missing);
    await f.tick();
    expect(await f.work(id)).toMatchObject({
      status: "waiting",
      stage: "missing_evidence",
    });
    expect((await f.state()).versions).toHaveLength(0);
    const before = await f.state();
    const missingEvent = before.events.at(-1)!;
    for (let n = 0; n < 3; n++) await f.tick();
    expect((await f.state()).events).toHaveLength(before.events.length); // idle polls are not progress
    const revision = {
      ...full,
      idempotencyKey: "receipt-arrival",
      explicitRevisionOf: id,
      candidate: { ...full.candidate!, revision: 2 },
    };
    expect(await f.ingest(revision)).toBe(id);
    await f.tick();
    expect(await f.work(id)).toMatchObject({ stage: "field_review" });
    expect(
      (await f.state()).events.find((e) => e._id === missingEvent._id),
    ).toEqual(missingEvent);
    expect(missingEvent.transition.after.case.revision).toBe(1);
    expect(
      (await f.state()).events.at(-1)!.transition.after.case.revision,
    ).toBe(2);
    await f.review(id);
    await f.tick();
    expect(await f.work(id)).toMatchObject({ stage: "bill_approval" });
    await f.approve(id);
    await f.tick();
    expect(await f.work(id)).toMatchObject({ stage: "payment_authorization" });
    let s = await f.state();
    expect(s.versions).toHaveLength(1);
    expect(s.commands).toHaveLength(0);
    expect(s.journals).toHaveLength(1);
    const d = await f.get(id),
      p = s.versions[0]!;
    const args = {
      scope: f.scope,
      caseId: id,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      versionId: p._id,
      paymentSnapshotHash: p.snapshotHash,
    };
    await expect(f.t.mutation(authorize, args)).rejects.toThrow(/human/);
    const bank = openFakeBank({
      path: ":memory:",
      scope: f.scope,
      seed: 71,
      initialBalanceCents: 100_000,
      startTime: "2026-10-25T12:00:00Z",
    });
    try {
      const dispatch = new ExecutePaymentEffect(
        createConvexPaymentKernel(f.transport, f.scope, "test-dispatch"),
        bank.provider,
        "agent-integration-dispatch",
        {
          now: Date.now,
          newLeaseToken: randomUUID,
          startHeartbeat: () => () => {},
        },
      );
      expect(await dispatch.tick()).toEqual({ dispatched: false });
      await f.payer.mutation(authorize, args);
      await f.tick();
      expect(await f.work(id)).toMatchObject({ stage: "bank_settlement" });
      const sent = await dispatch.tick();
      expect(sent.dispatched).toBe(true);
      bank.harness.settle(sent.providerTransferId!);
      const evidence = new ReconcilePaymentEvidence(
        createConvexPaymentEvidence(f.transport, f.scope, "test-evidence"),
        bank.provider,
        f.scope,
        Date.now,
      );
      expect((await evidence.tick()).posted).toBe(1);
      await f.tick();
      expect(await f.work(id)).toMatchObject({
        status: "complete",
        stage: "reconciled",
      });
      const completed = (await f.state()).events.at(-1)!.transition;
      expect(completed.after.case).toMatchObject({
        states: { execution: "settled", reconciliation: "matched" },
        amounts: { settledCents: 7700, outstandingCents: 0 },
        providerTransferIds: [sent.providerTransferId],
      });
      expect(completed.after.case.commandIds).toHaveLength(1);
      expect(completed.after.case.bankTransactionIds).toHaveLength(1);
      expect(completed.after.case.journalIds).toHaveLength(2);
      for (let n = 0; n < 3; n++) await f.tick();
      expect((await evidence.tick()).posted).toBe(0);
      s = await f.state();
      expect(s.bills).toHaveLength(1);
      expect(s.versions).toHaveLength(1);
      expect(s.commands).toHaveLength(1);
      expect(s.journals).toHaveLength(2);
      expect(bank.harness.inspect().transfers).toHaveLength(1);
      expect(
        (await f.get(id)).timeline.some(
          (e) => e.kind === "agent_missing_evidence",
        ),
      ).toBe(true);
      expect(
        (await f.get(id)).timeline.some((e) => e.kind === "agent_reconciled"),
      ).toBe(true);
      if (process.env.AP_AGENT_EVIDENCE_DIR)
        writeFileSync(
          join(process.env.AP_AGENT_EVIDENCE_DIR, "agent-case-flow.json"),
          JSON.stringify(
            {
              classification:
                "owner local integration test; Convex-test plus SQLite FakeBank; simulated human; synthetic text originals; no parser or external provider call",
              clock: "controlled test clock",
              scope: f.scope,
              sourcePacket: full,
              case: await f.get(id),
              work: s.work,
              events: s.events,
              bills: s.bills,
              versions: s.versions.map(
                ({ scope, _id, status, snapshotHash, approvals }) => ({
                  scope,
                  id: _id,
                  status,
                  snapshotHash,
                  approvals,
                }),
              ),
              commands: s.commands.map((c) => ({
                id: c._id,
                operationId: c.command.commandId,
                execution: c.execution,
                posting: c.posting,
                reconciliation: c.reconciliation,
                attemptCount: c.attemptCount,
              })),
              journals: s.journals.map((j) => ({
                id: j._id,
                date: j.date,
                source: j.source,
                lines: j.lines,
              })),
              bank: bank.harness.inspect(),
              checks: {
                sameCaseResumed: true,
                waitedForEvidence: true,
                noCommandBeforeHumanAuthorization: true,
                oneBill: true,
                oneProposal: true,
                oneCommand: true,
                oneBankTransfer: true,
                twoJournals: true,
                replayPostedZero: true,
              },
            },
            null,
            2,
          ) + "\n",
        );
    } finally {
      bank.close();
    }
  });
  it("retains changed missing-item evidence even when the wait stage stays the same", async () => {
    const f = await setup(),
      full = packet(),
      missing = structuredClone(full);
    missing.documents = missing.documents.filter((d) => d.kind === "invoice");
    missing.candidate!.sources = missing.candidate!.sources.filter((x) =>
      x.sourceId.startsWith("invoice"),
    );
    missing.purchasingEvidence = [];
    const id = await f.ingest(missing);
    await f.tick();
    const first = await f.work(id);
    const partial = structuredClone(full);
    partial.documents = partial.documents.filter(
      (d) => d.kind !== "purchase_order",
    );
    partial.candidate!.sources = partial.candidate!.sources.filter(
      (x) => !x.sourceId.startsWith("po-"),
    );
    partial.purchasingEvidence = partial.purchasingEvidence.filter(
      (x) => x.kind !== "purchase_order",
    );
    partial.idempotencyKey = "receipt-only";
    partial.explicitRevisionOf = id;
    partial.candidate!.revision = 2;
    await f.ingest(partial);
    await f.tick();
    const second = await f.work(id);
    expect(second.stage).toBe("missing_evidence");
    expect(second.requirements).not.toEqual(first.requirements);
    expect(second.waitSince).toBeGreaterThan(first.waitSince);
    expect(
      (await f.state()).events.filter((e) => e.stage === "missing_evidence"),
    ).toHaveLength(2);
  });
  it("observes approval arriving between claim and wait and hands off to the payments seat", async () => {
    const f = await setup(),
      id = await f.ingest(),
      lease = await f.take();
    await f.review(id);
    await f.approve(id);
    expect(await f.advanceLease(lease)).toMatchObject({
      status: "queued",
      stage: "prepare_payment",
    });
    await f.tick();
    expect(await f.work(id)).toMatchObject({ stage: "payment_authorization" });
    expect((await f.state()).versions).toHaveLength(1);
  });
  it("recovers a lost claim/advance response with the same identity and one proposal", async () => {
    const f = await setup();
    await f.recognized();
    const requestId = randomUUID();
    const a = await f.take(f.payments, requestId),
      b = await f.take(f.payments, requestId);
    expect(b).toEqual(a);
    await f.advanceLease(a, f.payments);
    expect(await f.advanceLease(b, f.payments)).toMatchObject({
      replayed: true,
    });
    expect((await f.state()).versions).toHaveLength(1);
    expect((await f.state()).commands).toHaveLength(0);
  });
  it("retains exact proposal before/after evidence across replay and later approval", async () => {
    const f = await setup(),
      id = await f.recognized();
    const lease = await f.take(f.payments);
    const claimed = (await f.state()).events.at(-1)!;
    expect(claimed.transition).toMatchObject({
      action: "claim",
      outcome: "applied",
      before: { work: { status: "queued", generation: 0 } },
      after: {
        work: {
          status: "leased",
          generation: lease.generation,
          leaseOwner: "payments",
        },
      },
    });
    await f.advanceLease(lease, f.payments);
    const s = await f.state(),
      event = s.events.at(-1)!;
    expect(event.actor).toBe("payments");
    expect(event.transition).toMatchObject({
      action: "advance",
      outcome: "applied",
      before: {
        work: { status: "leased" },
        case: {
          revision: 1,
          states: { accounting: "recognized", authorization: "not_requested" },
          amounts: {
            invoicedCents: 7700,
            acceptedCents: 7700,
            outstandingCents: 7700,
          },
          paymentVersionIds: [],
          commandIds: [],
        },
      },
      after: {
        work: {
          status: "waiting",
          stage: "payment_authorization",
          leaseOwner: null,
        },
        case: {
          states: { authorization: "awaiting_approval" },
          paymentVersionIds: [s.versions[0]!._id],
          commandIds: [],
          journalIds: [s.journals[0]!._id],
        },
      },
    });
    expect(event.transition.after.case.sourceBindings).toEqual(
      (await f.get(id)).currentSourceBindings,
    );
    expect(event.transition.after.case.decisionIds).toHaveLength(2);
    expect(event.transition.after.case.policyVersion).toBe(
      (await f.get(id)).policyVersion,
    );
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "originalBase64",
      "extractedText",
      "Golden State Produce",
      "token-payments",
      "token-ap_clerk",
      "routingNumber",
      "accountNumber",
    ])
      expect(serialized).not.toContain(forbidden);
    await f.advanceLease(lease, f.payments);
    expect((await f.state()).events).toHaveLength(s.events.length);
    const d = await f.get(id),
      p = s.versions[0]!;
    await f.payer.mutation(authorize, {
      scope: f.scope,
      caseId: id,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      versionId: p._id,
      paymentSnapshotHash: p.snapshotHash,
    });
    await f.tick();
    const observed = (await f.state()).events.at(-1)!;
    expect(observed.transition.before.case.commandIds).toHaveLength(1);
    expect(observed.transition.before.case.states.authorization).toBe(
      "authorized",
    );
    expect(
      JSON.stringify((await f.state()).events.find((e) => e._id === event._id)),
    ).toBe(serialized);
    // The validated API exposes the saved evidence instead of reconstructing it from current authorization.
    const history = caseDetailSchema
      .parse(await f.get(id))
      .timeline.find((e) => e.eventId === event._id)!;
    expect(history.agentTransition).toEqual(event.transition);
    expect(history.references).toContain(event.transition.operationId);
    expect(
      new Set((await f.state()).events.map((e) => e.transition.operationId))
        .size,
    ).toBe((await f.state()).events.length);
  });
  it("records handoff and pause/resume with the committed owner, stage and lease generation", async () => {
    const f = await setup(),
      id = await f.ingest(),
      lease = await f.take();
    await f.review(id);
    await f.approve(id);
    await f.advanceLease(lease);
    const handoff = (await f.state()).events.at(-1)!;
    expect(handoff.transition).toMatchObject({
      action: "handoff",
      before: { work: { role: "ap_clerk", status: "leased" } },
      after: {
        work: {
          role: "payments",
          stage: "prepare_payment",
          status: "queued",
          leaseOwner: null,
        },
      },
    });
    expect(await f.advanceLease(lease)).toMatchObject({
      stage: "prepare_payment",
      replayed: true,
    });
    const paymentLease = await f.take(f.payments);
    await f.human.mutation(control, {
      scope: f.scope,
      caseId: id,
      action: "pause",
      reason: "Review source evidence",
    });
    const paused = (await f.state()).events.at(-1)!;
    expect(paused.transition).toMatchObject({
      action: "pause",
      before: {
        work: { status: "leased", generation: paymentLease.generation },
      },
      after: {
        work: {
          status: "paused",
          generation: paymentLease.generation + 1,
          leaseOwner: null,
        },
      },
    });
    expect(paused.generation).toBe(paymentLease.generation + 1);
    await expect(f.advanceLease(paymentLease, f.payments)).rejects.toThrow(
      /lease/,
    );
    expect((await f.state()).events.at(-1)).toEqual(paused);
    await f.human.mutation(control, {
      scope: f.scope,
      caseId: id,
      action: "resume",
      reason: "Evidence checked",
    });
    expect((await f.state()).events.at(-1)!.transition).toMatchObject({
      action: "resume",
      before: { work: { status: "paused" } },
      after: { work: { status: "queued" } },
    });
    expect((await f.state()).commands).toHaveLength(0);
  });
  it("rolls back a proposed payment when its audit snapshot cannot be committed", async () => {
    const f = await setup();
    await f.recognized();
    const lease = await f.take(f.payments);
    // A malformed legacy counter is legal to the old database schema, but invalid audit evidence.
    await f.t.run(async (ctx) => {
      const w = (await ctx.db.query("apCaseWork").collect())[0]!;
      await ctx.db.patch(w._id, { transitions: -2 });
    });
    const before = await f.state();
    await expect(f.advanceLease(lease, f.payments)).rejects.toThrow();
    const after = await f.state();
    expect(after.versions).toHaveLength(0);
    expect(after.commands).toHaveLength(0);
    expect(after.work).toEqual(before.work);
    expect(after.events).toEqual(before.events);
    expect(after.journals).toEqual(before.journals);
  });
  it("keeps legacy stage-only events readable without inventing historical evidence", async () => {
    const f = await setup(),
      id = await f.ingest(),
      d = await f.get(id);
    const eventId = await f.t.run((ctx) =>
      ctx.db.insert("apCaseWorkEvents", {
        scope: f.scope,
        caseId: ctx.db.normalizeId("apCaseRecords", id)!,
        actor: "ap_clerk",
        stage: "missing_evidence",
        reason: "Historical wait",
        revision: d.revision,
        snapshotHash: d.snapshotHash,
        generation: 1,
        at: Date.now(),
      }),
    );
    await f.tick();
    const event = caseDetailSchema
      .parse(await f.get(id))
      .timeline.find((e) => e.eventId === eventId)!;
    expect(event.summary).toBe("Historical wait");
    expect(event.agentTransition).toBeUndefined();
  });
  it("does not manufacture new handoffs when the wrong role polls unchanged work", async () => {
    const f = await setup();
    await f.recognized();
    expect(await f.take()).toBeNull();
    const first = await f.state();
    expect(first.events.at(-1)!.transition.action).toBe("handoff");
    for (let n = 0; n < 3; n++) expect(await f.take()).toBeNull();
    expect((await f.state()).events).toEqual(first.events);
    expect((await f.state()).work[0]!.generation).toBe(
      first.work[0]!.generation,
    );
    expect((await f.state()).versions).toHaveLength(0);
  });
  it("fences an expired worker and allows a fresh worker to resume", async () => {
    const f = await setup();
    await f.recognized();
    const old = await f.take(f.payments);
    vi.setSystemTime(Date.now() + 30_001);
    const fresh = await f.take(f.payments);
    expect(fresh.generation).toBeGreaterThan(old.generation);
    await expect(f.advanceLease(old, f.payments)).rejects.toThrow(/lease/);
    await f.advanceLease(fresh, f.payments);
    expect((await f.state()).versions).toHaveLength(1);
  });
  it("does not grant both competing workers the same live lease", async () => {
    const f = await setup();
    await f.recognized();
    const [a, b] = await Promise.all([f.take(f.payments), f.take(f.payments)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
  it("bounds repeated crashes and requires human resume", async () => {
    const f = await setup(),
      id = await f.ingest();
    for (let i = 0; i < 4; i++) {
      expect(await f.take()).not.toBeNull();
      vi.setSystemTime(Date.now() + 30_001);
    }
    expect(await f.take()).toBeNull();
    expect(await f.work(id)).toMatchObject({ status: "escalated" });
    await expect(
      f.t.mutation(control, {
        scope: f.scope,
        caseId: id,
        action: "resume",
        reason: "retry",
      }),
    ).rejects.toThrow(/human/);
    await f.human.mutation(control, {
      scope: f.scope,
      caseId: id,
      action: "resume",
      reason: "Reviewed crashed worker and restored service",
    });
    await f.tick();
    expect(await f.work(id)).toMatchObject({ status: "waiting" });
  });
  it("records a durable owner and deadline, then escalates a stalled wait", async () => {
    const f = await setup(),
      id = await f.ingest();
    await f.tick();
    const w = await f.work(id);
    expect(w.deadlineAt).toBeGreaterThan(w.waitSince);
    expect(w.owner).toBe("human_field_reviewer");
    vi.setSystemTime(w.deadlineAt + 1);
    await f.tick();
    expect(await f.work(id)).toMatchObject({
      status: "escalated",
      owner: "controller",
    });
  });
  it("pause invalidates a lease and resume cannot grant payment authorization", async () => {
    const f = await setup(),
      id = await f.recognized(),
      lease = await f.take(f.payments);
    await f.human.mutation(control, {
      scope: f.scope,
      caseId: id,
      action: "pause",
      reason: "Inspect source",
    });
    await expect(f.advanceLease(lease, f.payments)).rejects.toThrow(/lease/);
    await f.tick();
    expect((await f.state()).versions).toHaveLength(0);
    await f.human.mutation(control, {
      scope: f.scope,
      caseId: id,
      action: "resume",
      reason: "Continue preparation",
    });
    await f.tick();
    expect((await f.state()).commands).toHaveLength(0);
  });
  it("retains a cancelled proposal and never automatically creates a replacement", async () => {
    const f = await setup(),
      id = await f.recognized();
    await f.tick();
    const d = await f.get(id),
      p = (await f.state()).versions[0]!;
    await f.human.mutation(cancel, {
      scope: f.scope,
      caseId: id,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      versionId: p._id,
    });
    await f.tick();
    expect(await f.work(id)).toMatchObject({ stage: "operator_resolution" });
    expect((await f.state()).versions).toHaveLength(1);
  });
  it("deduplicates intake and rejects foreign scope, role and malformed tool authority", async () => {
    const f = await setup(),
      id = await f.ingest();
    expect(await f.ingest()).toBe(id);
    expect((await f.state()).work).toHaveLength(1);
    await expect(
      f.t.mutation(claim, {
        ...f.ap,
        scope: { ...f.scope, organizationId: "foreign" },
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/scope|mismatch/);
    await expect(
      f.t.mutation(claim, {
        ...f.ap,
        seatId: "controller",
        token: "token-controller",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/role/);
    const tools = createAPCaseAgentTools(f.transport, f.scope, {
      seatId: f.ap.seatId,
      token: f.ap.token,
    });
    expect(Object.keys(tools)).toEqual(["inspect_case", "advance_case"]);
    await expect(
      tools.advance_case({
        caseId: id,
        generation: 1,
        authorize: true,
      } as never),
    ).rejects.toThrow();
    expect((await f.state()).commands).toHaveLength(0);
  });
  it("isolates a refused preparation without blocking other cases or committing partial effects", async () => {
    const f = await setup(),
      id = await f.recognized();
    await f.t.run(async (ctx) => {
      const row = await ctx.db.get(ctx.db.normalizeId("apCaseRecords", id)!);
      await ctx.db.patch(row!.billId!, { flags: ["controller_hold"] });
    });
    await f.tick();
    expect(await f.work(id)).toMatchObject({ status: "escalated" });
    expect((await f.state()).versions).toHaveLength(0);
    expect((await f.state()).events.at(-1)!.transition).toMatchObject({
      action: "escalate",
      outcome: "blocked",
      before: { work: { status: "leased" } },
      after: {
        work: { status: "escalated", owner: "controller" },
        case: { paymentVersionIds: [], commandIds: [] },
      },
    });
    const other = await f.ingest(packet("OTHER-CASE"));
    await f.tick();
    expect(await f.work(other)).toMatchObject({ stage: "field_review" });
  });
  it("revocation and changed evidence fence outstanding preparation", async () => {
    const f = await setup(),
      id = await f.recognized(),
      lease = await f.take(f.payments);
    const revised = packet();
    revised.idempotencyKey = "changed-evidence";
    revised.explicitRevisionOf = id;
    revised.candidate!.revision = 2;
    await f.ingest(revised);
    expect(await f.advanceLease(lease, f.payments)).toMatchObject({
      status: "queued",
    });
    expect((await f.state()).versions).toHaveLength(0);
    await f.t.run(async (ctx) => {
      const seat = await ctx.db
        .query("seats")
        .withIndex("by_run_seat", (q) =>
          q.eq("runId", f.scope.runId).eq("seatId", "ap_clerk"),
        )
        .unique();
      await ctx.db.patch(seat!._id, { status: "retired" });
    });
    await expect(f.take()).rejects.toThrow(/role|credential/);
  });
  it("does not re-pay returned, rejected, unknown or previously partial payments", async () => {
    const f = await setup(),
      id = await f.recognized();
    await f.tick();
    const d = await f.get(id);
    for (const execution of ["returned", "rejected", "unknown"] as const)
      expect(
        planAPCase({
          ...d,
          states: { ...d.states, execution, authorization: "authorized" },
        }).action,
      ).toBe("wait");
    expect(
      planAPCase({
        ...d,
        payments: d.payments.map((p) => ({ ...p, status: "settled" })),
        states: {
          ...d.states,
          execution: "settled",
          reconciliation: "matched",
        },
        amounts: { ...d.amounts, outstandingCents: 1000 },
      }),
    ).toMatchObject({ stage: "operator_resolution", action: "wait" });
  });
});
