import {query} from "./_generated/server";
import {scopeValidator} from "./demoSchema";
import {requirePaymentHuman} from "./lib/demoAuth";
import {projectCase} from "./lib/apSystem/projection";
import {sameBankScope} from "../src/payments/contracts";
import {projectCaseTimings,type OperationalTimings,type PaymentTimingFacts} from "../src/ap-system/operational-timing";
/** Read-only operational durations. Worker health and provider clocks are not business events. */
export const current=query({args:{scope:scopeValidator},handler:async(ctx,{scope}):Promise<OperationalTimings>=>{
 await requirePaymentHuman(ctx,scope);
 const asOf=Date.now();
 const [allCases,allVersions,allCommands,allRuns,allTransactions,activities]=await Promise.all([
  ctx.db.query("apCaseRecords").withIndex("by_run",q=>q.eq("scope.runId",scope.runId)).collect(),
  ctx.db.query("demoVersions").withIndex("by_run",q=>q.eq("scope.runId",scope.runId)).collect(),
  ctx.db.query("demoCommands").withIndex("by_run",q=>q.eq("scope.runId",scope.runId)).collect(),
  ctx.db.query("apPaymentRuns").withIndex("by_run",q=>q.eq("scope.runId",scope.runId)).collect(),
  ctx.db.query("demoTransactions").withIndex("by_run",q=>q.eq("scope.runId",scope.runId)).collect(),
  ctx.db.query("activity").withIndex("by_run_at",q=>q.eq("runId",scope.runId)).collect(),
 ]);
 const rows=allCases.filter(r=>sameBankScope(r.scope,scope)),versions=allVersions.filter(r=>sameBankScope(r.scope,scope)),commands=allCommands.filter(r=>sameBankScope(r.scope,scope)),runs=allRuns.filter(r=>sameBankScope(r.scope,scope)),transactions=allTransactions.filter(r=>sameBankScope(r.scope,scope));
 const cases=await Promise.all(rows.map(async row=>{
  const [detail,revisions,proposals]=await Promise.all([projectCase(ctx,row),ctx.db.query("apCaseRevisions").withIndex("by_case",q=>q.eq("scope.runId",scope.runId).eq("caseId",row._id)).collect(),ctx.db.query("apApprovalProposals").withIndex("by_case",q=>q.eq("scope.runId",scope.runId).eq("caseId",row._id)).collect()]);
  const revision=revisions.find(r=>r.revision===row.currentRevision&&r.snapshotHash===row.snapshotHash&&sameBankScope(r.scope,scope));
  const bill=row.billId?await ctx.db.get(row.billId):null,credit=row.creditId?await ctx.db.get(row.creditId):null;
  const entryId=bill?.entryId??credit?.entryId,entry=entryId?await ctx.db.get(entryId):null;
  const payments=await Promise.all(versions.filter(v=>row.billId&&v.snapshot.bills.some(b=>b.billId===row.billId)).map(async (v):Promise<PaymentTimingFacts>=>{
   const command=commands.find(c=>c.versionId===v._id),memberRuns=runs.filter(r=>r.items.some(i=>i.caseId===row._id&&i.versionId===v._id&&i.paymentSnapshotHash===v.snapshotHash));
   const preparation=activities.find(a=>a.kind==="ap_case_payment_prepared"&&a.refs?.caseId===row._id&&a.refs?.versionId===v._id);
   const member=memberRuns.flatMap(r=>r.items).find(i=>i.versionId===v._id&&i.caseId===row._id);
   const frozen=member?{revision:member.caseRevision,snapshotHash:member.caseSnapshotHash}:preparation?{revision:preparation.refs.revision,snapshotHash:preparation.refs.caseSnapshot}:null;
   const source=frozen&&revisions.some(r=>r.revision===frozen.revision&&r.snapshotHash===frozen.snapshotHash&&sameBankScope(r.scope,scope))?frozen:null;
   const human=v.approvals.filter(a=>a.kind==="human"&&a.snapshotHash===v.snapshotHash).sort((a,b)=>a.at-b.at)[0];
   const cancellation=activities.filter(a=>["payment_cancelled","ap_case_payment_cancelled"].includes(a.kind)&&a.refs?.versionId===v._id||a.kind==="ap_payment_run_cancelled"&&memberRuns.some(r=>r._id===a.refs?.runId)).sort((a,b)=>a.at-b.at)[0];
   const attempts=command?(await ctx.db.query("demoAttempts").withIndex("by_command",q=>q.eq("commandId",command._id)).collect()).filter(a=>sameBankScope(a.scope,scope)):[];
   const failures=attempts.filter(a=>a.completedAt!==undefined&&(a.errorClass!==undefined||a.result==="unknown"||a.result==="exception")).map(a=>({id:a._id,at:a.completedAt!}));
   const blocked=command?activities.filter(a=>a.kind==="payment_dispatch_blocked"&&a.refs?.commandId===command._id).map(a=>({id:a._id,at:a.at})).sort((a,b)=>a.at-b.at):[];
   const matched=command?transactions.filter(t=>t.commandRowId===command._id&&t.state==="posted"&&t.entryId&&t.matchedAt!==undefined).map(t=>({id:t._id,at:t.matchedAt!,purpose:t.transaction.purpose})):[];
   return {versionId:v._id,createdAt:v.createdAt,status:v.status,revision:source?.revision??null,snapshotHash:source?.snapshotHash??null,paymentSnapshotHash:v.snapshotHash,paymentRunIds:memberRuns.map(r=>r._id),...(human?{approved:{id:`${v._id}:human-approval`,at:human.at}}:{}),...(cancellation?{cancelled:{id:cancellation._id,at:cancellation.at}}:{}),...(command?{command:{id:command._id,execution:command.execution,firstAttemptAt:command.firstAttemptAt,uncompletedAttemptIds:attempts.filter(a=>a.completedAt===undefined&&a.generation<command.generation).map(a=>a._id),failures,blocked,matched,...(command.release?{release:{id:`${command._id}:release`,at:command.release.at}}:{})}}:{})};
  }));
  return projectCaseTimings({detail,retained:revision?{id:revision._id,at:revision.at}:undefined,recognition:entry&&entry.runId===scope.runId&&entry.status==="posted"?{id:entry._id,at:entry.postedAt}:undefined,proposals:proposals.filter(p=>sameBankScope(p.scope,scope)).map(p=>({id:p._id,revision:p.request?.expectedRevision,snapshotHash:p.request?.snapshotHash,status:p.status,createdAt:p.createdAt,completedAt:p.completedAt})),payments},asOf);
 }));
 return {scope,asOf,cases};
}});
