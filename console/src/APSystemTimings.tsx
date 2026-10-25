import {useEffect,useState} from "react";
import type {APCaseDetail} from "../../src/ap-system/contracts";
import {timingMetrics,type TimingMetric,type TimingSample,type OperationalTimings} from "../../src/ap-system/operational-timing";
import {sameBankScope} from "../../src/payments/contracts";
import {apSystemApi,apError} from "./apSystemApi";
const labels:Record<TimingMetric,string>={document_to_review:"Document to review",review_to_post:"Review to post",human_wait:"Human waiting",exception_age:"Exception age",unresolved_payment_age:"Unresolved payment age",recovery_time:"Recovery time"};
export function elapsedLabel(value:number|null){
 if(value===null||!Number.isFinite(value)||value<0)return "Not measurable";
 if(value<1000)return `${value} ms`;
 const seconds=Math.floor(value/1000);if(seconds<60)return `${seconds}s`;
 const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m ${seconds%60}s`;
 const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ${minutes%60}m`;
 return `${Math.floor(hours/24)}d ${hours%24}h`;
}
export function timingsMatchCases(data:OperationalTimings,cases:APCaseDetail[]){
 return !!data&&Number.isSafeInteger(data.asOf)&&data.asOf>=0&&Array.isArray(data.cases)&&data.cases.length===cases.length&&cases.every(c=>sameBankScope(c.scope,data.scope)&&data.cases.some(t=>t.caseId===c.caseId&&t.revision===c.revision&&t.snapshotHash===c.snapshotHash&&Array.isArray(t.samples)));
}
export function timingSummary(samples:TimingSample[],metric:TimingMetric){
 const selected=samples.filter(s=>s.metric===metric),completed=selected.filter(s=>s.state==="completed"&&s.elapsedMs!==null).map(s=>s.elapsedMs!).sort((a,b)=>a-b),ongoing=selected.filter(s=>s.state==="ongoing"&&s.elapsedMs!==null).map(s=>s.elapsedMs!);
 const i=Math.floor(completed.length/2);return {completed:completed.length,median:completed.length?completed.length%2?completed[i]!:Math.round((completed[i-1]!+completed[i]!)/2):null,ongoing:ongoing.length,oldest:ongoing.length?Math.max(...ongoing):null,unavailable:selected.filter(s=>s.state==="unavailable").length,notStarted:selected.filter(s=>s.state==="not_started").length};
}
export function APTimingSummary({data}:{data:OperationalTimings}){
 const samples=data.cases.flatMap(c=>c.samples);
 return <div className="aps-table-wrap"><table><thead><tr><th>Measure</th><th>Completed durations</th><th>Ongoing ages</th><th>Coverage</th></tr></thead><tbody>{timingMetrics.map(metric=>{const s=timingSummary(samples,metric);return <tr key={metric}><td data-label="Measure">{labels[metric]}</td><td data-label="Completed durations">{s.completed?`Median ${elapsedLabel(s.median)}`:"No completed measurement"}<small>{s.completed} completed intervals</small></td><td data-label="Ongoing ages">{s.ongoing?`Oldest ${elapsedLabel(s.oldest)}`:"No ongoing measurement"}<small>{s.ongoing} ongoing intervals</small></td><td data-label="Coverage">{s.unavailable} not measurable / {s.notStarted} not started</td></tr>;})}</tbody></table></div>;
}
export function APTimingRecords({samples}:{samples:TimingSample[]}){
 const time=(value:number|null)=>value===null?"Not recorded":new Date(value).toLocaleString();
 return <div className="aps-table-wrap"><table><thead><tr><th>Recorded interval</th><th>Result</th><th>Event evidence</th></tr></thead><tbody>{samples.map(s=><tr key={s.id}><td data-label="Recorded interval">{labels[s.metric]}<small>{s.label}</small></td><td data-label="Result">{s.state==="not_started"?"Not started":s.state==="unavailable"?"Not measurable":`${s.state==="completed"?"Completed duration":"Ongoing age"}: ${elapsedLabel(s.elapsedMs)}`}<small>{s.revision===null?"Historical source revision not recorded":`Source revision ${s.revision}`}</small></td><td data-label="Event evidence"><details><summary>Inspect timing basis</summary><p>{s.reason}</p><dl className="aps-record"><div><dt>Start</dt><dd>{time(s.startedAt)}</dd></div><div><dt>Completion</dt><dd>{time(s.endedAt)}</dd></div></dl>{s.snapshotHash&&<p>Source snapshot <code>{s.snapshotHash}</code></p>}{s.paymentVersionId&&<p>Payment version <code>{s.paymentVersionId}</code></p>}{s.paymentSnapshotHash&&<p>Payment snapshot <code>{s.paymentSnapshotHash}</code></p>}{s.paymentRunIds?.map(id=><p key={id}>Payment run <code>{id}</code></p>)}<ul>{s.references.map(ref=><li key={ref}><code>{ref}</code></li>)}</ul></details></td></tr>)}</tbody></table></div>;
}
export function APSystemTimings({cases,onOpenCase}:{cases:APCaseDetail[];onOpenCase?:(id:string)=>void}){
 const[reload,setReload]=useState(0),[result,setResult]=useState<{key:string;data?:OperationalTimings;error?:string}>(),[selected,setSelected]=useState("");
 const key=JSON.stringify(cases.map(c=>[c.caseId,c.revision,c.snapshotHash,c.updatedAt,c.payments.map(p=>[p.versionId,p.status])]))+`:${reload}`;
 useEffect(()=>{if(!cases.length)return;const abort=new AbortController();apSystemApi.operationalTimings(abort.signal).then(data=>{if(abort.signal.aborted)return;if(!timingsMatchCases(data,cases))throw Error("The timing snapshot and case list differ. Refresh the workspace to inspect one current revision set.");setResult({key,data});}).catch(e=>{if(!abort.signal.aborted)setResult({key,error:apError(e)});});return()=>abort.abort();},[key]);
 const current=result?.key===key?result:undefined,data=current?.data,caseId=cases.some(c=>c.caseId===selected)?selected:cases[0]?.caseId,active=data?.cases.find(c=>c.caseId===caseId);
 return <details className="aps-timings"><summary>Operational durations and waiting ages</summary><p className="aps-caption">Measured from persisted business events in this account and run. Completed durations and ongoing ages are separate; overlapping intervals are not total processing time or operator labor. No service target or worker-health signal is treated as a measurement.</p>{!cases.length?<p className="aps-empty">No cases to measure.</p>:!current?<p role="status">Loading recorded event timings…</p>:current.error?<p className="aps-error" role="alert">{current.error}</p>:data&&<><p className="aps-caption">Server snapshot: {new Date(data.asOf).toLocaleString()} / Run <code>{data.scope.runId}</code> / Account <code>{data.scope.accountId}</code>. Ongoing ages stop at this snapshot.</p><APTimingSummary data={data}/><div className="aps-action-row"><label>Inspect case timing<select value={caseId} onChange={e=>setSelected(e.target.value)}>{cases.map(c=><option key={c.caseId} value={c.caseId}>{c.candidate?.invoiceNumber??c.caseId} / Current revision {c.revision}</option>)}</select></label>{caseId&&onOpenCase&&<button onClick={()=>onOpenCase(caseId)}>Open this case</button>}</div>{active&&<><p className="aps-caption">Case <code>{active.caseId}</code> / Current revision {active.revision}. Payment intervals retain their historical source revision when recorded.</p><APTimingRecords samples={active.samples}/></>}</>} {!!cases.length&&<button onClick={()=>setReload(n=>n+1)}>Refresh timing snapshot</button>}</details>;
}
