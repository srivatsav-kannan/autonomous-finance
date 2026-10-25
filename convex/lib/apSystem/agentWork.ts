import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { AP_AGENT_VERSION } from "../../../src/ap-system/agent-policy";
import { AP_POLICY_VERSION, intakeSchema } from "../../../src/ap-system/contracts";
import { AP_WORK_CONTRACT_VERSION, workSnapshotSchema, workTransitionSchema, type APWorkTransition, type APWorkView } from "../../../src/ap-system/work-contracts";
import { activeBusinessPolicy } from "./businessAuthority";
import { assertRowScope } from "../demoAuth";
import { bindings } from "./shared";

type Work = Doc<"apCaseWork">;
type WorkPatch = Partial<Omit<Work, "_id" | "_creationTime">>;
export function workSnapshot(w: Work) {
  return workSnapshotSchema.parse({status:w.status,stage:w.stage,owner:w.owner,role:w.role,reason:w.reason,requirements:w.requirements,generation:w.generation,waitSince:w.waitSince??null,deadlineAt:w.deadlineAt??null});
}
export async function readAPCaseWork(ctx:QueryCtx,row:Doc<"apCaseRecords">):Promise<APWorkView|null> {
  const w=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",row.scope.runId).eq("caseId",row._id)).unique();
  if(!w)return null;
  assertRowScope(w,row.scope);
  return {...workSnapshot(w),workId:w._id,caseId:row._id,version:w.version,updatedAt:w.updatedAt};
}
type TransitionMeta={actor:string;actorKind:APWorkTransition["actorKind"];authority:string;action:APWorkTransition["action"];operationId:string;reason?:string;outcome?:"committed"|"denied";decision?:unknown};
/** Only approved work fields are snapshotted: never credentials, tokens or raw originals. */
export async function recordWorkTransition(ctx:MutationCtx,row:Doc<"apCaseRecords">,before:Work|null,after:Work,meta:TransitionMeta) {
  const previous=before?workSnapshot(before):null,current=workSnapshot(after);
  const changes=(Object.keys(current) as (keyof typeof current)[]).filter(field=>JSON.stringify(previous?.[field]??null)!==JSON.stringify(current[field])).map(field=>({field,before:previous?.[field]??null,after:current[field]}));
  const policy=await activeBusinessPolicy(ctx,row.scope);
  const transition=workTransitionSchema.parse({contractVersion:AP_WORK_CONTRACT_VERSION,workId:after._id,operationId:meta.operationId,action:meta.action,actorKind:meta.actorKind,authority:meta.authority,workerVersion:after.version,policyVersion:policy?.version??AP_POLICY_VERSION,caseRevision:row.currentRevision,snapshotHash:row.snapshotHash,sourceBindings:bindings(intakeSchema.parse(row.intake)),before:previous,after:current,changes,outcome:meta.outcome??"committed",...(meta.decision?{decision:meta.decision}:{})});
  await ctx.db.insert("apCaseWorkEvents",{scope:row.scope,caseId:row._id,actor:meta.actor,stage:after.stage,reason:meta.reason??after.reason,revision:row.currentRevision,snapshotHash:row.snapshotHash,generation:after.generation,at:Date.now(),transition});
}
/** The work mutation and its diff are committed or rolled back together by Convex. */
export async function changeAPCaseWork(ctx:MutationCtx,row:Doc<"apCaseRecords">,before:Work,patch:WorkPatch,meta:TransitionMeta) {
  assertRowScope(before,row.scope);
  await ctx.db.patch(before._id,patch);
  const after=(await ctx.db.get(before._id))!;
  await recordWorkTransition(ctx,row,before,after,meta);
  return after;
}
/** Enrollment is atomic with intake; it grants no review or bank authority. */
export async function ensureAPCaseWork(ctx:MutationCtx,row:Doc<"apCaseRecords">) {
  const prior=await ctx.db.query("apCaseWork").withIndex("by_case",q=>q.eq("scope.runId",row.scope.runId).eq("caseId",row._id)).unique();
  if(prior){
    assertRowScope(prior,row.scope);
    // Poll scheduling is operational bookkeeping; it does not change work ownership or outcome.
    if(!["paused","escalated"].includes(prior.status))await ctx.db.patch(prior._id,{nextCheckAt:Date.now()});
    return prior._id;
  }
  const now=Date.now();
  const id=await ctx.db.insert("apCaseWork",{scope:row.scope,caseId:row._id,version:AP_AGENT_VERSION,status:"queued",role:"ap_clerk",stage:"check_case",owner:"ap_clerk",reason:"New source case awaits agent policy check.",requirements:[],nextCheckAt:now,generation:0,attempts:0,transitions:0,createdAt:now,updatedAt:now});
  await recordWorkTransition(ctx,row,null,(await ctx.db.get(id))!,{actor:row.createdBy,actorKind:"agent",authority:"ap_clerk:ingest",action:"created",operationId:`work:${id}:created`});
  return id;
}
