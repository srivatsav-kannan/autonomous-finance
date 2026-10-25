import { APConnectedProcess } from "./APConnectedProcess";
import { APDocumentUpload } from "./APDocumentUpload";
import { APTraceability } from "./APTraceability";
import { APAgentTimeline } from "./APAgentHistory";
import { decisionAnchor } from "./apAgentHistoryView";
import {APPaymentDimensions} from "./APDimensions";
import {APSystemPhysicalLines} from "./APSystemPhysicalLines";
import {APSystemTimings} from "./APSystemTimings";
import { APSystemBusiness, APRelatedCases } from "./APSystemBusiness";
import { APSystemCorrections } from "./APSystemCorrections";
import { APSystemClose } from "./APSystemClose";
import { APSystemGovernance } from "./APSystemGovernance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { APCaseDetail, ReviewRequest, SourceDocument } from "../../src/ap-system/contracts";
import { APSystemRuns } from "./APSystemRuns";
import { APSystemQuickBooks } from "./APSystemQuickBooks";
import { APSystemEvidence } from "./APSystemEvidence";
import { apError, apSystemApi, downloadOriginal, type PaymentDetail } from "./apSystemApi";
import { apLabel, apMoney, caseNeedsAttention, paymentBelongsToCase, reviewPayload, paymentAmountInput, evidenceForCase, sourceReadingValue } from "./apSystemView";
import { useUrlState } from "./useUrlState";
import { Icon } from "./Icon";
import "./apSystem.css";

