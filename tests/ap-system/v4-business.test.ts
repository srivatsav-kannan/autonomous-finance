import { afterEach, describe, expect, it, vi } from "vitest";
import {
  businessFixture,
  acceptance,
  binding,
  cr,
  subject,
  policy,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
const start = Date.parse("2026-10-25T12:00:00Z");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup(options: Parameters<typeof businessFixture>[0] = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  return businessFixture(options);
}
type F = Awaited<ReturnType<typeof setup>>;
async function retire(f: F, name: string) {
  await f.t.run(async (ctx) => {
    const seat = (await ctx.db.query("seats").collect()).find(
      (s) => s.seatId === `human-${name}`,
    )!;
    await ctx.db.patch(seat._id, { status: "retired" });
  });
}
const prepare = (f: F, key: string) =>
  f.t.mutation(makeFunctionReference<"mutation">("apCasePayments:request"), {
    scope: f.scope,
    seatId: "payments",
    token: "token-payments",
    caseId: f.detail.caseId,
    expectedRevision: f.detail.revision,
    snapshotHash: f.detail.snapshotHash,
    idempotencyKey: key,
  });
const authorize = (f: F, p: any) =>
  f.payer.mutation(api.demoPayments.approveAndQueue, {
    scope: f.scope,
    versionId: p.versionId,
    snapshotHash: p.snapshotHash,
  });

describe("V4 independent B3 financial authority", () => {
  it("rejects changed parser line IDs as new capacity for the same PO and receipt originals", async () => {
    const f = await setup();
    await f.recognize(f.detail, acceptance(f.input, "1"));
    const next = packet("V4-SECOND-INVOICE");
    for (const i of [1, 2]) {
      const doc = structuredClone(f.input.documents[i]!);
      doc.sourceId += "-renamed-v4";
      doc.name = "renamed-original.pdf";
      doc.deliveryId += "-v4";
      next.documents[i] = doc;
      const support = structuredClone(f.input.purchasingEvidence[i - 1]!);
      support.source = binding(doc);
      support.lines[0]!.lineId += "-parser-rerun";
      next.purchasingEvidence[i - 1] = support;
    }
    next.candidate!.sources = next.documents.map(binding);
    next.candidate!.lines[0]!.poLineId =
      next.purchasingEvidence[0]!.lines[0]!.lineId;
    next.candidate!.lines[0]!.receiptLineIds = [
      next.purchasingEvidence[1]!.lines[0]!.lineId,
    ];
    const d = await f.reviewed(next);
    const attempt = async () => {
      const p = await f.propose(
        d,
        acceptance(next, "2"),
        "duplicate-original-renumbered-lines",
      );
      await f.vote(p);
      await f.vote(p, "finance");
      const bills = await f.t.run((ctx) => ctx.db.query("demoBills").collect());
      const journals = await f.t.run((ctx) =>
        ctx.db.query("journalEntries").collect(),
      );
      return {
        billCount: bills.length,
        recognizedCents: bills.reduce((n, b) => n + (b.approvedCents ?? 0), 0),
        journalCount: journals.length,
      };
    };
    await expect(attempt()).rejects.toThrow(
      /already_used|consumption_source_conflict|source_line_identity/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(1);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(1);
  });
  it("does not approve a bank change after its verification human was retired", async () => {
    const f = await setup();
    const value = {
      ...f.supplier,
      expectedRevision: 1,
      externalAccountId: "v4-new-destination",
    };
    const p = await f.t.mutation(cr.proposeSupplier!, {
      ...f.ap,
      idempotencyKey: "v4-bank-change",
      proposal: value,
    });
    const row = (await f.t.run((ctx) =>
      ctx.db.get(p.revisionId as Id<"apSupplierRevisions">),
    ))!;
    await f.humans.verifier!.mutation(cr.verifySupplier!, {
      scope: f.scope,
      revisionId: p.revisionId,
      verification: {
        contactId: value.contactId,
        method: "callback_previously_held_contact",
        result: "confirmed",
        performedAt: row.createdAt,
        evidence: f.proof,
        mode: "simulated",
        reason: "Synthetic retained callback",
      },
    });
    await retire(f, "verifier");
    await expect(
      f.humans.governor!.mutation(cr.approveSupplier!, {
        scope: f.scope,
        revisionId: p.revisionId,
        expectedHash: row.hash,
        reason: "Approve exact bank change",
      }),
    ).rejects.toThrow(/inactive|verification|authority/);
  });
  it("retains original7700 and recognizes exact partial3850 with no automatic payment", async () => {
    const f = await setup();
    const result = await f.recognize(f.detail, acceptance(f.input, "1"));
    const d = await f.get(f.detail.caseId);
    expect(d.candidate!.totalCents).toBe(7700);
    expect(d.amounts).toMatchObject({
      acceptedCents: 3850,
      disputedCents: 3850,
      settledCents: 0,
      outstandingCents: 3850,
    });
    expect(d.journals.flatMap((j) => j.lines)).toEqual([
      { account: "5000", debit: 3850, credit: 0 },
      { account: "2000", debit: 0, credit: 3850 },
    ]);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toEqual([]);
    expect(await f.vote(result.proposal)).toMatchObject({ status: "approved" });
    expect((await f.get(f.detail.caseId)).journals).toHaveLength(1);
    const changed = acceptance(f.input, "1");
    changed.lines[0]!.allocations[0]!.account = "1200";
    changed.lines[0]!.allocations[0]!.treatment = "inventory";
    await expect(f.propose(d, changed, "rewrite-costs")).rejects.toThrow(
      /posted_allocation_change/,
    );
  });
  it("blocks invoice-derived contacts, replacement contact bank changes and same-human verification approval", async () => {
    const p = policy();
    p.groups
      .find((g) => g.groupId === "govern")!
      .members.push(subject("verifier"));
    const f = await setup({ policy: p });
    await expect(
      f.humans.verifier!.mutation(cr.registerTrustedContact!, {
        scope: f.scope,
        idempotencyKey: "invoice-contact",
        supplierId: f.supplier.supplierId,
        phone: "+14155550999",
        evidence: [binding(f.input.documents[0]!)],
        mode: "simulated",
      }),
    ).rejects.toThrow(/independent_contact_required/);
    const contact = await f.humans.verifier!.mutation(
      cr.registerTrustedContact!,
      {
        scope: f.scope,
        idempotencyKey: "other-contact",
        supplierId: f.supplier.supplierId,
        phone: "+14155550999",
        evidence: f.proof,
        mode: "simulated",
      },
    );
    await expect(
      f.t.mutation(cr.proposeSupplier!, {
        ...f.ap,
        idempotencyKey: "contact-and-bank",
        proposal: {
          ...f.supplier,
          expectedRevision: 1,
          contactId: contact.contactId,
          externalAccountId: "another-bank",
        },
      }),
    ).rejects.toThrow(/trusted_contact_change/);
    const r = await f.t.mutation(cr.proposeSupplier!, {
      ...f.ap,
      idempotencyKey: "independent-bank",
      proposal: {
        ...f.supplier,
        expectedRevision: 1,
        externalAccountId: "another-bank",
      },
    });
    const row = (await f.t.run((ctx) =>
      ctx.db.get(r.revisionId as Id<"apSupplierRevisions">),
    ))!;
    await f.humans.verifier!.mutation(cr.verifySupplier!, {
      scope: f.scope,
      revisionId: r.revisionId,
      verification: {
        contactId: f.supplier.contactId,
        method: "callback_previously_held_contact",
        result: "confirmed",
        performedAt: row.createdAt,
        evidence: f.proof,
        mode: "simulated",
        reason: "Synthetic callback",
      },
    });
    await expect(
      f.humans.verifier!.mutation(cr.approveSupplier!, {
        scope: f.scope,
        revisionId: r.revisionId,
        expectedHash: row.hash,
        reason: "Self approval",
      }),
    ).rejects.toThrow(/supplier_segregation/);
  });
  it("cannot finish sequential recognition after delegation expires or its grantor is retired", async () => {
    for (const mode of ["expired", "retired"]) {
      const f = await setup();
      const d = await f.humans.owner!.mutation(cr.delegate!, {
        scope: f.scope,
        idempotencyKey: "delegation",
        delegation: {
          groupId: "owner",
          toSubject: subject("delegate"),
          maxCents: 7700,
          validFrom: start,
          validUntil: start + 60000,
          reason: "Bounded delegation",
        },
      });
      const p = await f.propose();
      await expect(f.vote(p, "finance")).rejects.toThrow(
        /approval_group|required|escalation/,
      );
      expect(
        await f.vote(p, "delegate", "delegated-first", {
          delegationId: d.delegationId,
        }),
      ).toMatchObject({ status: "pending" });
      if (mode === "expired") vi.setSystemTime(start + 60001);
      else await retire(f, "owner");
      await expect(
        f.vote(p, "finance", "final-after-revocation"),
      ).rejects.toThrow(/invalid_delegation|inactive_approver/);
      expect(
        await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
      ).toEqual([]);
      expect(
        await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
      ).toEqual([]);
    }
  });
  it("retains original beneficiary after real FakeBank response loss and supplier bank-change approval", async () => {
    const f = await setup();
    await f.recognize(f.detail, acceptance(f.input, "1"));
    const p = await prepare(f, "v4-possible-send"),
      q = await authorize(f, p);
    const bank = openFakeBank({
      path: ":memory:",
      scope: f.scope,
      seed: "v4-bank-change",
      startTime: new Date(start).toISOString(),
      faults: [
        {
          operation: "createTransfer",
          call: 1,
          kind: "accept_then_lost_response",
        },
      ],
    });
    try {
      const t = f.t as unknown as KernelTransport;
      let n = 0;
      const worker = new ExecutePaymentEffect(
        createConvexPaymentKernel(t, f.scope, "test-dispatch"),
        bank.provider,
        "v4-worker",
        {
          now: Date.now,
          newLeaseToken: () => `v4-business-lease-${++n}`,
          startHeartbeat: () => () => {},
        },
      );
      await worker.tick();
      const original = (await f.t.run((ctx) => ctx.db.get(q.commandId)))!;
      expect(bank.harness.inspect().transfers).toHaveLength(1);
      await f.onboard(
        {
          ...f.supplier,
          expectedRevision: 1,
          externalAccountId: "changed-after-possible-send",
        },
        "new-bank",
      );
      await expect(prepare(f, "replacement")).rejects.toThrow(
        /stale_supplier|available/,
      );
      expect(await f.t.run((ctx) => ctx.db.get(p.versionId))).toMatchObject({
        reservations: "reserved",
        status: "queued",
      });
      vi.setSystemTime(original.nextAttemptAt);
      await worker.tick();
      const recovered = (await f.t.run((ctx) => ctx.db.get(q.commandId)))!;
      expect(recovered.command).toEqual(original.command);
      expect(recovered.command.destination.externalAccountId).toBe(
        "external-supplier-v1",
      );
      expect(bank.harness.inspect().calls.createTransfer).toBe(1);
      bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
      const rec = new ReconcilePaymentEvidence(
        createConvexPaymentEvidence(t, f.scope, "test-evidence"),
        bank.provider,
        f.scope,
        Date.now,
      );
      await rec.tick();
      await rec.tick();
      expect((await f.get(f.detail.caseId)).amounts).toMatchObject({
        acceptedCents: 3850,
        settledCents: 3850,
        outstandingCents: 0,
      });
      expect(
        await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
      ).toHaveLength(2);
    } finally {
      bank.close();
    }
  });
});

describe("V4 underlying human identity segregation", () => {
  it("cannot count two configured subject aliases for the same human seat as two quorum votes", async () => {
    const p = policy();
    p.bands[0]!.steps[0]!.quorum = 2;
    p.bands[0]!.steps[0]!.escalationGroupId = null;
    const f = await setup({ policy: p });
    // This binding shape is accepted by demoPayments.configure: distinct subjects may name one seat.
    await f.t.run(async (ctx) => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, {
        humanSubjects: config.humanSubjects.map((h) =>
          h.subject === subject("second") ? { ...h, seatId: "human-owner" } : h,
        ),
      });
    });
    const proposal = await f.propose(f.detail, acceptance(f.input, "1"));
    expect(await f.vote(proposal, "owner")).toMatchObject({
      status: "pending",
    });
    await expect(f.vote(proposal, "second")).rejects.toThrow(
      /segregation|same.*seat|independent/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toEqual([]);
  });
});
