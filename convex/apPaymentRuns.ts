import { assertPaymentRelease } from "./lib/apSystem/paymentRelease";
import { safeSumCents } from "../src/payments/domain/rules";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { scopeValidator } from "./demoSchema";
import { paymentRunSelection } from "./apPaymentRunSchema";
import { assertRowScope, auditDemo, requirePaymentHuman, requirePaymentSeat } from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { approveAndQueueCommand, cancelUnsent, requestPaymentCommand } from "./lib/payments/applyCommand";
import { businessDateSchema } from "../src/payments/domain/validation";
import type { BankScope } from "../src/payments/contracts";

async function currentCase(ctx:MutationCtx,scope:BankScope,item:{caseId:Id<"apCaseRecords">;expectedRevision:number;snapshotHash:string}) {
  const row=await ctx.db.get(item.caseId);assertRowScope(row,scope);const ap=row as Doc<"apCaseRecords">;
  if(ap.currentRevision!==item.expectedRevision||ap.snapshotHash!==item.snapshotHash||ap.documentStatus!=="reviewed"||ap.businessStatus!=="approved"||!ap.fieldReviewId||!ap.billId)throw Error("Payment run contains a stale or unapproved case");
  const bill=await ctx.db.get(ap.billId);assertRowScope(bill,scope);if(!bill?.entryId)throw Error("Recognized payable required for payment run");
  return ap.billId;
}
const frozen=(row:Pick<Doc<"apPaymentRuns">,"scope"|"selection"|"executionDate"|"items">)=>({scope:row.scope,selection:row.selection,executionDate:row.executionDate??null,items:row.items});
/** A run groups existing immutable payment proposals. Every case keeps its own operation/key. */
export const prepare=mutation({
 args:{scope:scopeValidator,seatId:v.string(),token:v.string(),requestKey:v.string(),selection:v.array(paymentRunSelection),executionDate:v.optional(v.string())},
 handler:async(ctx,args)=>{
  await requirePaymentSeat(ctx,args,["payments"]);
  if(!args.requestKey.trim()||args.selection.length<1||args.selection.length>25||new Set(args.selection.map(i=>i.caseId)).size!==args.selection.length)throw Error("Select one to 25 distinct AP cases");
  if(args.executionDate!==undefined)businessDateSchema.parse(args.executionDate);
  const selection=args.selection.map(i=>({...i,...(i.credits?{credits:i.credits.slice().sort((a,b)=>a.creditId.localeCompare(b.creditId))}:{})})).sort((a,b)=>a.caseId.localeCompare(b.caseId));
  const previous=await ctx.db.query("apPaymentRuns").withIndex("by_key",q=>q.eq("scope.runId",args.scope.runId).eq("requestKey",args.requestKey)).unique();
  if(previous){assertRowScope(previous,args.scope);if(previous.requestedBy!==args.seatId||canonical(previous.selection)!==canonical(selection)||previous.executionDate!==args.executionDate)throw Error("Payment run idempotency conflict");return {runId:previous._id,snapshotHash:previous.snapshotHash};}
  const items=[];
  for(const item of selection){
   const billId=await currentCase(ctx,args.scope,item);
   const version=await requestPaymentCommand(ctx,{scope:args.scope,seatId:args.seatId,token:args.token,requestKey:`ap-run:${args.requestKey}:${item.caseId}`,billIds:[billId],credits:item.credits??[],...(item.amountCents!==undefined?{billAmounts:[{billId,amountCents:item.amountCents}]}:{}),...(args.executionDate!==undefined?{executionDate:args.executionDate}:{})});
   items.push({caseId:item.caseId,caseRevision:item.expectedRevision,caseSnapshotHash:item.snapshotHash,versionId:version.versionId,paymentSnapshotHash:version.snapshotHash});
  }
  const record={scope:args.scope,requestKey:args.requestKey,requestedBy:args.seatId,selection,...(args.executionDate!==undefined?{executionDate:args.executionDate}:{}),items,createdAt:Date.now()};
  const snapshotHash=await sha256Hex(canonical(frozen(record)));const runId=await ctx.db.insert("apPaymentRuns",{...record,snapshotHash});
  await auditDemo(ctx,args.scope,args.seatId,"ap_payment_run_prepared",{runId,snapshotHash,caseIds:items.map(i=>i.caseId)});
  return {runId,snapshotHash};
 }
});
export const authorize=mutation({
 args:{scope:scopeValidator,runId:v.id("apPaymentRuns"),snapshotHash:v.string()},
 handler:async(ctx,args)=>{
  const {seat,subject}=await requirePaymentHuman(ctx,args.scope);const row=await ctx.db.get(args.runId);assertRowScope(row,args.scope);const run=row as Doc<"apPaymentRuns">;
  if(run.requestedBy===seat.seatId||run.snapshotHash!==args.snapshotHash||await sha256Hex(canonical(frozen(run)))!==run.snapshotHash)throw Error("Stale or self-approved payment run");
  const versions=await Promise.all(run.items.map(item=>ctx.db.get(item.versionId)));
  const aggregateAmountCents=safeSumCents(versions.map(version=>{assertRowScope(version,args.scope);if(!version)throw Error("Missing payment run member");return version.snapshot.amountCents;}));
  for(const version of versions) await assertPaymentRelease(ctx,args.scope,version!.snapshot,subject,{aggregateAmountCents});
  const commands=[];
  // One Convex mutation: a stale member rolls back every newly queued command.
  for(const item of run.items){
   const billId=await currentCase(ctx,args.scope,{caseId:item.caseId,expectedRevision:item.caseRevision,snapshotHash:item.caseSnapshotHash});
   const version=await ctx.db.get(item.versionId);assertRowScope(version,args.scope);
   if(!version||version.snapshot.bills.length!==1||version.snapshot.bills[0]!.billId!==billId||version.snapshotHash!==item.paymentSnapshotHash)throw Error("Payment run member no longer matches frozen scope");
   commands.push(await approveAndQueueCommand(ctx,{scope:args.scope,versionId:item.versionId,snapshotHash:item.paymentSnapshotHash}));
  }
  await auditDemo(ctx,args.scope,seat.seatId,"ap_payment_run_authorized",{runId:run._id,snapshotHash:run.snapshotHash,commandIds:commands.map(c=>c.commandId)});
  return {commandIds:commands.map(c=>c.commandId)};
 }
});
export const cancel=mutation({
 args:{scope:scopeValidator,runId:v.id("apPaymentRuns"),snapshotHash:v.string()},
 handler:async(ctx,args)=>{
  const {seat}=await requirePaymentHuman(ctx,args.scope);const row=await ctx.db.get(args.runId);assertRowScope(row,args.scope);const run=row as Doc<"apPaymentRuns">;
  if(run.snapshotHash!==args.snapshotHash||await sha256Hex(canonical(frozen(run)))!==run.snapshotHash)throw Error("Stale payment run cancellation");
  for(const item of run.items){const version=await ctx.db.get(item.versionId);assertRowScope(version,args.scope);if(!version)throw Error("Missing run member");if(version.status!=="cancelled")await cancelUnsent(ctx,version);}
  await auditDemo(ctx,args.scope,seat.seatId,"ap_payment_run_cancelled",{runId:run._id,snapshotHash:run.snapshotHash});return {ok:true as const};
 }
});
export const detail=query({
 args:{scope:scopeValidator,runId:v.id("apPaymentRuns")},
 handler:async(ctx,args)=>{
  await requirePaymentHuman(ctx,args.scope);const row=await ctx.db.get(args.runId);assertRowScope(row,args.scope);const run=row as Doc<"apPaymentRuns">;
  const items=await Promise.all(run.items.map(async item=>{const version=await ctx.db.get(item.versionId);assertRowScope(version,args.scope);return {...item,payment:version?{snapshot:version.snapshot,snapshotHash:version.snapshotHash,status:version.status,approvals:version.approvals}:null};}));
  return {runId:run._id,scope:run.scope,requestedBy:run.requestedBy,snapshotHash:run.snapshotHash,executionDate:run.executionDate??null,createdAt:run.createdAt,items};
 }
});
export const list=query({args:{scope:scopeValidator},handler:async(ctx,args)=>{await requirePaymentHuman(ctx,args.scope);return (await ctx.db.query("apPaymentRuns").withIndex("by_run",q=>q.eq("scope.runId",args.scope.runId)).collect()).map(row=>({runId:row._id,snapshotHash:row.snapshotHash,caseIds:row.items.map(i=>i.caseId),executionDate:row.executionDate??null,createdAt:row.createdAt}));}});
