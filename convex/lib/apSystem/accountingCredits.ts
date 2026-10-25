import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import type {
  AppliedCredit,
  CreditApplication,
  RecognizedCredit,
} from "../../../src/ap-system/quickbooks/types";
import { assertRowScope } from "../demoAuth";
import { loadRecognizedBusinessExport } from "./businessExport";
export async function recognizedCredit(
  ctx: QueryCtx,
  scope: BankScope,
  creditId: Id<"demoCredits">,
): Promise<RecognizedCredit> {
  const credit = await ctx.db.get(creditId);
  assertRowScope(credit, scope);
  const link = await ctx.db
    .query("apCreditLinks")
    .withIndex("by_credit", (q) =>
      q.eq("scope.runId", scope.runId).eq("creditId", creditId),
    )
    .unique();
  assertRowScope(link, scope);
  if (!credit || !link || credit.entryId !== link.entryId)
    throw Error("Linked credit recognition required");
  const recognized = await loadRecognizedBusinessExport(
    ctx,
    scope,
    link.caseId,
  );
  if (
    recognized.kind !== "credit" ||
    recognized.creditId !== creditId ||
    recognized.supplierId !== credit.vendor ||
    recognized.amountCents !== credit.amountCents
  )
    throw Error("Credit recognition mismatch");
  return { ...recognized, kind: "credit", creditId };
}
export async function appliedCredits(
  ctx: QueryCtx,
  scope: BankScope,
  supplierId: string,
  items: Array<{ creditId: Id<"demoCredits">; amountCents: number }>,
): Promise<AppliedCredit[]> {
  if (
    new Set(items.map((i) => i.creditId)).size !== items.length ||
    items.length > 100
  )
    throw Error("Distinct bounded credit applications required");
  return Promise.all(
    [...items]
      .sort((a, b) => a.creditId.localeCompare(b.creditId))
      .map(async (item) => {
        const c = await ctx.db.get(item.creditId);
        assertRowScope(c, scope);
        if (
          !c ||
          c.vendor !== supplierId ||
          !Number.isSafeInteger(item.amountCents) ||
          item.amountCents <= 0 ||
          c.consumedCents < item.amountCents ||
          c.amountCents < item.amountCents
        )
          throw Error("Consumed same-supplier credit required");
        return {
          recognition: await recognizedCredit(ctx, scope, item.creditId),
          amountCents: item.amountCents,
        };
      }),
  );
}
/** One immutable human application receipt can contain several per-credit rows. */
export async function creditApplication(
  ctx: QueryCtx,
  scope: BankScope,
  caseId: Id<"apCaseRecords">,
  billId: Id<"demoBills">,
  applicationId: Id<"apCreditApplications">,
): Promise<CreditApplication> {
  const row = await ctx.db.get(applicationId);
  assertRowScope(row, scope);
  if (!row || row.caseId !== caseId || row.billId !== billId || !row.actor)
    throw Error("Credit application case mismatch");
  const bill = await ctx.db.get(billId);
  assertRowScope(bill, scope);
  if (!bill) throw Error("Bill required");
  const group = (
    await ctx.db
      .query("apCreditApplications")
      .withIndex("by_bill", (q) =>
        q.eq("scope.runId", scope.runId).eq("billId", billId),
      )
      .collect()
  )
    .filter((a) => a.requestKey === row.requestKey)
    .sort((a, b) => a._id.localeCompare(b._id));
  if (
    !group.length ||
    group.some(
      (g) =>
        g.caseId !== caseId ||
        g.actor !== row.actor ||
        !Number.isSafeInteger(g.amountCents) ||
        g.amountCents <= 0,
    )
  )
    throw Error("Invalid immutable credit application");
  for (const g of group) assertRowScope(g, scope);
  const amount = group.reduce((n, g) => n + g.amountCents, 0);
  if (
    !Number.isSafeInteger(amount) ||
    amount > bill.paidCents ||
    amount > (bill.approvedCents ?? 0)
  )
    throw Error("Credit application exceeds bill");
  const receipt = await ctx.db
    .query("apCaseOperations")
    .withIndex("by_key", (q) =>
      q
        .eq("scope.runId", scope.runId)
        .eq("key", `credit-application:${row.requestKey}`),
    )
    .unique();
  assertRowScope(receipt, scope);
  if (
    !receipt ||
    receipt.result?.billId !== billId ||
    receipt.result.appliedCents !== amount ||
    receipt.result.cashCents !== 0
  )
    throw Error("Credit application receipt mismatch");
  return {
    applicationId: group[0]!._id,
    applicationIds: group.map((g) => g._id),
    requestKey: row.requestKey,
    billId,
    date: new Date(Math.min(...group.map((g) => g.at)))
      .toISOString()
      .slice(0, 10),
    amountCents: amount,
    credits: await appliedCredits(ctx, scope, bill.vendor, group),
  };
}