export type APSystemContext = { runId: string; organizationId: string; provider: string; identityMode: APCaseDetail["identityMode"] };
const WORKSPACES = ["cases", "runs", "governance", "close"] as const;
const VIEWS = ["evidence", "matching", "accounting", "traceability", "history"] as const;
const FILTERS = ["all", "attention", "approved", "settled"] as const;
const dateTime = (value: number) => new Date(value).toLocaleString();
export type APWorkspaceSection = typeof WORKSPACES[number];
const SECTION_HEADINGS: Record<APWorkspaceSection, { title: string; lede: string }> = {
  cases: { title: "Invoices", lede: "Each invoice is one case that holds the original documents, the checks, the decisions and what happened to the money." },
  runs: { title: "Payments", lede: "Payments wait for a person to release them, and each one is tied to an approved bill and a fixed destination." },
  governance: { title: "Policy & suppliers", lede: "This page sets who can approve what, the payment limits, and the verified bank details for each supplier." },
  close: { title: "Period close", lede: "This page shows what still blocks the month from closing and who has to clear each item." },
};
// The console's main navigation can drive the section. Without it the workspace keeps its own section tabs.
export function APSystemWorkspace({ onContextChange, onBusyChange, section, onSection }: { onContextChange?: (context: APSystemContext | undefined) => void; onBusyChange?: (busy: boolean) => void; section?: APWorkspaceSection; onSection?: (section: APWorkspaceSection) => void }) {
  const [listResult,setListResult]=useState<{generation:number;cases?:APCaseDetail[];error?:string}>();
  const [detailResult,setDetailResult]=useState<{generation:number;caseId:string;detail?:APCaseDetail;error?:string}>();
  const [selectedId,setSelectedId]=useUrlState("case");
  const [urlWorkspace,setUrlWorkspace]=useUrlState("apWorkspace","cases",WORKSPACES);
  const workspace=section ?? urlWorkspace;
  const setWorkspace=(next:APWorkspaceSection)=>{if(section){if(next!==section)onSection?.(next);}else setUrlWorkspace(next);};
  const headingText=SECTION_HEADINGS[section ?? "cases"];
  const [filter,setFilter]=useUrlState("apFilter","all",FILTERS);
  const [search,setSearch]=useUrlState("apSearch");
  const [view,setView]=useUrlState("apView","evidence",VIEWS);
  const [reload,setReload]=useState(0);
  const currentList=listResult?.generation===reload ? listResult : undefined;
  const cases=currentList?.cases, listError=currentList?.error;
  const sessionReady=cases!==undefined;
  const currentDetail=sessionReady && detailResult?.generation===reload && detailResult.caseId===selectedId ? detailResult : undefined;
  const detail=currentDetail?.detail, detailError=currentDetail?.error;
  const [busy,setBusy]=useState(false);
  const [showUpload,setShowUpload]=useState(false);
  const [liveUpdateError,setLiveUpdateError]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{const abort=new AbortController();
    // GET cases establishes the read/write session. Tag every result so an old
    // refresh can never unlock detail reads or uploads for a newer generation.
    apSystemApi.list(abort.signal).then(value=>{if(!abort.signal.aborted)setListResult({generation:reload,cases:value});}).catch(e=>{if(!abort.signal.aborted)setListResult({generation:reload,error:apError(e)});});
    return ()=>abort.abort();
  },[reload]);
  useEffect(()=>{if(!selectedId || !sessionReady)return;
    const abort=new AbortController();
    apSystemApi.detail(selectedId,abort.signal).then(value=>{if(!abort.signal.aborted){setDetailResult({generation:reload,caseId:selectedId,detail:value});heading.current?.focus();}}).catch(e=>{if(!abort.signal.aborted)setDetailResult({generation:reload,caseId:selectedId,error:apError(e)});});
    return ()=>abort.abort();
  },[selectedId,reload,sessionReady]);
  useEffect(()=>{
    if(!sessionReady || busy)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        if(!document.activeElement?.matches("input,textarea,select")){
          const nextCases=await apSystemApi.list(abort.signal);
          const nextDetail=selectedId?await apSystemApi.detail(selectedId,abort.signal):undefined;
          if(abort.signal.aborted)return;
          if(!document.activeElement?.matches("input,textarea,select")){
            setListResult({generation:reload,cases:nextCases});
            if(nextDetail)setDetailResult(previous=>JSON.stringify(previous?.detail)===JSON.stringify(nextDetail)?previous:{generation:reload,caseId:selectedId,detail:nextDetail});
          }
          setLiveUpdateError(false);
        }
      }catch{if(!abort.signal.aborted)setLiveUpdateError(true);}
      if(!abort.signal.aborted)timer=setTimeout(poll,3000);
    };
    timer=setTimeout(poll,3000);
    return()=>{abort.abort();clearTimeout(timer);};
  },[selectedId,reload,sessionReady,busy]);
  useEffect(()=>{onBusyChange?.(busy);return ()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{const active=detail ?? cases?.[0];onContextChange?.(active ? {runId:active.runId,organizationId:active.organizationId,provider:active.scope.provider === "fake" ? "Local FakeBank" : "Increase sandbox",identityMode:active.identityMode} : undefined);},[detail,cases,onContextChange]);
  const refresh=useCallback(()=>setReload(n=>n+1),[]);
  const filtered=useMemo(()=>cases?.filter(c=>{
    const matches=!search || [c.caseId,c.candidate?.invoiceNumber,c.candidate?.extractedSupplierName,sourceReadingValue(c,"invoiceNumber"),sourceReadingValue(c,"documentHeading"),...c.sources.map(s=>s.name)].join(" ").toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || filter === "attention" && caseNeedsAttention(c) || filter === "approved" && c.states.business === "approved" || filter === "settled" && c.states.execution === "settled");
  }),[cases,search,filter]);
  return <section className="aps-app" aria-label="Accounts payable workspace">
    <div className="page-heading"><div><h2>{section ? headingText.title : "Accounts payable"}</h2><p className="lede">{section ? headingText.lede : "Inspect the obligation, its approvals and the outcome."}</p></div><div className="aps-heading-actions"><button type="button" onClick={refresh} disabled={busy}>Refresh</button><button type="button" className="primary" onClick={()=>setShowUpload(v=>!v)} disabled={busy||!sessionReady} aria-expanded={showUpload}>Process documents</button></div></div>
    {liveUpdateError&&<p className="aps-notice" role="status">Live updates are reconnecting. The last recorded result is shown; use Refresh to check the connection.</p>}
    {showUpload && <APDocumentUpload sessionReady={sessionReady} onBusy={setBusy} onImported={refresh} onComplete={id=>{setWorkspace("cases");setView("evidence");setSelectedId(id);setShowUpload(false);refresh();}} />}
    {listError && <div className="aps-error" role="alert"><strong>Case list unavailable</strong><p>{listError}</p><button type="button" onClick={refresh} disabled={busy}>Retry connection</button></div>}
    {!section && <div className="aps-tabs" role="group" aria-label="Workspace sections">{WORKSPACES.map(section=><button key={section} disabled={busy} aria-pressed={workspace===section} className={workspace===section?"is-selected":""} onClick={()=>setWorkspace(section)}>{section==="runs"?"Payment runs":section==="governance"?"Policy & suppliers":section==="close"?"Period close":"Cases"}</button>)}</div>}
    {cases && <APOperationalMetrics cases={cases} onOpenCase={id=>{if(!busy){setSelectedId(id);setWorkspace("cases");}}}/>}
    {workspace==="close" ? (listResult?.cases?<APSystemClose cases={listResult.cases} busy={busy||!sessionReady} onBusy={setBusy} onChanged={refresh} onOpenCase={id=>{if(!busy){setSelectedId(id);setWorkspace("cases");}}}/>:!listError&&<APLoading label="Opening period close workspace…"/>) : workspace==="governance" ? (listResult?.cases?<APSystemGovernance cases={listResult.cases} busy={busy||!sessionReady} onBusy={setBusy} onChanged={refresh}/>:!listError&&<APLoading label="Opening policy and supplier workspace…"/>) : workspace==="runs" ? (listResult?.cases?<APSystemRuns cases={listResult.cases} busy={busy||!sessionReady} onBusy={setBusy} onChanged={refresh} onOpenCase={id=>{if(!busy){setSelectedId(id);setWorkspace("cases");}}}/>:!listError&&<APLoading label="Opening payment run workspace…"/>) : <div className="aps-workspace-grid">
      <aside className="aps-case-queue" aria-label="AP cases"><div className="aps-queue-controls">
        <label className="search-field"><Icon name="search"/><input type="search" placeholder="Supplier, invoice or source" aria-label="Search AP cases" value={search} onChange={e=>setSearch(e.target.value)} /></label>
        <label className="aps-filter-label">Show<select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)} aria-label="Filter AP cases">{FILTERS.map(v=><option key={v} value={v}>{v === "attention" ? "Needs attention" : apLabel(v)}</option>)}</select></label>
      </div>
      {listError ? <p className="aps-empty">Cases will be available after the connection is restored.</p> : !cases ? <APLoading label="Loading cases…"/> : !filtered?.length ? <div className="aps-empty"><h3>{cases?.length ? "No matching cases" : "No AP cases yet"}</h3><p>{cases?.length ? "Change the search or filter to find a case." : "Upload the invoice and its supporting documents to start a case."}</p></div> : <ul className="aps-cases">{filtered.map(c=><li key={c.caseId}><button type="button" disabled={busy} className={c.caseId===selectedId ? "is-selected" : ""} aria-pressed={c.caseId===selectedId} onClick={()=>setSelectedId(c.caseId)}>
        <span className="aps-case-supplier">{c.candidate?.extractedSupplierName ?? (sourceReadingValue(c,"documentHeading") ? `${sourceReadingValue(c,"documentHeading")} (source)` : "Extraction needs review")}</span><span className="aps-case-line"><span>{c.candidate?.invoiceNumber ?? sourceReadingValue(c,"invoiceNumber") ?? c.sources[0]?.name ?? c.caseId}</span><strong>{apMoney(c.amounts.invoicedCents)}</strong></span><span className="aps-case-line"><small>{c.links.duplicateOfCaseId ? "Duplicate delivery" : apLabel(c.states.business)}</small><small>{caseNeedsAttention(c) ? "Needs attention" : apLabel(c.states.execution)}</small></span>
      </button></li>)}</ul>}
      {cases && <p className="aps-queue-footer">{filtered?.length ?? 0} of {cases.length} cases shown</p>}
      </aside>
      <div className="aps-case-content">
        {selectedId && listError ? <p className="aps-empty">Case evidence is unavailable until the workspace connection is restored. Retry the connection above.</p> : selectedId && !detail && !detailError ? <APLoading label="Loading linked case evidence…"/> : detailError ? <div className="aps-error" role="alert"><h3>Case unavailable</h3><p>{detailError}</p><button onClick={refresh} disabled={busy}>Retry case</button></div> : !detail ? <div className="aps-empty aps-case-placeholder"><Icon name="file"/><h3>Select an AP case</h3><p>Originals, review decisions, the bill and payment evidence stay together here.</p></div> : <>
          <header className="aps-case-header"><div><h3 id="ap-case-heading" ref={heading} tabIndex={-1}>{detail.candidate?.invoiceNumber ?? sourceReadingValue(detail, "invoiceNumber") ?? "Document review"}</h3><p>{detail.candidate?.extractedSupplierName ?? (sourceReadingValue(detail, "documentHeading") ? `Source heading: ${sourceReadingValue(detail, "documentHeading")} · Supplier not verified` : "Supplier not established")}</p>{!detail.candidate && sourceReadingValue(detail, "totalDue") && <p>Printed total due: <strong>{sourceReadingValue(detail, "totalDue")}</strong></p>}</div><div className="aps-case-identity"><span>{detail.scope.provider === "fake" ? "Local FakeBank" : "Increase sandbox"}</span><span>{detail.identityMode === "simulated_human" ? "Simulated human identity" : "Authenticated human identity"}</span></div></header>
          <p className="aps-caption">Case <code>{detail.caseId}</code> / Revision {detail.revision} / {detail.sources.every(s=>s.provenance.kind === "synthetic") ? "Synthetic documents" : "Document provenance varies; inspect originals"}</p>
          <APRelatedCases detail={detail} cases={cases??[]} onOpenCase={setSelectedId} busy={busy}/>
          <details className="aps-processing-details" open={view!=="traceability"} key={`processing:${detail.caseId}:${view==="traceability"}`}>
            <summary>Processing & amounts</summary>
            {detail.identityMode==="authenticated_human"?<APConnectedProcess detail={detail} onView={setView}/>:<APCaseStatus detail={detail}/>}
            <APAmounts detail={detail}/>
          </details>
          {detail.links.duplicateOfCaseId && <p className="aps-notice">This delivery is linked to an existing obligation. <button className="aps-text-button" onClick={()=>setSelectedId(detail.links.duplicateOfCaseId!)} disabled={busy}>Open original case</button></p>}
          <div className="aps-tabs" role="group" aria-label="Case sections">{VIEWS.map(v=><button type="button" key={v} disabled={busy} onClick={()=>setView(v)} aria-pressed={view===v} className={view===v ? "is-selected" : ""}>{v === "evidence" ? "Source & fields" : apLabel(v)}</button>)}</div>
          {view === "evidence" && <><APSystemEvidence key={detail.caseId} detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/><APOriginals detail={detail}/></>}
          {view === "matching" && <><APMatching detail={detail}/><APSystemPhysicalLines key={`physical:${detail.caseId}:${detail.revision}:${detail.updatedAt}`} detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/><APSystemBusiness key={`business:${detail.caseId}:${detail.revision}:${detail.updatedAt}`} detail={detail} cases={cases??[]} busy={busy} onBusy={setBusy} onChanged={refresh} onOpenCase={setSelectedId}/></>}
          {view === "accounting" && <APAccounting key={`accounting:${detail.caseId}:${detail.revision}`} detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/>}
          {view === "traceability" && <APTraceability key={detail.caseId} detail={detail}><APHistory detail={detail} onOpenAccounting={()=>setView("accounting")}/></APTraceability>}
          {view === "history" && <APHistory key={detail.caseId} detail={detail} onOpenAccounting={()=>setView("accounting")}/>}
          {(view==="evidence"||view==="matching")&&<APActions key={`review:${detail.caseId}:${detail.revision}`} detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/>}
        </>}
      </div>
    </div>}
  </section>;
}
export function APOperationalMetrics({cases,onOpenCase}:{cases:APCaseDetail[];onOpenCase?:(id:string)=>void}){
 const obligations=cases.filter(c=>!c.links.duplicateOfCaseId&&c.candidate?.kind==="invoice");
 const approved=obligations.filter(c=>c.states.business==="approved"),known=approved.filter(c=>c.amounts.outstandingCents!==null),missing=approved.length-known.length;
 const outstanding=known.reduce((sum,c)=>sum+c.amounts.outstandingCents!,0);
 const fields=cases.flatMap(evidenceForCase),sources=cases.flatMap(c=>c.sources.filter(s=>c.currentSourceBindings.some(b=>b.sourceId===s.sourceId&&b.revision===s.revision&&b.sha256===s.sha256))).filter((s,i,all)=>all.findIndex(x=>x.sourceId===s.sourceId&&x.revision===s.revision&&x.sha256===s.sha256)===i),pageTotal=sources.reduce((n,s)=>n+s.pageCount,0),pages=sources.flatMap(s=>s.pageStatus.filter((p,i,all)=>p.page>=1&&p.page<=s.pageCount&&all.findIndex(x=>x.page===p.page)===i));
 const complete=cases.filter(c=>c.extraction.status==="complete").length,native=fields.filter(f=>f.grounding.status==="native").length,derived=fields.filter(f=>f.grounding.status==="derived").length,unresolved=fields.filter(f=>f.grounding.status==="unresolved").length;
 return <section className="aps-operational" aria-label="Workspace operational metrics"><dl className="aps-amounts"><div><dt>Cases needing attention</dt><dd>{cases.filter(caseNeedsAttention).length}<small>of {cases.length} cases in this run</small></dd></div><div><dt>Approved outstanding</dt><dd>{apMoney(outstanding)}<small>{missing?`${missing} approved case amount unavailable`:`Across ${approved.length} unique invoices`}</small></dd></div><div><dt>Execution needs review</dt><dd>{cases.filter(c=>["returned","rejected","unknown","exception"].includes(c.states.execution)).length}<small>Inspect bank evidence before retrying</small></dd></div></dl><p className="aps-caption">Recognizing a bill records the obligation. Applied supplier credits reduce what is owed; a verified cash settlement records money leaving the bank. QuickBooks synchronization is a separate, receipt-backed operation.</p><details><summary>Extraction, source coverage and recorded trace counts</summary><dl className="aps-record"><div><dt>Complete extraction</dt><dd>{complete} / {cases.length} cases</dd></div><div><dt>Source page completion</dt><dd>{pages.filter(p=>p.status==="complete").length} / {pageTotal} pages across {sources.length} current documents</dd></div><div><dt>Field locations</dt><dd>{native} native / {derived} derived / {unresolved} unresolved / {fields.length} extracted fields</dd></div><div><dt>Recorded timeline events</dt><dd>{cases.reduce((n,c)=>n+c.timeline.length,0)} events across {cases.length} cases</dd></div></dl><p className="aps-caption">Counts describe retained evidence, not extraction accuracy. Model-quality accuracy is not inferred from these counts.</p></details><APSystemTimings cases={cases} onOpenCase={onOpenCase}/></section>;
}
function APLoading({label}:{label:string}){return <div className="aps-loading" role="status"><p>{label}</p><span/><span/><span/></div>;}
export function APCaseStatus({detail}:{detail:APCaseDetail}){
  const labels={document:"Document review",business:"Bill decision",accounting:"Accounting",authorization:"Payment authorization",execution:"Bank execution",reconciliation:"Reconciliation"};
  return <dl className="aps-stage-strip">{Object.entries(detail.states).map(([key,value])=><div key={key}><dt>{labels[key as keyof typeof labels]}</dt><dd>{apLabel(value)}</dd></div>)}</dl>;
}
function APAmounts({detail}:{detail:APCaseDetail}){
  const a=detail.amounts;
  return <><dl className="aps-amounts">{[["Invoiced",a.invoicedCents],["Accepted",a.acceptedCents],["Outstanding",a.outstandingCents]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{apMoney(value as number|null)}</dd></div>)}</dl><details className="aps-amount-detail"><summary>Disputed, credited and payment amounts</summary><dl className="aps-record">{[["Disputed",a.disputedCents],["Credited",a.creditedCents],["Instructed",a.instructedCents],["Settled",a.settledCents]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{apMoney(value as number|null)}</dd></div>)}</dl></details></>;
}
function APOriginals({detail}:{detail:APCaseDetail}){
  const [error,setError]=useState<string>();const [busy,setBusy]=useState<string>();
  const download=async(source:SourceDocument)=>{setBusy(source.deliveryId);setError(undefined);try{await downloadOriginal(source);}catch(e){setError(apError(e));}finally{setBusy(undefined);}};
  return <section className="aps-section"><h3>Original documents</h3>{error && <p className="aps-error" role="alert">{error}</p>}<ul className="aps-source-list">{detail.sources.map(s=><li key={`${s.sourceId}:${s.revision}`}><div><strong>{s.name}</strong><span>{apLabel(s.kind)} / Revision {s.revision} / {s.pageCount} {s.pageCount===1 ? "page" : "pages"}</span><small>{s.provenance.description}</small><small>{s.pageStatus.filter(p=>p.status!=="complete").map(p=>`Page ${p.page}: ${p.reason ?? p.status}`).join("; ")}</small></div><button onClick={()=>void download(s)} disabled={!!busy}>{busy===s.deliveryId ? "Downloading…" : "Download original"}</button></li>)}</ul></section>;
}
export function APMatching({detail}:{detail:APCaseDetail}){
  const open=detail.exceptions.filter(e=>e.status==="open");
  const hasReadings = evidenceForCase(detail).some(field => field.fieldPath.startsWith("source."));
  return <div className="aps-section"><h3>Matching and holds</h3>{!detail.candidate && <div className="aps-notice"><p>{hasReadings ? "The PDF has readable source values. AP mapping still needs review before a bill can be created." : `Extraction is ${detail.extraction.status}. No complete bill candidate is established.`}</p>{hasReadings && detail.extraction.reasons.includes("unsupported_or_missing_currency") && <p>This workspace supports USD payables. Printed amounts retain their original currency and are not converted to dollars.</p>}<details><summary>Mapping checks</summary><p>{detail.extraction.reasons.map(apLabel).join("; ")}</p></details></div>}
    {open.length ? <ul className="aps-exceptions">{open.map(e=><li key={e.exceptionId}><div className="aps-section-heading"><h4>{apLabel(e.code)}</h4><span className="aps-status">{e.blocking ? "Blocking hold" : "Review note"}</span></div><p>{e.reason}</p><dl className="aps-record"><div><dt>Owner</dt><dd>{apLabel(e.ownerRole)}</dd></div><div><dt>Permitted actions</dt><dd>{e.permittedActions.map(apLabel).join(", ")}</dd></div><div><dt>Required evidence</dt><dd>{e.requiredEvidence.map(apLabel).join(", ") || "See policy decision"}</dd></div></dl></li>)}</ul> : <p className="aps-caption">No open exceptions are recorded for this revision.</p>}
    <h4>Supporting evidence</h4>{detail.purchasingEvidence.length ? <div className="aps-table-wrap"><table><thead><tr><th>Evidence</th><th>Reference</th><th>Line</th><th>Quantity</th><th>Unit price</th></tr></thead><tbody>{detail.purchasingEvidence.flatMap(p=>p.lines.map(l=><tr key={`${p.reference}:${l.lineId}`}><td data-label="Evidence">{apLabel(p.kind)}</td><td data-label="Reference">{p.reference}</td><td data-label="Line">{l.sku}<small>{l.invoiceLineId}</small></td><td data-label="Quantity">{l.quantity.decimal} {l.quantity.unit}</td><td data-label="Unit price">{apMoney(l.unitPriceCents)}</td></tr>))}</tbody></table></div> : <p className="aps-caption">No purchase order, receipt, contract or service acceptance is linked.</p>}
    {detail.candidate && <><h4>Invoice lines and coding</h4><div className="aps-table-wrap"><table><thead><tr><th>Line</th><th>Quantity</th><th>Unit price</th><th>Amount</th><th>Allocation</th></tr></thead><tbody>{detail.candidate.lines.map(l=><tr key={l.lineId}><td data-label="Line">{l.description}<small>{l.sku ?? "SKU unresolved"}</small></td><td data-label="Quantity">{l.quantity.decimal} {l.quantity.unit}</td><td data-label="Unit price">{apMoney(l.unitPriceCents)}</td><td data-label="Amount">{apMoney(l.amountCents)}<small>Tax {apMoney(l.taxCents)}</small></td><td data-label="Allocation">{l.allocations.length ? l.allocations.map((a,i)=><span className="aps-allocation" key={i}>GL {a.account}: {apMoney(a.amountCents)}<small>{apLabel(a.treatment)} / {a.period}{a.store ? ` / ${a.store}` : ""}</small></span>) : "Coding unresolved"}</td></tr>)}</tbody></table></div></>}
    <p className="aps-caption">Policy {detail.policyVersion}. New supporting evidence creates a revision that requires fresh review.</p>
  </div>;
}
export function APAccounting({detail,busy=false,onBusy=()=>{},onChanged=()=>{}}:{detail:APCaseDetail;busy?:boolean;onBusy?:(busy:boolean)=>void;onChanged?:()=>void}){
  const [selected,setSelected]=useState<string>();const [payment,setPayment]=useState<PaymentDetail>();const [error,setError]=useState<string>();
  const [confirmed,setConfirmed]=useState(false);const[cancelConfirmed,setCancelConfirmed]=useState(false); const requestKey=useRef<string | undefined>(undefined);
  const [executionDate,setExecutionDate]=useState(detail.candidate?.dueDate ?? "");
  const [amount,setAmount]=useState(""); const [proposalPending,setProposalPending]=useState(false);
  const prepare=async()=>{onBusy(true);setError(undefined);try{
    const amountCents=paymentAmountInput(amount,detail.amounts.outstandingCents);
    requestKey.current??=crypto.randomUUID();setProposalPending(true);
    const input={expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:requestKey.current,amountCents,...(executionDate?{executionDate}:{})};
    const result=await apSystemApi.preparePayment(detail.caseId,input);setSelected(result.versionId);requestKey.current=undefined;setProposalPending(false);setAmount("");onChanged();
  }catch(e){setError(apError(e));}finally{onBusy(false);}};
  const authorize=async()=>{if(!selected||!payment)return;onBusy(true);setError(undefined);try{await apSystemApi.authorizePayment(detail.caseId,selected,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,paymentSnapshotHash:payment.snapshotHash});setConfirmed(false);onChanged();}catch(e){setError(apError(e));}finally{onBusy(false);}};
  const cancel=async()=>{if(!selected||!cancelConfirmed)return;onBusy(true);setError(undefined);try{await apSystemApi.cancelPayment(detail.caseId,selected,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash});setSelected(undefined);setCancelConfirmed(false);onChanged();}catch(e){setError(apError(e));}finally{onBusy(false);}};
  useEffect(()=>{if(!selected)return;setCancelConfirmed(false);setConfirmed(false);const abort=new AbortController();setPayment(undefined);setError(undefined);apSystemApi.payment(selected,abort.signal).then(value=>{if(!paymentBelongsToCase(detail,value.snapshot))throw new Error("This payment is not linked to the selected case and account. Authorization is unavailable.");setPayment(value);}).catch(e=>{if(!abort.signal.aborted)setError(apError(e));});return ()=>abort.abort();},[selected,detail]);
  return <section className="aps-section"><h3>Bill, payment and books</h3><dl className="aps-record"><div><dt>Bill</dt><dd>{detail.links.billId ? <code>{detail.links.billId}</code> : "Not recognized"}</dd></div><div><dt>External accounting</dt><dd>Inspect the QuickBooks connection and operation receipts below</dd></div></dl>
    <h4>Payment proposals</h4>{error && !selected && <p className="aps-error" role="alert">{error}</p>}{detail.states.business === "approved" && detail.links.billId && (detail.amounts.outstandingCents ?? 0)>0 && !detail.payments.some(p=>!["cancelled","rejected","returned","settled"].includes(p.status)) && <div className="aps-payment-proposal"><div className="aps-action-row"><label>Bill amount to pay (USD)<input type="text" inputMode="decimal" value={amount} placeholder={((detail.amounts.outstandingCents??0)/100).toFixed(2)} onChange={e=>setAmount(e.target.value)} disabled={busy||proposalPending}/></label><label>Initiate on (UTC)<input type="date" value={executionDate} onChange={e=>setExecutionDate(e.target.value)} disabled={busy||proposalPending}/></label></div><p className="aps-caption">Due date: {detail.candidate?.dueDate ?? "Not established"}. Leave the date blank to initiate after authorization. This is an initiation date; bank settlement timing can differ. A partial payment leaves the approved balance outstanding.</p><button type="button" onClick={()=>void prepare()} disabled={busy}>{proposalPending?"Retry same proposal":"Prepare payment proposal"}</button>{proposalPending&&<p className="aps-caption">The last response is unresolved. Retry the same selection or refresh to inspect its recorded outcome.</p>}</div>}{detail.payments.length ? <ul className="aps-payment-list">{detail.payments.map(p=><li key={p.versionId}><div><strong>{apMoney(p.amountCents)}</strong><span>{apLabel(p.status)}</span><small>Beneficiary version {p.beneficiaryVersion}</small><small>{p.authorizedBy.length ? `Authorized by ${p.authorizedBy.join(", ")}` : "No payment authorization recorded"}</small></div><button type="button" onClick={()=>setSelected(p.versionId)} aria-expanded={selected===p.versionId}>Inspect payment</button></li>)}</ul> : <p className="aps-caption">No payment proposal is linked. Bill approval alone does not release funds.</p>}
    {selected && <div className="aps-payment-detail">{error ? <p className="aps-error" role="alert">{error}</p> : !payment ? <APLoading label="Loading payment evidence…"/> : <><h4>Authorized scope</h4><dl className="aps-record"><div><dt>Cash payment</dt><dd>{apMoney(payment.snapshot.amountCents)}</dd></div><div><dt>Bill amount discharged</dt><dd>{apMoney(payment.snapshot.bills.reduce((sum,b)=>sum+b.amountCents,0))}</dd></div><div><dt>Credits applied</dt><dd>{apMoney(payment.snapshot.credits.reduce((sum,c)=>sum+c.amountCents,0))}</dd></div><div><dt>Initiation date</dt><dd>{payment.snapshot.schedule?`${payment.snapshot.schedule.executionDate} (UTC)` : "After authorization"}</dd></div><div><dt>Funding account</dt><dd>{payment.snapshot.scope.accountId}</dd></div><div><dt>Beneficiary</dt><dd>{payment.snapshot.destination.externalAccountId} / {payment.snapshot.destination.version}</dd></div><div><dt>Approval actors</dt><dd>{payment.approvals.map(a=>`${a.seatId} (${a.kind})`).join(", ") || "Awaiting independent authorization"}</dd></div></dl><APPaymentDimensions binding={payment.snapshot.accountingBinding}/>{detail.payments.find(p=>p.versionId===selected)?.status === "awaiting_approval" && <div className="aps-payment-confirm"><label className="aps-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>I authorize {apMoney(payment.snapshot.amountCents)} from this funding account to this verified beneficiary version{payment.snapshot.schedule ? `, no earlier than ${payment.snapshot.schedule.executionDate} (UTC)` : " after authorization"}.</label><button type="button" className="primary" onClick={()=>void authorize()} disabled={busy||!confirmed}>Authorize this payment</button><p className="aps-caption">This is a separate release decision for the payment snapshot shown above.</p></div>}{["awaiting_approval","queued"].includes(detail.payments.find(p=>p.versionId===selected)?.status??"")&&<div className="aps-payment-confirm"><label className="aps-check"><input type="checkbox" checked={cancelConfirmed} onChange={e=>setCancelConfirmed(e.target.checked)} disabled={busy}/>Cancel this proposal only if it has never been sent.</label><button disabled={busy||!cancelConfirmed} onClick={()=>void cancel()}>Cancel unsent proposal</button><p className="aps-caption">The server checks dispatch history. If sending may have begun, reconcile the bank outcome. To reschedule an eligible proposal, cancel it and approve a fresh snapshot.</p></div>}<h4>Verified bank observations</h4>{payment.observations.length ? <ul className="aps-source-list">{payment.observations.map(o=><li key={o.id}><span>{apLabel(o.status)} / {apMoney(o.amountCents)}<code>{o.id}</code></span></li>)}</ul> : <p className="aps-caption">No bank outcome has been verified.</p>}<h4>Bank transactions</h4>{payment.transactions.length ? <ul className="aps-source-list">{payment.transactions.map(t=><li key={t.id}><span>{apLabel(t.purpose)} / {apLabel(t.status)} / {apMoney(t.amountCents)}<code>{t.id}</code></span></li>)}</ul> : <p className="aps-caption">No linked bank transaction.</p>}</>}</div>}
    <APSystemCorrections key={`corrections:${detail.caseId}`} detail={detail} busy={busy} onBusy={onBusy} onChanged={onChanged}/>
    <APSystemQuickBooks detail={detail} busy={busy} onBusy={onBusy} onChanged={onChanged}/>
    <h4>Journal entries</h4><p className="aps-caption">Recognition records the payable. Settlement reduces AP and cash; it does not recognize the purchase again.</p>{detail.journals.length ? detail.journals.map(j=><details className="aps-journal" key={j.entryId} open><summary>{apLabel(j.kind)} / {j.date}</summary><p className="aps-caption">Journal <code>{j.entryId}</code>{j.bankTransactionId && <> / Bank transaction <code>{j.bankTransactionId}</code></>}</p><table><thead><tr><th>GL account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{j.lines.map((l,i)=><tr key={i}><td data-label="GL account">{l.account}</td><td data-label="Debit">{apMoney(l.debit)}</td><td data-label="Credit">{apMoney(l.credit)}</td></tr>)}</tbody></table></details>) : <p className="aps-empty">No journal entry is linked to this case.</p>}
  </section>;
}
export function APHistory({detail,onOpenAccounting}:{detail:APCaseDetail;onOpenAccounting?:()=>void}){
  return <section className="aps-section"><h3>Recorded decisions</h3>{detail.decisions.length ? <ol className="aps-timeline">{detail.decisions.map(d=><li key={d.decisionId} id={decisionAnchor(d.decisionId)} tabIndex={-1}><div className="aps-section-heading"><strong>{apLabel(d.kind)}: {apLabel(d.outcome)}</strong><time dateTime={new Date(d.at).toISOString()}>{dateTime(d.at)}</time></div><p>{d.reason}</p><span>{d.actor} / {apLabel(d.actorKind)} / Candidate revision {d.candidateRevision}</span><small>Authority: {d.authority}. Policy: {d.policyVersion}.</small><details><summary>Reviewed source bindings</summary>{d.sourceBindings.map(s=><p key={`${s.sourceId}:${s.revision}`}><code>{s.sourceId}</code> / Revision {s.revision}<code>{s.sha256}</code></p>)}</details></li>)}</ol> : <p className="aps-caption">No review decision has been recorded.</p>}
    <APAgentTimeline detail={detail} onOpenAccounting={onOpenAccounting}/>
    <details><summary>Current case and snapshot identifiers</summary><dl className="aps-record"><div><dt>Run</dt><dd><code>{detail.runId}</code></dd></div><div><dt>Snapshot</dt><dd><code>{detail.snapshotHash}</code></dd></div><div><dt>Policy</dt><dd>{detail.policyVersion}</dd></div><div><dt>Created</dt><dd>{dateTime(detail.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{dateTime(detail.updatedAt)}</dd></div></dl></details>
  </section>;
}
export function APActions({detail,busy,onBusy,onChanged}:{detail:APCaseDetail;busy:boolean;onBusy:(busy:boolean)=>void;onChanged:()=>void}){
  const [reason,setReason]=useState("");const [checked,setChecked]=useState(false);const [outcome,setOutcome]=useState<ReviewRequest["outcome"]>("approved");const [error,setError]=useState<string>();const [success,setSuccess]=useState<string>();
  const pending=useRef<{fingerprint:string;key:string} | undefined>(undefined);
  const submit=async(kind:"review"|"approve")=>{
    setError(undefined);setSuccess(undefined);onBusy(true);
    const fingerprint=JSON.stringify({kind,revision:detail.revision,snapshot:detail.snapshotHash,reason:reason.trim(),outcome:kind==="approve" ? "approved" : outcome});
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,key:crypto.randomUUID()};
    const input=reviewPayload(detail,reason,kind==="approve" ? "approved" : outcome,pending.current.key);
    try{if(kind==="review")await apSystemApi.review(input);else await apSystemApi.approve({...input,acceptedCents:detail.candidate!.totalCents});setSuccess(kind==="review" ? "Field review recorded." : "Bill approval recorded. Payment still requires its own authorization.");pending.current=undefined;onChanged();}catch(e){setError(apError(e));}finally{onBusy(false);}
  };
  const fieldsAllowed=detail.candidate !== null && detail.extraction.status === "complete";
  const blocking=detail.exceptions.some(e=>e.blocking && e.status==="open");
  const billAllowed=!detail.domain?.policyVersion && detail.states.document === "reviewed" && fieldsAllowed && !blocking && detail.states.business !== "approved" && !detail.links.recognitionJournalId;
  const decisionRecorded=detail.states.business === "approved" && !!detail.links.billId;
  return <section className="aps-actions" aria-label="Case review actions"><h3>Review this revision</h3><p className="aps-caption">Your decision binds the current sources and amounts. Backend authority and stale-revision checks apply.</p>
    {error && <p className="aps-error" role="alert">{error}</p>}{success && <p className="aps-success" role="status">{success}</p>}
    {!decisionRecorded && <><label htmlFor="ap-review-reason">Decision reason<textarea id="ap-review-reason" value={reason} onChange={e=>setReason(e.target.value)} rows={3} disabled={busy} placeholder="What did you check, and why can this case proceed?"/></label><label className="aps-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={busy}/>I inspected the correct original source revision and supporting evidence.</label><div className="aps-action-row"><label>Field review outcome<select value={outcome} onChange={e=>setOutcome(e.target.value as ReviewRequest["outcome"])} disabled={busy}><option value="approved">Approve extracted fields</option><option value="needs_evidence">Request evidence</option><option value="rejected">Reject extracted fields</option></select></label><button type="button" onClick={()=>void submit("review")} disabled={busy || !reason.trim() || !checked || outcome==="approved" && !fieldsAllowed}>{busy ? "Recording…" : "Record field review"}</button>{!detail.domain?.policyVersion && <button type="button" className="primary" onClick={()=>void submit("approve")} disabled={busy || !reason.trim() || !checked || !billAllowed}>Approve bill{detail.candidate ? ` ${apMoney(detail.candidate.totalCents)}` : ""}</button>}</div>
    {detail.domain?.policyVersion && <p className="aps-caption">Business approval follows the configured group route under Matching. Field review cannot approve or recognize the bill.</p>}
    {!fieldsAllowed && <p className="aps-caption">Incomplete extraction cannot be approved. You can record a rejection or request evidence.</p>}{blocking && <p className="aps-caption">Resolve the owned holds with supporting evidence before bill approval.</p>}{detail.states.document!=="reviewed" && fieldsAllowed && <p className="aps-caption">Record field review first; bill approval is a separate decision.</p>}</>}
    {decisionRecorded && <p className="aps-success">Bill approved. {detail.states.authorization === "not_requested" ? "Payment has not been requested." : `Payment authorization: ${apLabel(detail.states.authorization)}.`}</p>}
    <p className="aps-caption">Payment release requires the exact amount, verified beneficiary, funding account and independent authorization. Review the proposal under Accounting.</p>
  </section>;
}
