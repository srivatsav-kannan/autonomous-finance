import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { BankScope } from "../../../src/integrations/contracts";
import { deny, assertNoHistoricalPaymentForInvoice } from "./shared";
import { assertRowScope } from "../demoAuth";
/** AP source/review policy cannot be bypassed via older aggregate bill APIs. */
export async function requireNonAPCaseBill(
  ctx: QueryCtx,
  scope: BankScope,
  billId: Id<"demoBills">,
) {
  const bill = await ctx.db.get(billId);
  assertRowScope(bill, scope);
  await assertNoHistoricalPaymentForInvoice(ctx, scope, bill!.vendor, bill!.invoiceNumber);
  const linked = await ctx.db
    .query("apCaseRecords")
    .withIndex("by_bill", (q) =>
      q.eq("scope.runId", scope.runId).eq("billId", billId),
    )
    .unique();
  if (linked)
    deny(
      "ap_case_review_required",
      "Linked AP bills require the versioned case review/correction workflow",
    );
}
