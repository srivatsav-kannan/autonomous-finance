import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { taxBusinessFixture } from "./tax-business-fixture";
import { cr } from "./business-fixture";
import { readTaxState } from "../../convex/lib/apSystem/taxAdjustments";
import { promoteIncrease } from "./quickbooks-business-fixture";
import type { CloseExportLoader } from "../../src/ap-system/quickbooks/close-sync";
import type { CloseReceiptAccessLoader } from "../../src/ap-system/quickbooks/close-receipt-types";
import type {
  AccountingExport,
  Mappings,
} from "../../src/ap-system/quickbooks/types";
export const taxMappings: Mappings = {
  version: "explicit-tax-test",
  realmId: "123",
  country: "US",
  apAccount: "2000",
  bankAccount: "1000",
  vendors: {
    "golden-state-produce": {
      id: "5",
      displayName: "Golden State Produce Co.",
    },
  },
  classes: { "sf-hayes-valley": { id: "9", name: "SF" } },
  accounts: {
    "1000": { id: "1", name: "Bank", type: "Bank" },
    "2000": { id: "2", name: "AP", type: "Accounts Payable" },
    "5000": { id: "4", name: "Produce", type: "Expense" },
    "1180": {
      id: "8",
      name: "Reviewed tax receivable",
      type: "Other Current Asset",
    },
  },
  dimensions: {
    version: "ap-qbo-dimensions-v1",
    policyId: "reviewed-test",
    reviewedBy: "test-controller",
    reviewedAt: 1,
    departmentAsLocation: {
      mode: "department_as_location",
      locations: { operations: { id: "11", name: "Operations" } },
    },
  },
};
export async function taxFixture() {
  const f = await taxBusinessFixture({ settlementDepartment: true });
  const original = await f.propose(f.detail, f.a);
  await f.approve(original);
  const before = await f.state(),
    entry = before.journals[0]!;
  f.policy.version = "test-tax-50-percent";
  const rule = f.policy.taxCodes.find((t) => t.code === "TEST")!.recovery!;
  rule.recoverableBps = 5000;
  rule.adjustments = {
    mode: "reviewed_remaining_tax",
    attribution: "explicit_original_allocation",
    creditRounding: "half_up_cumulative_latest_adjustment",
  };
  const next = await f.t.mutation(cr.proposePolicy!, {
    ...f.controller,
    idempotencyKey: f.policy.version,
    policy: f.policy,
  });
  const p = await f.t.run((ctx) =>
    ctx.db.get(next.policyId as Id<"apBusinessPolicies">),
  );
  await f.humans.governor!.mutation(cr.activatePolicy!, {
    scope: f.scope,
    policyId: next.policyId,
    expectedHash: p!.hash,
    reason: "Explicit synthetic changed eligibility",
  });
  const s = await f.t.run((ctx) => readTaxState(ctx, f.scope, entry._id));
  const proposed = await f.t.mutation(f.close, {
    ...f.controller,
    input: {
      idempotencyKey: "tax-adjustment",
      action: {
        kind: "tax_adjustment",
        originalEntryId: entry._id,
        originalApprovalId: original.proposalId,
        costSnapshotHash: s.costSnapshotHash,
        taxSnapshotHash: s.snapshotHash,
        targets: [{ originalLineId: "line-1", recoverableCents: 385 }],
        movements: [
          {
            from: { ...s.buckets[0]!, amountCents: 385 },
            toAccount: "5000",
            toTreatment: "expense",
          },
        ],
        date: "2026-10-19",
        eligibilityEvidence: f.a.lines[0]!.tax!.eligibilityEvidence,
        reason: "Reviewed synthetic adjustment",
      },
    },
  });
  for (const step of proposed.route) {
    const who =
      step.groupId === "tax-review"
        ? "second"
        : step.groupId === "owner"
          ? "owner"
          : "finance";
    await f.humans[who]!.mutation(
      makeFunctionReference<"mutation">("apClose:vote"),
      {
        scope: f.scope,
        input: {
          actionId: proposed.actionId,
          actionHash: proposed.actionHash,
          idempotencyKey: `tax-${step.groupId}`,
          outcome: "approved",
          reason: "Independent exact synthetic tax review",
        },
      },
    );
  }
  const promoted = await promoteIncrease({
    ...f,
    original: { billId: before.bills[0]!._id } as any,
  });
  await f.t.run(async (ctx) => {
    for (const r of await ctx.db.query("apCloseActions").collect())
      await ctx.db.patch(r._id, { scope: promoted.scope });
  });
  const scope = promoted.scope,
    request = { actionId: proposed.actionId };
  const load: CloseExportLoader = async (input) => ({
    ...(await f.humans.finance!.query(
      makeFunctionReference<"query">("apClose:accountingExport"),
      { scope, input },
    )),
    scope,
  });
  const access: CloseReceiptAccessLoader = async (input) => {
    const a = await f.humans.finance!.query(
      makeFunctionReference<"query">("apAccountingReceiptAccess:tax"),
      { scope, input },
    );
    if (!a) throw Error("missing tax access");
    return a;
  };
  const invoice = (await promoted.load()) as AccountingExport;
  return { ...f, scope, request, load, access, invoice, before, entry };
}
