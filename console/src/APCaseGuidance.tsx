import { useEffect, useState } from "react";
import type { APCaseDetail } from "../../src/ap-system/contracts";
import type { CaseGuidance } from "../../src/ap-system/case-guidance";
import { apSystemApi, apError, downloadOriginal, loadPage } from "./apSystemApi";
export function APCaseGuidance({detail}:{detail:APCaseDetail}) {
 const [preview,setPreview]=useState<string>();
 const [value,setValue]=useState<CaseGuidance|null>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false);
 useEffect(()=>{const abort=new AbortController();apSystemApi.guidance(detail.caseId,abort.signal).then(setValue).catch(e=>{if(!abort.signal.aborted)setError(apError(e));});return()=>abort.abort();},[detail]);
 useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
 const showOriginal=async()=>{const source=detail.sources.find(s=>detail.currentSourceBindings.some(b=>b.sourceId===s.sourceId&&b.sha256===s.sha256));if(!source)return;try{setPreview(URL.createObjectURL(await loadPage(source,1,new AbortController().signal)));}catch(e){setError(apError(e));}};
 const evaluate=async()=>{setBusy(true);setError(undefined);try{setValue(await apSystemApi.evaluateGuidance(detail));}catch(e){setError(apError(e));}finally{setBusy(false);}};
 return <section className="aps-section" aria-label="Case coding guidance"><div className="aps-section-heading"><h3>Case coding guidance</h3><button disabled={busy} onClick={()=>void evaluate()}>{busy?"Checking current evidence…":"Recheck guidance"}</button></div>
 {error&&<p role="alert" className="aps-error">{error}</p>}
 {value===undefined?<p>Loading saved guidance…</p>:!value?<p className="aps-notice">No current saved recommendation. Evidence or rule authority may have changed. Recheck guidance before using earlier advice.</p>:<>
 <h4>{value.status==="recommendation"?"Why A applies":"Why A was not used: pending review"}</h4>
 <p>{value.coding?`Suggested account ${value.coding.accountCode}; ${value.coding.allocations.map(a=>`${a.basisPoints/100}% ${a.code}`).join(", ")}.`:"No coding inherited from A."} {value.reason}</p>
 <dl className="aps-record"><div><dt>Owner</dt><dd>{value.owner}</dd></div><div><dt>Next action</dt><dd>{value.nextAction}</dd></div><div><dt>Saved binding</dt><dd>Case revision {value.caseRevision} / {new Date(value.evaluatedAt).toLocaleString()}<br/><code>{value.snapshotHash}</code></dd></div></dl>
 <button onClick={()=>void showOriginal()}>View current original PDF</button>
 {preview&&<div><button onClick={()=>setPreview(undefined)}>Close original</button><img src={preview} alt="Current original PDF, page 1" style={{maxWidth:"100%"}}/></div>}
 <h4>Current source matches</h4><dl className="aps-record">{Object.entries(value.matches).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
 {value.sourceBindings.map(b=>{const source=detail.sources.find(s=>s.sourceId===b.sourceId&&s.revision===b.revision&&s.sha256===b.sha256);return source?<p key={b.sourceId}><button onClick={()=>void downloadOriginal(source).catch(e=>setError(apError(e)))}>Download current original: {source.name}</button><small> Revision {b.revision} / <code>{b.sha256}</code></small></p>:null;})}
 <p className="aps-notice">A is authored synthetic text/history, not a PDF-backed human correction. This deterministic demonstration is recommendation only. Field review, bill approval and independent payment authorization remain required.</p>
 {value.rules.map(rule=><div key={rule.id}>
 <h4>Referenced rule and history</h4><dl className="aps-record">
 <div><dt>Rule</dt><dd>{rule.id} / version {rule.version} / {rule.status}<br/><code>{rule.hash}</code></dd></div>
 <div><dt>Independent review</dt><dd>{rule.review?`${rule.review.reviewer}: ${rule.review.outcome}. ${rule.review.reason}`:"Not approved"}</dd></div>
 <div><dt>Approval policy hash</dt><dd><code>{rule.review?.policyHash??"None"}</code></dd></div>
 {rule.histories.map(h=><div key={h.id}><dt>History A ({h.provenance})</dt><dd>{h.sourceCaseId} / revision {h.sourceCaseRevision}<br/>{h.correctionReason}</dd></div>)}
 </dl><details><summary>Inspect retained history, source text and approved scope</summary><pre className="aps-json-review">{JSON.stringify(rule,null,2)}</pre></details></div>)}
 </>}
 </section>;
}
