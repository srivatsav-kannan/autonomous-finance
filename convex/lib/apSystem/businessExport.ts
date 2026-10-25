import type { QueryCtx } from "../../_generated/server";
import type { BankScope } from "../../../src/integrations/contracts";
import { intakeSchema } from "../../../src/ap-system/contracts";
import { domainRequestSchema } from "../../../src/ap-system/domain-contracts";
import { acceptanceJournal } from "../../../src/ap-system/business-policy";
import { canonical } from "../kernel";
import { caseRow, deny } from "./shared";
import { assertRowScope } from "../demoAuth";
import type { CreditAllocation } from "./businessLedger";
export type RecognizedBusinessExport = {
  kind: "invoice" | "credit";
  caseId: string; billId: string; journalId: string; supplierId: string;
  reference: string; date: string; amountCents: number;
  allocations: {account: string; amountCents: number}[];
  approvalId: string; sourceRevision: number; sourceSnapshotHash: string;
  creditId: string | null;
};
/** Historical recognition is exported from its originally approved snapshot, never re-costed from later extraction. */
export async function loadRecognizedBusinessExport(ctx: QueryCtx, scope: BankScope, caseId: string): Promise<RecognizedBusinessExport> {
  const row = await caseRow(ctx, scope, caseId);
  const bill = row.billId ? await ctx.db.get(row.billId) : null;
  const credit = row.creditId ? await ctx.db.get(row.creditId) : null;
  const entryId = bill?.entryId ?? credit?.entryId;
  if (!entryId) deny("recognition_required", "Posted business recognition required");
  if (bill) assertRowScope(bill, scope); if (credit) assertRowScope(credit, scope);
  const approval = (await ctx.db.query("apApprovalProposals").withIndex("by_case", (q) => q.eq("scope.runId", scope.runId).eq("caseId", row._id)).collect()).filter((p) => p.status === "approved" && p.entryId === entryId).sort((a,b)=>a.createdAt-b.createdAt)[0];
  if (!approval) deny("original_approval_missing", "Original B3 recognition approval is unavailable");
  const request = domainRequestSchema.parse(approval.request);
  const revision = await ctx.db.query("apCaseRevisions").withIndex("by_case", (q) => q.eq("scope.runId", scope.runId).eq("caseId", row._id).eq("revision", request.expectedRevision)).unique();
  if (!revision || revision.snapshotHash !== request.snapshotHash) deny("original_revision_missing", "Original approved evidence snapshot is unavailable");
  const candidate = intakeSchema.parse(revision.intake).candidate;
  if (!candidate?.supplierId || candidate.currency !== "USD") deny("original_candidate_invalid", "Original supplier/currency evidence is unavailable");
  const journal = await ctx.db.get(entryId);
  if (!journal || journal.runId !== scope.runId || journal.status !== "posted") deny("recognition_journal_missing", "Posted recognition journal is unavailable");
  let expected: {account:string;debit:number;credit:number;dims:Record<string,string>}[];
  let allocations: RecognizedBusinessExport["allocations"];
  let originalBillId = bill?._id as string | undefined;
  if (request.acceptance && bill && candidate.kind === "invoice") {
    if (bill.vendor !== candidate.supplierId || bill.approvedCents !== approval.amountCents || bill.originalCents !== candidate.totalCents || journal.source.kind !== "bill" || journal.source.ref !== bill._id) deny("recognition_mismatch", "Original bill/approval/journal differ");
    expected = acceptanceJournal(request.acceptance, candidate.supplierId);
    allocations = expected.filter((l)=>l.account !== "2000").map((l)=>({account:l.account,amountCents:l.debit-l.credit}));
  } else if (request.credit && credit && candidate.kind === "credit_note") {
    const link = await ctx.db.query("apCreditLinks").withIndex("by_credit", (q)=>q.eq("scope.runId",scope.runId).eq("creditId",credit._id)).unique();
    if (!link || link.entryId !== entryId || link.approvalId !== approval._id || credit.vendor !== candidate.supplierId || credit.amountCents !== approval.amountCents || link.amountCents !== credit.amountCents || journal.source.kind !== "vendor_credit" || journal.source.ref !== row._id) deny("credit_recognition_mismatch", "Credit original-allocation linkage differs from its journal");
    const cost = link.allocations as CreditAllocation[];
    expected = cost.map((a)=>({account:a.account,debit:a.side === "debit" ? a.amountCents : 0,credit:a.side === "credit" ? a.amountCents : 0,dims:{vendor:candidate.supplierId!,...(a.store?{store:a.store}:{})}}));
    expected.push({account:"2000",debit:credit.amountCents,credit:0,dims:{vendor:candidate.supplierId}});
    allocations = cost.map((a)=>({account:a.account,amountCents:a.side === "credit" ? a.amountCents : -a.amountCents}));
    originalBillId = link.originalBillId;
  } else deny("recognition_kind_mismatch", "Recognition kind does not match its original approved plan");
  const financial = (lines: {account:string;debit:number;credit:number;dims?:unknown}[]) => lines.map(({account,debit,credit,dims})=>({account,debit,credit,dims}));
  if (canonical(financial(expected)) !== canonical(financial(journal.lines))) deny("recognition_journal_mismatch", "Posted journal does not equal approved allocations");
  if (allocations.reduce((n,a)=>n+a.amountCents,0) !== approval.amountCents) deny("recognition_allocation_mismatch", "Signed cost allocations do not equal recognized amount");
  return {kind:bill?"invoice":"credit",caseId:row._id,billId:originalBillId!,journalId:entryId,supplierId:candidate.supplierId,reference:candidate.invoiceNumber,date:journal.date,amountCents:approval.amountCents,allocations,approvalId:approval._id,sourceRevision:request.expectedRevision,sourceSnapshotHash:request.snapshotHash,creditId:credit?._id??null};
}
