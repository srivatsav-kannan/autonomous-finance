import { afterEach, describe, it, expect, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { businessFixture, acceptance } from "./business-fixture";
import {
  creditFixture,
  seedSettled,
  successful,
} from "./quickbooks-business-fixture";
import { br } from "./business-fixture";
import {
  billPlan,
  creditPlan,
  paymentPlan,
  applicationPlan,
} from "../../src/ap-system/quickbooks/plans";
import type {
  AccountingExport,
  Mappings,
} from "../../src/ap-system/quickbooks/types";
const current = makeFunctionReference<"query">("apAccountingExport:current");
export const mappings: Mappings = {
  version: "business-reviewed-1",
  realmId: "123",
  country: "US",
  vendors: {
    "golden-state-produce": {
      id: "5",
      displayName: "Golden State Produce Co.",
    },
  },
  accounts: {
    "2000": { id: "33", name: "AP", type: "Accounts Payable" },
    "1000": { id: "35", name: "Bank", type: "Bank" },
    "5000": { id: "7", name: "Produce", type: "Expense" },
    "1200": { id: "8", name: "Inventory", type: "Other Current Asset" },
  },
  apAccount: "2000",
  bankAccount: "1000",
};
afterEach(() => vi.unstubAllEnvs());
describe("B3 recognized accounting exports", () => {
  it("exports 3850 approved cents without rewriting the 7700-cent original candidate", async () => {
    const f = await businessFixture();
    const recognition = await f.recognize(f.detail, acceptance(f.input, "1"));
    const e = (await f.humans.finance!.query(current, {
      scope: f.scope,
      caseId: f.detail.caseId,
    })) as AccountingExport;
    expect(e.detail.candidate!.totalCents).toBe(7700);
    expect(e.recognizedInvoice).toMatchObject({
      amountCents: 3850,
      approvalId: recognition.proposal.proposalId,
      allocations: [{ account: "5000", amountCents: 3850 }],
    });
    const p = billPlan(e, mappings);
    expect(p.payload.TotalAmt).toBe(38.5);
    expect((p.payload.Line as any[])[0].Amount).toBe(38.5);
    const changed = structuredClone(e);
    changed.detail.candidate!.lines[0]!.allocations[0]!.account = "1200";
    expect(billPlan(changed, mappings)).toEqual(p);
    changed.recognizedInvoice!.allocations[0]!.amountCents = 7700;
    expect(() => billPlan(changed, mappings)).toThrow(
      "recognition_allocation_mismatch",
    );
  });
  it("still refuses an altered posted B3 recognition journal", async () => {
    const f = await businessFixture();
    const recognized = await f.recognize(f.detail, acceptance(f.input, "1"));
    await f.t.run(async (ctx) => {
      const p = await ctx.db.get(recognized.proposal.proposalId as any);
      await ctx.db.patch((p as any).entryId, { status: "reversed" });
    });
    await expect(
      f.humans.finance!.query(current, {
        scope: f.scope,
        caseId: f.detail.caseId,
      }),
    ).rejects.toThrow("recognition_journal_missing");
  });
});

describe("QBO explicit credit and partial cash applications", () => {
  it("recognizes the original-linked credit, then applies a zero-cash immutable receipt without new local journal/command", async () => {
    const f = await creditFixture();
    const c = await f.credit();
    const invoice = await f.load();
    const credit = await f.load(c.caseId);
    expect(credit.recognizedCredit).toMatchObject({
      creditId: c.creditId,
      billId: f.original.billId,
      amountCents: 3850,
    });
    const bill = successful(billPlan(invoice, mappings), "90");
    const vc = successful(
      creditPlan(credit.recognizedCredit!, mappings, bill),
      "91",
    );
    const d = await f.get(f.detail.caseId);
    await f.humans.finance!.mutation(br.applyCredits!, {
      scope: f.scope,
      caseId: d.caseId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      billVersion: d.links.billVersion,
      idempotencyKey: "credit-only",
      reason: "Explicit reduction of payable",
      credits: [{ creditId: c.creditId, amountCents: 3850 }],
    });
    const app = await f.t.run((ctx) =>
      ctx.db.query("apCreditApplications").first(),
    );
    const e = await f.load(d.caseId, { creditApplicationId: app!._id });
    const plan = applicationPlan(e, mappings, bill, [vc]);
    expect(plan.payload).toMatchObject({
      TotalAmt: 0,
      Line: [
        { Amount: 38.5, LinkedTxn: [{ TxnId: "90", TxnType: "Bill" }] },
        { Amount: 38.5, LinkedTxn: [{ TxnId: "91", TxnType: "VendorCredit" }] },
      ],
    });
    expect(plan.links.creditApplicationId).toBe(app!._id);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toHaveLength(0);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(2);
    const corrupted = structuredClone(e);
    corrupted.creditApplication!.amountCents = 7700;
    expect(() => applicationPlan(corrupted, mappings, bill, [vc])).toThrow(
      "credit_application_mismatch",
    );
  });
  it("exports partial cash and cash+credit using gross application separately from actual bank amount", async () => {
    const partial = await creditFixture();
    const ps = await seedSettled(partial, 2000, 2000);
    const pe = await ps.load(partial.detail.caseId, {
      paymentVersionId: ps.versionId,
    });
    const p = paymentPlan(
      pe,
      mappings,
      successful(billPlan(pe, mappings), "90"),
    );
    expect(p.payload.TotalAmt).toBe(20);
    expect(pe.detail.amounts.outstandingCents).toBe(5700);
    const f = await creditFixture();
    const c = await f.credit();
    const s = await seedSettled(f, 3850, 7700, [
      { creditId: c.creditId, amountCents: 3850 },
    ]);
    const e = await s.load(f.detail.caseId, { paymentVersionId: s.versionId });
    const bill = successful(billPlan(e, mappings), "90");
    const credit = await s.load(c.caseId);
    const vc = successful(
      creditPlan(credit.recognizedCredit!, mappings, bill),
      "91",
    );
    const plan = paymentPlan(e, mappings, bill, [vc]);
    expect(plan.payload).toMatchObject({
      TotalAmt: 38.5,
      Line: [
        { Amount: 77, LinkedTxn: [{ TxnId: "90", TxnType: "Bill" }] },
        { Amount: 38.5, LinkedTxn: [{ TxnId: "91", TxnType: "VendorCredit" }] },
      ],
    });
    expect(e.settlement).toMatchObject({
      amountCents: 3850,
      grossAppliedCents: 7700,
    });
    await f.t.run((ctx) => ctx.db.patch(c.creditId, { consumedCents: 0 }));
    await expect(
      s.load(f.detail.caseId, { paymentVersionId: s.versionId }),
    ).rejects.toThrow("Consumed same-supplier credit required");
  });
  it("surfaces any historical return on bill-only export, not only a requested payment", async () => {
    const f = await creditFixture();
    const s = await seedSettled(f, 2000, 2000);
    await f.t.run((ctx) => ctx.db.patch(s.versionId, { status: "returned" }));
    const e = await s.load();
    expect(e.holds).toEqual([
      expect.objectContaining({
        code: "return_accounting_remediation_required",
        owner: "controller",
        relatedIds: [s.versionId],
      }),
    ]);
    expect(() => billPlan(e, mappings)).toThrow(
      "return_accounting_remediation_required",
    );
  });
  it("rejects wrong-case application IDs, altered consumed receipts, and unsupported signed credit allocations", async () => {
    const f = await creditFixture();
    const c = await f.credit();
    const d = await f.get(f.detail.caseId);
    await f.humans.finance!.mutation(br.applyCredits!, {
      scope: f.scope,
      caseId: d.caseId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      billVersion: d.links.billVersion,
      idempotencyKey: "credit-only",
      reason: "Apply",
      credits: [{ creditId: c.creditId, amountCents: 1000 }],
    });
    const app = await f.t.run((ctx) =>
      ctx.db.query("apCreditApplications").first(),
    );
    await expect(
      f.load(c.caseId, { creditApplicationId: app!._id }),
    ).rejects.toThrow("Credit recognition is not a payment");
    await f.t.run((ctx) => ctx.db.patch(app!._id, { amountCents: 1500 }));
    await expect(
      f.load(d.caseId, { creditApplicationId: app!._id }),
    ).rejects.toThrow();
    const invoice = await f.load();
    const credit = await f.load(c.caseId);
    credit.recognizedCredit!.allocations = [
      { account: "5000", amountCents: 4000 },
      { account: "1200", amountCents: -150 },
    ];
    expect(() =>
      creditPlan(
        credit.recognizedCredit!,
        mappings,
        successful(billPlan(invoice, mappings), "90"),
      ),
    ).toThrow("signed_cost_allocation_requires_review");
  });
});
