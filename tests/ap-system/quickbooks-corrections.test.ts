import { seedSettled } from "./quickbooks-business-fixture";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  returnedFixture,
  correctionRefs,
} from "./quickbooks-corrections-fixture";
afterEach(() => vi.unstubAllEnvs());
describe("controller-proposed immutable QBO return authority", () => {
  it("reserves exact restored capacity and rejects duplicates, wrong sums and over-allocation", async () => {
    const f = await returnedFixture();
    const p = await f.proposeCorrection();
    await f.voteCorrection(p);
    await f.voteCorrection(p, "finance");
    const next = await seedSettled(f, 2000, 2000, [], "-next");
    const input = {
      kind: "payment_allocation",
      caseId: f.detail.caseId,
      paymentVersionId: next.versionId,
      originalBillCents: 1000,
      restoredPayables: [{ correctionId: p.proposalId, amountCents: 1000 }],
      idempotencyKey: "allocate",
      reason: "Exact approved allocation",
    };
    await expect(
      f.proposeCorrection({ ...input, originalBillCents: 999 }),
    ).rejects.toThrow(/allocation_sum/);
    await expect(
      f.proposeCorrection({
        ...input,
        restoredPayables: [
          ...input.restoredPayables,
          ...input.restoredPayables,
        ],
      }),
    ).rejects.toThrow(/duplicate_restored_payable/);
    const a = await f.proposeCorrection(input);
    await f.voteCorrection(a);
    await f.voteCorrection(a, "finance");
    const e = await f.currentCorrection(a.proposalId);
    expect(e).toMatchObject({
      kind: "payment_allocation",
      originalBillCents: 1000,
      amountCents: 2000,
    });
    const originalOnly = await seedSettled(f, 1000, 1000, [], "-original-only");
    const o = await f.proposeCorrection({
      ...input,
      paymentVersionId: originalOnly.versionId,
      originalBillCents: 1000,
      restoredPayables: [],
      idempotencyKey: "original-only",
    });
    await f.voteCorrection(o);
    await f.voteCorrection(o, "finance");
    expect(await f.currentCorrection(o.proposalId)).toMatchObject({
      kind: "payment_allocation",
      originalBillCents: 1000,
      restoredPayables: [],
    });
    const second = await seedSettled(f, 1001, 1001, [], "-second");
    await expect(
      f.proposeCorrection({
        ...input,
        paymentVersionId: second.versionId,
        originalBillCents: 0,
        restoredPayables: [{ correctionId: p.proposalId, amountCents: 1001 }],
        idempotencyKey: "over",
      }),
    ).rejects.toThrow(/restored_payable_exhausted/);
  });

  it("requires explicit sequential human approval and preserves existing cash/AP journals", async () => {
    const f = await returnedFixture();
    const before = await f.t.run((ctx) =>
      ctx.db.query("journalEntries").collect(),
    );
    const p = await f.proposeCorrection();
    expect(await f.proposeCorrection()).toEqual(p);
    await expect(f.currentCorrection(p.proposalId)).rejects.toThrow(
      /approved_correction_required/,
    );
    expect(await f.voteCorrection(p)).toMatchObject({ status: "pending" });
    await expect(f.currentCorrection(p.proposalId)).rejects.toThrow(
      /approved_correction_required/,
    );
    expect(await f.voteCorrection(p, "finance")).toMatchObject({
      status: "approved",
    });
    const e = await f.currentCorrection(p.proposalId);
    expect(e).toMatchObject({
      kind: "bank_return",
      amountCents: 2000,
      returnJournalId: f.entryId,
      returnTransactionId: f.transactionId,
      original: { paymentVersionId: f.versionId, amountCents: 2000 },
      proposalHash: p.proposalHash,
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toEqual(before);
    expect(await f.voteCorrection(p, "finance")).toMatchObject({
      status: "approved",
    });
  });
  it("rejects non-controller proposal, mismatched return, unposted/closed journal and unauthenticated read", async () => {
    const f = await returnedFixture();
    await expect(
      f.t.mutation(correctionRefs.propose, {
        scope: f.scope,
        seatId: "ap_clerk",
        token: "token-ap_clerk",
        input: f.request,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      f.proposeCorrection({ ...f.request, returnTransactionId: "unrelated" }),
    ).rejects.toThrow(/return_identity_mismatch/);
    await expect(
      f.t.query(correctionRefs.proposals, {
        scope: f.scope,
        caseId: f.detail.caseId,
      }),
    ).rejects.toThrow(/authenticated/);
    await f.t.run((ctx) => ctx.db.patch(f.txId, { state: "exception" }));
    await expect(f.proposeCorrection()).rejects.toThrow(
      /bank_evidence_unresolved/,
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.txId, { state: "posted" });
      const period = (await ctx.db.query("periods").first())!;
      await ctx.db.patch(period._id, { status: "closed" });
    });
    await expect(f.proposeCorrection()).rejects.toThrow(
      /accounting_period_closed/,
    );
  });
  it("revalidates current evidence, policy and distinct retained human seats", async () => {
    const f = await returnedFixture();
    const p = await f.proposeCorrection();
    await f.voteCorrection(p);
    await f.t.run(async (ctx) => {
      const cfg = (await ctx.db.query("demoConfigs").first())!;
      await ctx.db.patch(cfg._id, {
        humanSubjects: cfg.humanSubjects.map((h) =>
          h.subject.endsWith("|finance") ? { ...h, seatId: "human-owner" } : h,
        ),
      });
    });
    await expect(f.voteCorrection(p, "finance")).rejects.toThrow(
      /approval_segregation/,
    );
    const g = await returnedFixture();
    const q = await g.proposeCorrection();
    await g.voteCorrection(q);
    await g.voteCorrection(q, "finance");
    await g.t.run((ctx) => ctx.db.patch(g.entryId, { hash: "d".repeat(64) }));
    await expect(g.currentCorrection(q.proposalId)).rejects.toThrow(
      /stale_correction_authority/,
    );
  });
});
