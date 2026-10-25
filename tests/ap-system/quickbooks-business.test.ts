import { afterEach, describe, it, expect, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { businessFixture, acceptance } from "./business-fixture";
import { billPlan } from "../../src/ap-system/quickbooks/plans";
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
