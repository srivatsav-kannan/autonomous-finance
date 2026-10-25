import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/payments/contracts";
import { activeBusinessPolicy, assertApprovalCurrent } from "./businessAuthority";
import { loadRecognizedBusinessExport } from "./businessExport";
import { assertRowScope } from "../demoAuth";
import { canonical } from "../kernel";
import { domainRequestSchema } from "../../../src/ap-system/domain-contracts";

/** New money may consume only current, independently approved, exactly linked credits.
 * Historical possibly-sent operations skip this in assertDispatchAuthority and retain their original identity. */
export async function assertGovernedCredits(ctx: QueryCtx, scope: BankScope, credits: readonly {creditId:string;amountCents:number}[], vendor:string) {
  if (!credits.length || !await activeBusinessPolicy(ctx, scope)) return;
  for (const item of credits) {
    const id=ctx.db.normalizeId("demoCredits",item.creditId);
    const link=id ? await ctx.db.query("apCreditLinks").withIndex("by_credit",q=>q.eq("scope.runId",scope.runId).eq("creditId",id)).unique() : null;
    if (!link) throw new Error("Governed credit requires an original approved allocation link");
    assertRowScope(link,scope);
    const row=await ctx.db.get(link.caseId), approval=row?.domainApprovalId ? await ctx.db.get(row.domainApprovalId) : null;
    if (!row || row.creditId!==id || !approval) throw new Error("Governed credit current business authority missing");
    assertRowScope(row,scope); assertRowScope(approval,scope);
    await assertApprovalCurrent(ctx,scope,row,approval);
    const recognized=await loadRecognizedBusinessExport(ctx,scope,link.caseId);
    const original=await loadRecognizedBusinessExport(ctx,scope,link.originalCaseId);
    const originalApproval=await ctx.db.get(link.approvalId);
    const plan=originalApproval ? domainRequestSchema.parse(originalApproval.request).credit : null;
    if (!plan || canonical(plan)!==canonical(link.plan) || plan.originalCaseId!==link.originalCaseId || plan.originalApprovalId!==link.originalApprovalId ||
        original.kind!=="invoice" || original.billId!==link.originalBillId || original.approvalId!==link.originalApprovalId || original.supplierId!==vendor ||
        recognized.kind!=="credit" || recognized.creditId!==id || recognized.supplierId!==vendor || recognized.journalId!==link.entryId || recognized.amountCents!==link.amountCents ||
        !Number.isSafeInteger(item.amountCents) || item.amountCents<=0 || item.amountCents>recognized.amountCents)
      throw new Error("Governed credit differs from its immutable original allocation and recognition");
  }
}
