import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { scopeValidator, assertRowScope, requirePaymentSeat, requirePaymentHuman } from "./lib/demoAuth";
import { canonical, sha256Hex } from "./lib/kernel";
import { caseRow, readAuth, replay, receipt } from "./lib/apSystem/shared";
import { projectCase } from "./lib/apSystem/projection";
import { ensureAPCaseWork, changeAPCaseWork, recordWorkTransition } from "./lib/apSystem/agentWork";
import { prepareAPCasePayment } from "./lib/apSystem/casePayment";
import { AP_AGENT_VERSION, apCaseProgress, planAPCase } from "../src/ap-system/agent-policy";
import { workControlSchema } from "../src/ap-system/work-contracts";
import { modelDecisionSchema, type APModelDecision } from "../src/ap-system/agent-decision";

const agent = { scope: scopeValidator, seatId: v.string(), token: v.string() };
const LEASE_MS=30_000, POLL_MS=5_000, WAIT_MS=24*60*60*1000, MAX_ATTEMPTS=4, MAX_TRANSITIONS=64;
type Work=Doc<"apCaseWork">;
async function facts(ctx:MutationCtx,w:Work){
  const row=await caseRow(ctx,w.scope,w.caseId),detail=await projectCase(ctx,row);
  return {row,detail,plan:planAPCase(detail),fingerprint:await sha256Hex(canonical(apCaseProgress(detail)))};
}
async function escalate(ctx:MutationCtx,w:Work,actor:string,reason:string,operationId:string,decision?:APModelDecision,actorRole:string=w.role){
  const row=await caseRow(ctx,w.scope,w.caseId);
  await changeAPCaseWork(ctx,row,w,{status:"escalated",stage:"operator_resolution",owner:"controller",reason,leaseOwner:undefined,leaseUntil:undefined,nextCheckAt:Number.MAX_SAFE_INTEGER,updatedAt:Date.now()},
    {actor,actorKind:"agent",authority:`${actorRole}:work`,action:"escalated",operationId,decision});
}
export const enroll=mutation({args:{...agent,caseId:v.string()},handler:async(ctx,args)=>{
  await requirePaymentSeat(ctx,args,["ap_clerk"]);
  return ensureAPCaseWork(ctx,await caseRow(ctx,args.scope,args.caseId));
}});
export const inspect=query({args:{scope:scopeValidator,seatId:v.optional(v.string()),token:v.optional(v.string()),caseId:v.string()},handler:async(ctx,args)=>{
  await readAuth(ctx,args);
  const detail=await projectCase(ctx,await caseRow(ctx,args.scope,args.caseId));
  return {detail,plan:planAPCase(detail),work:detail.work??null};
}});
/** Bounded persistent polling closes lost-notification and event-before-wait races. */
export const claim=mutation({args:{...agent,requestId:v.string()},handler:async(ctx,args)=>{
  const {seat}=await requirePaymentSeat(ctx,args,["ap_clerk","payments"]);
  if(!args.requestId||args.requestId.length>160)throw Error("Invalid claim request identity");
  const op=await replay(ctx,args.scope,`agent-claim:${args.requestId}`,{actor:seat.seatId});
  if(op.prior)return op.prior.result;
  const now=Date.now();
  let recordedTransition=false;
  const rows=await ctx.db.query("apCaseWork").withIndex("by_due",q=>q.eq("scope.runId",args.scope.runId).lte("nextCheckAt",now)).take(50);
  for(const old of rows){
    assertRowScope(old,args.scope);
    if(["paused","escalated"].includes(old.status))continue;
    const operationId=`work:${old._id}:claim:${args.requestId}`;
    if(old.version!==AP_AGENT_VERSION){await escalate(ctx,old,seat.seatId,"Worker/schema version mismatch requires operator migration.",operationId,undefined,seat.role);recordedTransition=true;continue;}
    if(old.status==="leased"&&(old.leaseUntil??0)>now)continue;
    const f=await facts(ctx,old),changed=old.fingerprint!==f.fingerprint,recoveryChanged=old.attemptFingerprint!==f.fingerprint;
    if(!changed&&["waiting","complete"].includes(old.status)){
      if(old.status==="waiting"&&(old.deadlineAt??Infinity)<=now){await escalate(ctx,old,seat.seatId,"Wait deadline expired; owner must resolve missing evidence or approval.",operationId,undefined,seat.role);recordedTransition=true;}
      else await ctx.db.patch(old._id,{nextCheckAt:now+POLL_MS});
      continue;
    }
    if(old.transitions>=MAX_TRANSITIONS||(!recoveryChanged&&old.attempts>=MAX_ATTEMPTS)){
      await escalate(ctx,old,seat.seatId,"Case progress or recovery budget exhausted; explicit operator resume required.",operationId,undefined,seat.role);recordedTransition=true;continue;
    }
    const role=f.plan.role;
    if(role!==seat.role){
      if(old.status==="queued"&&old.role===role&&old.stage===f.plan.stage&&old.owner===f.plan.owner&&old.reason===f.plan.reason&&canonical(old.requirements)===canonical(f.plan.requirements))continue;
      recordedTransition=true;
      await changeAPCaseWork(ctx,f.row,old,{status:"queued",role,stage:f.plan.stage,owner:f.plan.owner,reason:f.plan.reason,requirements:f.plan.requirements,attemptFingerprint:f.fingerprint,attempts:recoveryChanged?0:old.attempts,leaseOwner:undefined,leaseUntil:undefined,nextCheckAt:now,updatedAt:now},
        {actor:seat.seatId,actorKind:"agent",authority:`${seat.role}:work`,action:"handoff",operationId});
      continue;
    }
    const generation=old.generation+1;
    await changeAPCaseWork(ctx,f.row,old,{status:"leased",role,attemptFingerprint:f.fingerprint,leaseOwner:seat.seatId,leaseUntil:now+LEASE_MS,nextCheckAt:now+LEASE_MS,generation,attempts:recoveryChanged?1:old.attempts+1,claimRequestId:args.requestId,updatedAt:now},
      {actor:seat.seatId,actorKind:"agent",authority:`seat:${seat.role}`,action:"claimed",operationId,reason:"Scoped worker claimed the current work lease."});
    const result={caseId:old.caseId,generation,leaseUntil:now+LEASE_MS};
    await receipt(ctx,args.scope,`agent-claim:${args.requestId}`,op.payloadHash,result);
    return result;
  }
  if(recordedTransition)await receipt(ctx,args.scope,`agent-claim:${args.requestId}`,op.payloadHash,null);
  return null;
}});
/** Lease fencing, proposal and its work transition are one authoritative transaction. */
export const advance=mutation({args:{...agent,caseId:v.string(),generation:v.number(),decision:v.optional(v.any())},handler:async(ctx,args)=>{
  const {seat}=await requirePaymentSeat(ctx,args,["ap_clerk","payments"]);
  const row=await caseRow(ctx,args.scope,args.caseId);
  const w=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",args.scope.runId).eq("caseId",row._id)).unique();
  if(!w)throw Error("Case work not enrolled");
  assertRowScope(w,args.scope);
  if(w.lastCompletedGeneration===args.generation&&w.lastCompletedBy===seat.seatId)return {status:w.status,stage:w.stage,replayed:true};
  if(w.version!==AP_AGENT_VERSION||w.status!=="leased"||w.leaseOwner!==seat.seatId||w.role!==seat.role||w.generation!==args.generation||(w.leaseUntil??0)<=Date.now())throw Error("Stale or foreign AP case lease");
  let f=await facts(ctx,w);
  const operationId=`work:${w._id}:advance:${args.generation}`;
  const decision=args.decision===undefined?undefined:modelDecisionSchema.parse(args.decision);
  if(decision){
    const ids=new Set([...(f.detail.candidate?.evidence??[]),...f.detail.extraction.evidence].map(e=>e.evidenceId));
    if(decision.inspectedRevision!==f.row.currentRevision||decision.inspectedSnapshotHash!==f.row.snapshotHash||decision.evidenceIds.some(id=>!ids.has(id)))throw Error("Stale model decision or unknown source evidence");
    if(decision.action==="handoff"){
      await escalate(ctx,w,seat.seatId,decision.reason,operationId,decision,seat.role);
      await ctx.db.patch(w._id,{lastCompletedGeneration:args.generation,lastCompletedBy:seat.seatId});
      return {status:"escalated",stage:"operator_resolution",replayed:false};
    }
  }
  if(f.plan.role!==seat.role){
    await changeAPCaseWork(ctx,row,w,{status:"queued",role:f.plan.role,stage:f.plan.stage,owner:f.plan.owner,reason:f.plan.reason,requirements:f.plan.requirements,leaseOwner:undefined,leaseUntil:undefined,nextCheckAt:Date.now(),lastCompletedGeneration:args.generation,lastCompletedBy:seat.seatId,updatedAt:Date.now()},
      {actor:seat.seatId,actorKind:"agent",authority:`${seat.role}:work`,action:"handoff",operationId,decision});
    return {status:"queued",stage:f.plan.stage,replayed:false};
  }
  const modelWait=decision?.action==="wait";
  if(f.plan.action==="prepare_payment"&&!modelWait){
    await prepareAPCasePayment(ctx,{scope:args.scope,seatId:args.seatId,token:args.token,caseId:row._id,expectedRevision:f.row.currentRevision,snapshotHash:f.row.snapshotHash,idempotencyKey:`ap-agent:${row._id}:${f.row.currentRevision}:${f.row.snapshotHash}`});
    f=await facts(ctx,w);
  }
  const now=Date.now(),status=f.plan.action==="complete"&&!modelWait?"complete":"waiting";
  const unchanged=w.fingerprint===f.fingerprint&&w.stage===f.plan.stage;
  const stage=modelWait&&f.plan.action!=="wait"?"model_review":f.plan.stage;
  await changeAPCaseWork(ctx,f.row,w,{status,stage,role:f.plan.role,owner:modelWait&&f.plan.action!=="wait"?"controller":f.plan.owner,reason:decision?.reason??f.plan.reason,requirements:modelWait&&f.plan.action!=="wait"?["model_review"]:f.plan.requirements,fingerprint:f.fingerprint,nextCheckAt:now+POLL_MS,waitSince:status==="waiting"?(unchanged?(w.waitSince??now):now):undefined,deadlineAt:status==="waiting"?(unchanged?(w.deadlineAt??now+WAIT_MS):now+WAIT_MS):undefined,transitions:w.transitions+1,attempts:0,leaseOwner:undefined,leaseUntil:undefined,lastCompletedGeneration:args.generation,lastCompletedBy:seat.seatId,updatedAt:now},
    {actor:seat.seatId,actorKind:"agent",authority:`${seat.role}:guarded_case_progress`,action:"advanced",operationId,decision});
  return {status,stage,replayed:false};
}});
/** Only definite model/domain failure escalates. Unknown transport outcome keeps its original lease. */
export const failed=mutation({args:{...agent,caseId:v.string(),generation:v.number(),failureKind:v.optional(v.union(v.literal("model_decision_failed"),v.literal("backend_policy_rejected")))},handler:async(ctx,args)=>{
  const {seat}=await requirePaymentSeat(ctx,args,["ap_clerk","payments"]);
  const row=await caseRow(ctx,args.scope,args.caseId);
  const w=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",args.scope.runId).eq("caseId",row._id)).unique();
  if(!w||w.status!=="leased"||w.leaseOwner!==seat.seatId||w.generation!==args.generation||(w.leaseUntil??0)<=Date.now())return {stale:true};
  await escalate(ctx,w,seat.seatId,args.failureKind==="model_decision_failed"?"Model decision failed or exceeded its budget; operator review required. No automatic fallback was performed.":"Current backend policy refused advancement; inspect the case before resuming.",`work:${w._id}:failed:${args.generation}`,undefined,seat.role);
  return {stale:false};
}});
/** Human-only exact-state control; never authorizes or cancels a bank payment. */
export const control=mutation({args:{scope:scopeValidator,caseId:v.string(),action:v.union(v.literal("pause"),v.literal("resume")),reason:v.string(),expectedGeneration:v.number(),expectedRevision:v.number(),snapshotHash:v.string(),idempotencyKey:v.string()},handler:async(ctx,args)=>{
  const {subject}=await requirePaymentHuman(ctx,args.scope);
  const {scope,...input}=args;
  const parsed=workControlSchema.parse(input);
  const row=await caseRow(ctx,scope,parsed.caseId);
  const op=await replay(ctx,scope,`work-control:${parsed.idempotencyKey}`,{...parsed,subject});
  if(op.prior)return op.prior.result;
  const w=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",scope.runId).eq("caseId",row._id)).unique();
  if(!w)throw Error("Case work not enrolled");
  const operationId=`work:${w._id}:control:${parsed.idempotencyKey}`;
  if(w.generation!==parsed.expectedGeneration||row.currentRevision!==parsed.expectedRevision||row.snapshotHash!==parsed.snapshotHash){
    await recordWorkTransition(ctx,row,w,w,{actor:subject,actorKind:"human",authority:"human_cfo:work_control",action:"control_denied",operationId,reason:"Control denied because the displayed work or source revision changed. Refresh before retrying.",outcome:"denied"});
    const result={ok:false,code:"stale_work_control"};
    await receipt(ctx,scope,`work-control:${parsed.idempotencyKey}`,op.payloadHash,result);
    return result;
  }
  await changeAPCaseWork(ctx,row,w,{status:parsed.action==="pause"?"paused":"queued",stage:parsed.action==="pause"?"paused":"check_case",owner:"ap_clerk",role:"ap_clerk",reason:parsed.reason,requirements:[],generation:w.generation+1,attempts:0,transitions:0,fingerprint:undefined,leaseOwner:undefined,leaseUntil:undefined,lastCompletedGeneration:undefined,lastCompletedBy:undefined,waitSince:undefined,deadlineAt:undefined,nextCheckAt:parsed.action==="pause"?Number.MAX_SAFE_INTEGER:Date.now(),updatedAt:Date.now()},
    {actor:subject,actorKind:"human",authority:"human_cfo:work_control",action:parsed.action==="pause"?"paused":"resumed",operationId});
  const result={ok:true};
  await receipt(ctx,scope,`work-control:${parsed.idempotencyKey}`,op.payloadHash,result);
  return result;
}});
