import type {APCaseDetail} from "./contracts";
import type {BankScope} from "../payments/contracts";
export const timingMetrics=["document_to_review","review_to_post","human_wait","exception_age","unresolved_payment_age","recovery_time"] as const;
export type TimingMetric=typeof timingMetrics[number];
export type TimingPoint={id:string;at:number};
export type TimingSample={id:string;metric:TimingMetric;label:string;state:"completed"|"ongoing"|"unavailable"|"not_started";startedAt:number|null;endedAt:number|null;elapsedMs:number|null;reason:string;references:string[];revision:number|null;snapshotHash:string|null;paymentVersionId?:string;paymentSnapshotHash?:string;paymentRunIds?:string[]};
export type CaseTimings={caseId:string;revision:number;snapshotHash:string;samples:TimingSample[]};
export type OperationalTimings={scope:BankScope;asOf:number;cases:CaseTimings[]};
export type PaymentTimingFacts={versionId:string;paymentSnapshotHash:string;createdAt:number;status:string;revision:number|null;snapshotHash:string|null;paymentRunIds:string[];approved?:TimingPoint;cancelled?:TimingPoint;command?:{id:string;execution:string;firstAttemptAt?:number;uncompletedAttemptIds?:string[];release?:TimingPoint;failures:TimingPoint[];blocked:TimingPoint[];matched:({purpose:string}&TimingPoint)[]}};
export type CaseTimingFacts={detail:APCaseDetail;retained?:TimingPoint;recognition?:TimingPoint;proposals:{id:string;revision:number;snapshotHash:string;status:string;createdAt:number;completedAt?:number}[];payments:PaymentTimingFacts[]};
const validTime=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
/** No clamping: reversed/future/missing clocks are missing evidence, never zero-duration success. */
export function timingWindow(base:Omit<TimingSample,"state"|"startedAt"|"endedAt"|"elapsedMs">,asOf:number,start?:TimingPoint,end?:TimingPoint,active=true):TimingSample{
 const refs=[...new Set([...base.references,...(start?[start.id]:[]),...(end?[end.id]:[])])];
 if(!start||!validTime(start.at)||!validTime(asOf)||start.at>asOf||end&&(!validTime(end.at)||end.at<start.at||end.at>asOf))return {...base,references:refs,state:"unavailable",startedAt:validTime(start?.at)?start!.at:null,endedAt:validTime(end?.at)?end!.at:null,elapsedMs:null,reason:`${base.reason} Required event timestamps are missing, reversed or beyond this snapshot.`};
 if(!end&&!active)return {...base,references:refs,state:"unavailable",startedAt:start.at,endedAt:null,elapsedMs:null,reason:`${base.reason} The outcome exists but its completion timestamp is not retained.`};
 return {...base,references:refs,state:end?"completed":"ongoing",startedAt:start.at,endedAt:end?.at??null,elapsedMs:(end?.at??asOf)-start.at};
}
export function projectCaseTimings(f:CaseTimingFacts,asOf:number):CaseTimings{
 const d=f.detail,samples:TimingSample[]=[];
 const base=(metric:TimingMetric,id:string,label:string,reason:string,binding:{revision:number|null;snapshotHash:string|null}={revision:d.revision,snapshotHash:d.snapshotHash}):Omit<TimingSample,"state"|"startedAt"|"endedAt"|"elapsedMs">=>({metric,id,label,reason,references:[],...binding});
 const missing=(b:ReturnType<typeof base>,reason:string,state:"unavailable"|"not_started"="unavailable")=>samples.push({...b,state,startedAt:null,endedAt:null,elapsedMs:null,reason});
 const decisions=d.decisions.filter(x=>x.candidateRevision===d.revision&&x.snapshotHash===d.snapshotHash).sort((a,b)=>a.at-b.at);
 const fields=decisions.filter(x=>x.kind==="field_review"),review=fields.find(x=>x.outcome==="approved"),point=(x:{decisionId:string;at:number}|undefined)=>x?{id:x.decisionId,at:x.at}:undefined;
 samples.push(timingWindow(base("document_to_review","document-review","Current document to approved review","Current revision retained to its first approved field review; server event clock."),asOf,f.retained,point(review),d.states.document!=="reviewed"));
 const postBase=base("review_to_post","review-post","Approved review to recognition","First approved field review to the posted recognition journal for this same source revision.");
 const approval=decisions.find(x=>x.kind==="bill_approval"&&x.outcome==="approved");
 if(!review)missing(postBase,"No approved field review exists for this source revision.","not_started");
 else if(f.recognition&&!approval)missing(postBase,"The linked recognition belongs to another revision or lacks a same-revision approval event; it is not this revision's posting time.");
 else samples.push(timingWindow(postBase,asOf,point(review),f.recognition,d.states.accounting==="unposted"));
 samples.push(timingWindow(base("human_wait","field-wait","Initial field-review queue","Current revision retained in the review queue to the first human field decision, including an evidence request or rejection."),asOf,f.retained,point(fields[0]),d.states.document!=="reviewed"));
 let open:typeof fields[number]|undefined;
 for(const field of fields){if(field.outcome!=="approved"){open??=field;}else if(open){samples.push(timingWindow(base("exception_age",`field-exception:${open.decisionId}`,"Field evidence request","Explicit human evidence request/rejection to the next approved review of this same revision."),asOf,point(open),point(field)));open=undefined;}}
 if(open)samples.push(timingWindow(base("exception_age",`field-exception:${open.decisionId}`,"Field evidence request","Explicit human evidence request/rejection remains unresolved for this revision."),asOf,point(open)));
 const proposals=f.proposals.filter(p=>p.revision===d.revision&&p.snapshotHash===d.snapshotHash);
 for(const p of proposals){const b=base("human_wait",`business:${p.id}`,"Business approval queue","Business proposal creation to its completed human route, including rejection; this is queue elapsed time, not active labor.");
  if(p.status==="pending"&&d.domain?.approvalId===p.id&&d.domain.approvalStatus==="stale")missing(b,"Proposal authority is stale; no timestamp identifies when human waiting stopped.");
  else samples.push(timingWindow(b,asOf,{id:p.id,at:p.createdAt},p.completedAt===undefined?undefined:{id:p.id,at:p.completedAt},p.status==="pending"));
 }
 for(const exception of d.exceptions.filter(e=>e.status==="open")){
  const b=base("exception_age",`exception:${exception.exceptionId}`,`Current hold: ${exception.code}`,"Current computed hold; no generic updatedAt or worker heartbeat is used as its onset.");
  const p=exception.code==="business_approval_pending"?proposals.find(p=>p.id===d.domain?.approvalId&&p.status==="pending"):undefined;
  if(p)samples.push(timingWindow(b,asOf,{id:p.id,at:p.createdAt}));else missing(b,"The current hold has no persisted, specifically linked onset timestamp. Its age is not measurable from existing history.");
 }
 for(const p of f.payments){
  const binding={revision:p.revision,snapshotHash:p.snapshotHash},pb=(metric:TimingMetric,suffix:string,label:string,reason:string)=>({...base(metric,`${p.versionId}:${suffix}`,label,reason,binding),paymentVersionId:p.versionId,paymentSnapshotHash:p.paymentSnapshotHash,paymentRunIds:p.paymentRunIds,references:[p.versionId]});
  samples.push(timingWindow(pb("human_wait","approval","Payment authorization queue","Frozen payment proposal creation to its human authorization or proven cancellation; scheduling time is not human waiting."),asOf,{id:p.versionId,at:p.createdAt},p.approved??p.cancelled,p.status==="awaiting_approval"));
  const c=p.command,unresolved=pb("unresolved_payment_age","outcome","Dispatched payment to resolved outcome","First recorded dispatch claim to the verified posted-and-matched outcome or proven release. A claim means submission may have started, not that the provider received it. Unsent scheduled proposals do not start this clock.");
  if(!c||c.firstAttemptAt===undefined){
   if(!c||c.execution==="queued"||["cancelled","exception"].includes(c.execution)&&!c.failures.length&&!!c.blocked.length||c.execution==="cancelled"&&!c.failures.length)missing(unresolved,"No recorded dispatch claim: the proposal has not started this clock.","not_started");else missing(unresolved,"A payment outcome or exception exists but the original dispatch timestamp is missing.");
  }else{
   const terminal=["settled","returned","rejected","cancelled"].includes(c.execution);
   const match=c.matched.filter(t=>c.execution==="returned"?t.purpose==="return":t.purpose!=="return").sort((a,b)=>a.at-b.at)[0];
   const end=c.execution==="cancelled"?c.release??p.cancelled:match;
   samples.push(timingWindow(unresolved,asOf,{id:c.id,at:c.firstAttemptAt},end,!terminal||["settled","returned"].includes(c.execution)&&!match));
  }
  if(!c)continue;
  const failure=c.failures.slice().sort((a,b)=>a.at-b.at)[0];
  const resolved=c.matched.slice().sort((a,b)=>a.at-b.at).find(t=>failure&&t.at>=failure.at)??c.release??p.cancelled;
  const recovery=pb("recovery_time","recovery","Payment outcome recovery","First recorded failed dispatch completion to a verified posted-and-matched transaction or proven cancellation. Provider acceptance alone is not recovered accounting.");
  if(failure){samples.push(timingWindow(recovery,asOf,failure,resolved,!["rejected","cancelled"].includes(c.execution)));samples.push(timingWindow(pb("exception_age","dispatch-exception","Recorded dispatch exception","First recorded failed dispatch completion to resolved economic evidence or proven cancellation."),asOf,failure,resolved,!["rejected","cancelled"].includes(c.execution)));}
  else if(["unknown","exception"].includes(c.execution)||c.uncompletedAttemptIds?.length)missing({...recovery,references:[...recovery.references,...(c.uncompletedAttemptIds??[])]},"An unresolved or abandoned attempt has no retained failure-completion timestamp; its recovery duration is not measurable.");
  for(const blocked of c.blocked.slice().sort((a,b)=>a.at-b.at).slice(0,1)){const end=c.firstAttemptAt!==undefined&&c.firstAttemptAt>=blocked.at?{id:c.id,at:c.firstAttemptAt}:c.release??p.cancelled;samples.push(timingWindow(pb("exception_age",`blocked:${blocked.id}`,"Pre-dispatch authority hold","Persisted dispatch-block event to the first recorded dispatch claim or proven cancellation."),asOf,blocked,end));}
 }
 return {caseId:d.caseId,revision:d.revision,snapshotHash:d.snapshotHash,samples};
}
