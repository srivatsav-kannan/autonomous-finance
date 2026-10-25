import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { assertRowScope, auditDemo, requirePaymentHuman, requirePaymentSeat } from "./lib/demoAuth";
import { requestPaymentCommand, approveAndQueueCommand, cancelUnsent } from "./lib/payments/applyCommand";

const binding = {scope:scopeValidator, caseId:v.id("apCaseRecords"), expectedRevision:v.number(), snapshotHash:v.string()};
/** Resolve a reviewed case to an existing bill inside the same serializable mutation. */
export const request = mutation({
  args:{...binding,seatId:v.string(),token:v.string(),idempotencyKey:v.string(),executionDate:v.optional(v.string()),amountCents:v.optional(v.number()),credits:v.optional(v.array(v.object({creditId:v.id("demoCredits"),amountCents:v.number()})))},
  handler:async(ctx,args)=>{
    await requirePaymentSeat(ctx,args,["payments"]);
    const row=await ctx.db.get(args.caseId);assertRowScope(row,args.scope);
    const ap=row as Doc<"apCaseRecords">;
    if(ap.currentRevision!==args.expectedRevision||ap.snapshotHash!==args.snapshotHash)throw Error("Stale AP case payment request");
    if(ap.businessStatus!=="approved"||ap.documentStatus!=="reviewed"||!ap.fieldReviewId||!ap.billId)throw Error("Reviewed and approved AP case required before payment preparation");
    const bill=await ctx.db.get(ap.billId);assertRowScope(bill,args.scope);
    if(!(bill as Doc<"demoBills">).entryId)throw Error("Recognized payable required before payment preparation");
    const result=await requestPaymentCommand(ctx,{scope:args.scope,seatId:args.seatId,token:args.token,requestKey:args.idempotencyKey,billIds:[ap.billId],credits:args.credits??[],...(args.executionDate!==undefined?{executionDate:args.executionDate}:{}),...(args.amountCents!==undefined?{billAmounts:[{billId:ap.billId,amountCents:args.amountCents}]}:{})});
    const version=await ctx.db.get(result.versionId);
    // The existing operation is authoritative on retry; never replace its request key.
    if(!version||!version.snapshot.bills.some(b=>b.billId===ap.billId))throw Error("Payment does not belong to AP case");
    await auditDemo(ctx,args.scope,args.seatId,"ap_case_payment_prepared",{caseId:args.caseId,revision:ap.currentRevision,caseSnapshot:ap.snapshotHash,versionId:result.versionId});
    return result;
  },
});
export const authorize = mutation({
  args:{...binding,versionId:v.id("demoVersions"),paymentSnapshotHash:v.string()},
  handler:async(ctx,args)=>{
    const {seat}=await requirePaymentHuman(ctx,args.scope);
    const row=await ctx.db.get(args.caseId);assertRowScope(row,args.scope);const ap=row as Doc<"apCaseRecords">;
    if(ap.currentRevision!==args.expectedRevision||ap.snapshotHash!==args.snapshotHash||ap.businessStatus!=="approved"||ap.documentStatus!=="reviewed"||!ap.billId)throw Error("Stale or unapproved AP case payment authorization");
    const version=await ctx.db.get(args.versionId);assertRowScope(version,args.scope);
    const payment=version as Doc<"demoVersions">;
    if(payment.snapshot.bills.length!==1||payment.snapshot.bills[0]!.billId!==ap.billId)throw Error("Payment belongs to another AP case");
    const result=await approveAndQueueCommand(ctx,{scope:args.scope,versionId:args.versionId,snapshotHash:args.paymentSnapshotHash});
    await auditDemo(ctx,args.scope,seat.seatId,"ap_case_payment_authorized",{caseId:ap._id,caseRevision:ap.currentRevision,caseSnapshot:ap.snapshotHash,versionId:args.versionId,commandId:result.commandId});
    return result;
  },
});
/** Cancelling an unsubmitted proposal is separate from changing its frozen authorized scope. */
export const cancel = mutation({
  args:{...binding,versionId:v.id("demoVersions")},
  handler:async(ctx,args)=>{
    const {seat}=await requirePaymentHuman(ctx,args.scope);
    const row=await ctx.db.get(args.caseId);assertRowScope(row,args.scope);const ap=row as Doc<"apCaseRecords">;
    if(ap.currentRevision!==args.expectedRevision||ap.snapshotHash!==args.snapshotHash||!ap.billId)throw Error("Stale AP case cancellation");
    const version=await ctx.db.get(args.versionId);assertRowScope(version,args.scope);
    if(!version||version.snapshot.bills.length!==1||version.snapshot.bills[0]!.billId!==ap.billId)throw Error("Payment belongs to another AP case");
    if(version.status==="cancelled")return {ok:true as const};
    await cancelUnsent(ctx,version);
    await auditDemo(ctx,args.scope,seat.seatId,"ap_case_payment_cancelled",{caseId:ap._id,versionId:version._id,snapshotHash:version.snapshotHash});
    return {ok:true as const};
  },
});
/** Authenticated audit projection; no lease credentials or raw provider payloads. */
export const detail = query({
  args:{scope:scopeValidator,versionId:v.id("demoVersions")},
  handler:async(ctx,args)=>{
    await requirePaymentHuman(ctx,args.scope);
    const row=await ctx.db.get(args.versionId);assertRowScope(row,args.scope);const version=row as Doc<"demoVersions">;
    const command=await ctx.db.query("demoCommands").withIndex("by_command",q=>q.eq("scope.runId",args.scope.runId).eq("command.commandId",args.versionId)).unique();
    const observations=(await ctx.db.query("demoObservations").withIndex("by_run",q=>q.eq("scope.runId",args.scope.runId)).collect()).filter(o=>o.observation.commandId===args.versionId);
    const transactions=(await ctx.db.query("demoTransactions").withIndex("by_run",q=>q.eq("scope.runId",args.scope.runId)).collect()).filter(t=>t.transaction.commandId===args.versionId);
    const entries=await Promise.all(transactions.filter(t=>t.entryId).map(t=>ctx.db.get(t.entryId!)));
    return {versionId:version._id,snapshot:version.snapshot,snapshotHash:version.snapshotHash,approvals:version.approvals,status:version.status,reservations:version.reservations,
      command:command?{effectId:command._id,operationId:command.command.commandId,idempotencyKey:command.command.idempotencyKey,requestHash:command.command.requestHash,execution:command.execution,posting:command.posting,reconciliation:command.reconciliation,attemptCount:command.attemptCount,providerTransferId:command.providerTransferId??null}:null,
      observations:observations.map(o=>o.observation),transactions:transactions.map(t=>t.transaction), transactionPostings:transactions.map(t=>({transactionId:t.transaction.id,state:t.state,journalId:t.entryId??null})),
      journals:entries.filter((e):e is Doc<"journalEntries">=>e!==null).map(e=>({entryId:e._id,date:e.date,source:e.source,lines:e.lines,status:e.status}))};
  },
});
