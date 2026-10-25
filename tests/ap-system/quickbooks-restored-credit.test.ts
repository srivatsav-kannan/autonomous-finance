import { afterEach, describe, it, expect, vi } from "vitest";
import { br } from "./business-fixture";
import { seedSettled } from "./quickbooks-business-fixture";
import { restoredCreditFixture } from "./quickbooks-restored-credit-fixture";
afterEach(() => vi.unstubAllEnvs());
describe("approved zero-bank-effect restored-credit authority", () => {
  it("binds exact existing application and distinct current approval without changing local journal/bank history", async () => {
    const f = await restoredCreditFixture();
    expect(f.afterApplication).toEqual(f.beforeApplication);
    expect(f.applicationResult).toMatchObject({
      appliedCents: 3850,
      cashCents: 0,
    });
    expect(
      await f.humans.finance!.mutation(br.applyCredits!, f.applicationInput),
    ).toEqual(f.applicationResult);
    const p = await f.proposeCorrection(f.allocationRequest);
    expect(await f.proposeCorrection(f.allocationRequest)).toEqual(p);
    await expect(f.currentCorrection(p.proposalId)).rejects.toThrow(
      /approved_correction_required/,
    );
    await f.voteCorrection(p);
    await f.voteCorrection(p, "finance");
    const c = await f.currentCorrection(p.proposalId);
    expect(c).toMatchObject({
      kind: "credit_allocation",
      amountCents: 3850,
      originalBillCents: 1850,
      creditApplication: {
        applicationIds: [f.application._id],
        amountCents: 3850,
        credits: [
          { recognition: { creditId: f.credit.creditId }, amountCents: 3850 },
        ],
      },
      restoredPayables: [
        {
          amountCents: 2000,
          correction: { correctionId: f.returned.proposalId },
        },
      ],
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toEqual(f.beforeApplication.commands);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toEqual(f.beforeApplication.journals);
    await expect(
      f.proposeCorrection({
        ...f.allocationRequest,
        idempotencyKey: "duplicate",
      }),
    ).rejects.toThrow(/correction_identity_exists|restored_payable_exhausted/);
  });
  it("shares returned-principal capacity with later cash allocations and rejects changed application economics", async () => {
    const f = await restoredCreditFixture(undefined, 2000);
    const p = await f.proposeCorrection(f.allocationRequest);
    await f.voteCorrection(p);
    await f.voteCorrection(p, "finance");
    const s = await seedSettled(f, 1, 1, [], "-over-consumption");
    await expect(
      f.proposeCorrection({
        kind: "payment_allocation",
        caseId: f.detail.caseId,
        paymentVersionId: s.versionId,
        originalBillCents: 0,
        restoredPayables: [
          { correctionId: f.returned.proposalId, amountCents: 1 },
        ],
        idempotencyKey: "over",
        reason: "Must not reuse credit-consumed restored principal",
      }),
    ).rejects.toThrow(/restored_payable_exhausted/);
    await f.t.run((ctx) =>
      ctx.db.patch(f.application._id, { amountCents: 1999 }),
    );
    await expect(f.currentCorrection(p.proposalId)).rejects.toThrow(
      /receipt mismatch|stale_correction_authority|Credit application/,
    );
  });
  it("requires exact sums, case-bound application and current independent seats", async () => {
    const f = await restoredCreditFixture();
    await expect(
      f.proposeCorrection({ ...f.allocationRequest, originalBillCents: 1849 }),
    ).rejects.toThrow(/allocation_sum/);
    await expect(
      f.proposeCorrection({ ...f.allocationRequest, caseId: f.credit.caseId }),
    ).rejects.toThrow(
      /recognized_bill_required|recognized_invoice_required|case mismatch/,
    );
    const p = await f.proposeCorrection(f.allocationRequest);
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
      /approval_segregation|approval_identity_changed/,
    );
  });
});
