import type {APCaseDetail} from "../src/ap-system/contracts";
import type {OperationalTimings,TimingSample} from "../src/ap-system/operational-timing";
/** Synthetic presentation evidence only. No provider, approval or bank operation is represented as real. */
export function timingUIFixture(cases:APCaseDetail[]):OperationalTimings {
 if(!cases.length)throw Error("A scoped synthetic case is required");
 const asOf=Date.parse("2026-10-25T12:00:00Z");
 return {scope:cases[0]!.scope,asOf,cases:cases.map((c,index)=>{
  const sample=(id:string,metric:TimingSample["metric"],elapsedMs:number|null,state:TimingSample["state"]):TimingSample=>({id:`${c.caseId}:${id}`,metric,label:`Synthetic ${id} interval`,state,elapsedMs,startedAt:elapsedMs===null?null:asOf-elapsedMs-(state==="completed"?60_000:0),endedAt:state==="completed"?asOf-60_000:null,reason:"Synthetic persisted-event example for presentation checks only; no backend event or economic action was performed.",references:[`synthetic-event:${c.caseId}:${id}`],revision:c.revision,snapshotHash:c.snapshotHash});
  return {caseId:c.caseId,revision:c.revision,snapshotHash:c.snapshotHash,samples:[sample("review","document_to_review",300_000+index*60_000,"completed"),sample("posting","review_to_post",index===0?900_000:120_000,index===0?"ongoing":"completed"),sample("human route","human_wait",index===0?1_800_000:240_000,index===0?"ongoing":"completed"),sample("unknown hold onset","exception_age",null,"unavailable"),sample("unsent proposal","unresolved_payment_age",null,"not_started"),sample("no recorded failure","recovery_time",null,"not_started")]};
 })};
}
