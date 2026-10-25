import type { MutationCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import { cancelUnsent } from "../payments/applyCommand";
/** Governance changes release only unattempted operations; possible sends remain reserved. */
export async function invalidateBusinessPayments(
  ctx: MutationCtx,
  scope: BankScope,
  supplierId?: string,
) {
  const rows = await ctx.db
    .query("apCaseRecords")
    .withIndex("by_run", (q) => q.eq("scope.runId", scope.runId))
    .collect();
  const visited = new Set<string>();
  for (const row of rows) {
    if (
      !row.domainApprovalId ||
      !row.billId ||
      (supplierId && row.intake.candidate?.supplierId !== supplierId)
    )
      continue;
    const bill = await ctx.db.get(row.billId);
    if (!bill?.reservedVersionId || visited.has(bill.reservedVersionId))
      continue;
    visited.add(bill.reservedVersionId);
    const version = await ctx.db.get(bill.reservedVersionId);
    const command = await ctx.db
      .query("demoCommands")
      .withIndex("by_command", (q) =>
        q
          .eq("scope.runId", scope.runId)
          .eq("command.commandId", bill.reservedVersionId!),
      )
      .unique();
    if (
      version &&
      (!command ||
        (command.attemptCount === 0 &&
          command.firstAttemptAt === undefined &&
          command.generation === 0 &&
          !command.providerTransferId))
    )
      await cancelUnsent(ctx, version);
  }
}
