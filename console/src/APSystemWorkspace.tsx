import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { APCaseDetail, ReviewRequest, SourceDocument } from "../../src/ap-system/contracts";
import { APSystemEvidence } from "./APSystemEvidence";
import { apError, apSystemApi, downloadOriginal, type PaymentDetail } from "./apSystemApi";
import { apLabel, apMoney, caseNeedsAttention, paymentBelongsToCase, reviewPayload } from "./apSystemView";
import { useUrlState } from "./useUrlState";
import { Icon } from "./Icon";
import "./apSystem.css";

export type APSystemContext = { runId: string; organizationId: string; provider: string; identityMode: APCaseDetail["identityMode"] };
const VIEWS = ["evidence", "matching", "accounting", "history"] as const;
const FILTERS = ["all", "attention", "approved", "settled"] as const;
const dateTime = (value: number) => new Date(value).toLocaleString();
export function APSystemWorkspace({ onContextChange, onBusyChange }: { onContextChange?: (context: APSystemContext | undefined) => void; onBusyChange?: (busy: boolean) => void }) {
  const [cases,setCases]=useState<APCaseDetail[]>();
  const [listError,setListError]=useState<string>();
  const [detail,setDetail]=useState<APCaseDetail>();
  const [detailError,setDetailError]=useState<string>();
  const [selectedId,setSelectedId]=useUrlState("case");
  const [filter,setFilter]=useUrlState("apFilter","all",FILTERS);
  const [search,setSearch]=useUrlState("apSearch");
  const [view,setView]=useUrlState("apView","evidence",VIEWS);
  const [reload,setReload]=useState(0);
  const [busy,setBusy]=useState(false);
  const [showUpload,setShowUpload]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{const abort=new AbortController();setListError(undefined);
    apSystemApi.list(abort.signal).then(setCases).catch(e=>{if(!abort.signal.aborted)setListError(apError(e));});
    return ()=>abort.abort();
  },[reload]);
  useEffect(()=>{if(!selectedId){setDetail(undefined);setDetailError(undefined);return;}
    const abort=new AbortController();setDetail(undefined);setDetailError(undefined);
    apSystemApi.detail(selectedId,abort.signal).then(value=>{setDetail(value);heading.current?.focus();}).catch(e=>{if(!abort.signal.aborted)setDetailError(apError(e));});
    return ()=>abort.abort();
  },[selectedId,reload]);
  useEffect(()=>{onBusyChange?.(busy);return ()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{const active=detail ?? cases?.[0];onContextChange?.(active ? {runId:active.runId,organizationId:active.organizationId,provider:active.scope.provider === "fake" ? "Local FakeBank" : "Increase sandbox",identityMode:active.identityMode} : undefined);},[detail,cases,onContextChange]);
  const refresh=useCallback(()=>setReload(n=>n+1),[]);
  const filtered=useMemo(()=>cases?.filter(c=>{
    const matches=!search || [c.caseId,c.candidate?.invoiceNumber,c.candidate?.extractedSupplierName,...c.sources.map(s=>s.name)].join(" ").toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || filter === "attention" && caseNeedsAttention(c) || filter === "approved" && c.states.business === "approved" || filter === "settled" && c.states.execution === "settled");
  }),[cases,search,filter]);
  return <section className="aps-app" aria-label="Accounts payable workspace">
    <div className="page-heading"><div><h2>Accounts payable</h2><p className="lede">Inspect the obligation, its approvals and the outcome.</p></div><div className="aps-heading-actions"><button type="button" onClick={refresh} disabled={busy}>Refresh</button><button type="button" className="primary" onClick={()=>setShowUpload(v=>!v)} disabled={busy} aria-expanded={showUpload}>Upload documents</button></div></div>
    {showUpload && <APUpload onBusy={setBusy} onComplete={id=>{setSelectedId(id);setShowUpload(false);refresh();}} />}
    {listError && <div className="aps-error" role="alert"><strong>Case list unavailable</strong><p>{listError}</p><button type="button" onClick={refresh} disabled={busy}>Retry connection</button></div>}
    <div className="aps-workspace-grid">
      <aside className="aps-case-queue" aria-label="AP cases"><div className="aps-queue-controls">
        <label className="search-field"><Icon name="search"/><input type="search" placeholder="Supplier, invoice or source" aria-label="Search AP cases" value={search} onChange={e=>setSearch(e.target.value)} /></label>
        <label className="aps-filter-label">Show<select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)} aria-label="Filter AP cases">{FILTERS.map(v=><option key={v} value={v}>{v === "attention" ? "Needs attention" : apLabel(v)}</option>)}</select></label>
      </div>
      {!cases && !listError ? <APLoading label="Loading cases…"/> : !filtered?.length ? <div className="aps-empty"><h3>{cases?.length ? "No matching cases" : "No AP cases yet"}</h3><p>{cases?.length ? "Change the search or filter to find a case." : "Upload the invoice and its supporting documents to start a case."}</p></div> : <ul className="aps-cases">{filtered.map(c=><li key={c.caseId}><button type="button" disabled={busy} className={c.caseId===selectedId ? "is-selected" : ""} aria-pressed={c.caseId===selectedId} onClick={()=>setSelectedId(c.caseId)}>
        <span className="aps-case-supplier">{c.candidate?.extractedSupplierName ?? "Extraction needs review"}</span><span className="aps-case-line"><span>{c.candidate?.invoiceNumber ?? c.sources[0]?.name ?? c.caseId}</span><strong>{apMoney(c.amounts.invoicedCents)}</strong></span><span className="aps-case-line"><small>{c.links.duplicateOfCaseId ? "Duplicate delivery" : apLabel(c.states.business)}</small><small>{caseNeedsAttention(c) ? "Needs attention" : apLabel(c.states.execution)}</small></span>
      </button></li>)}</ul>}
      {cases && <p className="aps-queue-footer">{filtered?.length ?? 0} of {cases.length} cases shown</p>}
      </aside>
      <div className="aps-case-content">
        {selectedId && !detail && !detailError ? <APLoading label="Loading linked case evidence…"/> : detailError ? <div className="aps-error" role="alert"><h3>Case unavailable</h3><p>{detailError}</p><button onClick={refresh} disabled={busy}>Retry case</button></div> : !detail ? <div className="aps-empty aps-case-placeholder"><Icon name="file"/><h3>Select an AP case</h3><p>Originals, review decisions, the bill and payment evidence stay together here.</p></div> : <>
          <header className="aps-case-header"><div><h3 ref={heading} tabIndex={-1}>{detail.candidate?.invoiceNumber ?? "Document review"}</h3><p>{detail.candidate?.extractedSupplierName ?? "Supplier not established"}</p></div><div className="aps-case-identity"><span>{detail.scope.provider === "fake" ? "Local FakeBank" : "Increase sandbox"}</span><span>{detail.identityMode === "simulated_human" ? "Simulated human identity" : "Authenticated human identity"}</span></div></header>
          <p className="aps-caption">Case <code>{detail.caseId}</code> / Revision {detail.revision} / {detail.sources.every(s=>s.provenance.kind === "synthetic") ? "Synthetic documents" : "Document provenance varies; inspect originals"}</p>
          <APCaseStatus detail={detail}/>
          <APAmounts detail={detail}/>
          {detail.links.duplicateOfCaseId && <p className="aps-notice">This delivery is linked to an existing obligation. <button className="aps-text-button" onClick={()=>setSelectedId(detail.links.duplicateOfCaseId!)} disabled={busy}>Open original case</button></p>}
          <div className="aps-tabs" role="group" aria-label="Case sections">{VIEWS.map(v=><button type="button" key={v} onClick={()=>setView(v)} aria-pressed={view===v} className={view===v ? "is-selected" : ""}>{v === "evidence" ? "Source & fields" : apLabel(v)}</button>)}</div>
          {view === "evidence" && <><APSystemEvidence detail={detail}/><APOriginals detail={detail}/></>}
          {view === "matching" && <APMatching detail={detail}/>}
          {view === "accounting" && <APAccounting detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/>}
          {view === "history" && <APHistory detail={detail}/>}
          <APActions key={`${detail.caseId}:${detail.revision}`} detail={detail} busy={busy} onBusy={setBusy} onChanged={refresh}/>
        </>}
      </div>
    </div>
  </section>;
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
  return <div className="aps-section"><h3>Matching and holds</h3>{!detail.candidate && <p className="aps-notice">Extraction is {detail.extraction.status}. {detail.extraction.reasons.join(" ")} No complete bill candidate is established.</p>}
    {open.length ? <ul className="aps-exceptions">{open.map(e=><li key={e.exceptionId}><div className="aps-section-heading"><h4>{apLabel(e.code)}</h4><span className="aps-status">{e.blocking ? "Blocking hold" : "Review note"}</span></div><p>{e.reason}</p><dl className="aps-record"><div><dt>Owner</dt><dd>{apLabel(e.ownerRole)}</dd></div><div><dt>Permitted actions</dt><dd>{e.permittedActions.map(apLabel).join(", ")}</dd></div><div><dt>Required evidence</dt><dd>{e.requiredEvidence.map(apLabel).join(", ") || "See policy decision"}</dd></div></dl></li>)}</ul> : <p className="aps-caption">No open exceptions are recorded for this revision.</p>}
    <h4>Supporting evidence</h4>{detail.purchasingEvidence.length ? <div className="aps-table-wrap"><table><thead><tr><th>Evidence</th><th>Reference</th><th>Line</th><th>Quantity</th><th>Unit price</th></tr></thead><tbody>{detail.purchasingEvidence.flatMap(p=>p.lines.map(l=><tr key={`${p.reference}:${l.lineId}`}><td data-label="Evidence">{apLabel(p.kind)}</td><td data-label="Reference">{p.reference}</td><td data-label="Line">{l.sku}<small>{l.invoiceLineId}</small></td><td data-label="Quantity">{l.quantity.decimal} {l.quantity.unit}</td><td data-label="Unit price">{apMoney(l.unitPriceCents)}</td></tr>))}</tbody></table></div> : <p className="aps-caption">No purchase order, receipt, contract or service acceptance is linked.</p>}
    {detail.candidate && <><h4>Invoice lines and coding</h4><div className="aps-table-wrap"><table><thead><tr><th>Line</th><th>Quantity</th><th>Unit price</th><th>Amount</th><th>Allocation</th></tr></thead><tbody>{detail.candidate.lines.map(l=><tr key={l.lineId}><td data-label="Line">{l.description}<small>{l.sku ?? "SKU unresolved"}</small></td><td data-label="Quantity">{l.quantity.decimal} {l.quantity.unit}</td><td data-label="Unit price">{apMoney(l.unitPriceCents)}</td><td data-label="Amount">{apMoney(l.amountCents)}<small>Tax {apMoney(l.taxCents)}</small></td><td data-label="Allocation">{l.allocations.length ? l.allocations.map((a,i)=><span className="aps-allocation" key={i}>GL {a.account}: {apMoney(a.amountCents)}<small>{apLabel(a.treatment)} / {a.period}{a.store ? ` / ${a.store}` : ""}</small></span>) : "Coding unresolved"}</td></tr>)}</tbody></table></div></>}
    <p className="aps-caption">Policy {detail.policyVersion}. New supporting evidence creates a revision that requires fresh review.</p>
  </div>;
}
export function APAccounting({detail,busy=false,onBusy=()=>{},onChanged=()=>{}}:{detail:APCaseDetail;busy?:boolean;onBusy?:(busy:boolean)=>void;onChanged?:()=>void}){
  const [selected,setSelected]=useState<string>();const [payment,setPayment]=useState<PaymentDetail>();const [error,setError]=useState<string>();
  const [confirmed,setConfirmed]=useState(false); const requestKey=useRef<string | undefined>(undefined);
  const prepare=async()=>{onBusy(true);setError(undefined);requestKey.current??=crypto.randomUUID();try{const result=await apSystemApi.preparePayment(detail.caseId,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,idempotencyKey:requestKey.current});setSelected(result.versionId);onChanged();}catch(e){setError(apError(e));}finally{onBusy(false);}};
  const authorize=async()=>{if(!selected||!payment)return;onBusy(true);setError(undefined);try{await apSystemApi.authorizePayment(detail.caseId,selected,{expectedRevision:detail.revision,snapshotHash:detail.snapshotHash,paymentSnapshotHash:payment.snapshotHash});setConfirmed(false);onChanged();}catch(e){setError(apError(e));}finally{onBusy(false);}};
  useEffect(()=>{if(!selected)return;setConfirmed(false);const abort=new AbortController();setPayment(undefined);setError(undefined);apSystemApi.payment(selected,abort.signal).then(value=>{if(!paymentBelongsToCase(detail,value.snapshot))throw new Error("This payment is not linked to the selected case and account. Authorization is unavailable.");setPayment(value);}).catch(e=>{if(!abort.signal.aborted)setError(apError(e));});return ()=>abort.abort();},[selected,detail.caseId,detail.revision,detail.snapshotHash]);
  return <section className="aps-section"><h3>Bill, payment and books</h3><dl className="aps-record"><div><dt>Bill</dt><dd>{detail.links.billId ? <code>{detail.links.billId}</code> : "Not recognized"}</dd></div><div><dt>External accounting</dt><dd>{detail.links.externalAccountingIds.length ? detail.links.externalAccountingIds.join(", ") : "Not connected / not run"}</dd></div></dl>
    <h4>Payment proposals</h4>{error && !selected && <p className="aps-error" role="alert">{error}</p>}{detail.states.business === "approved" && detail.links.billId && !detail.payments.some(p=>!["cancelled","rejected","returned"].includes(p.status)) && <button type="button" onClick={()=>void prepare()} disabled={busy}>Prepare payment proposal</button>}{detail.payments.length ? <ul className="aps-payment-list">{detail.payments.map(p=><li key={p.versionId}><div><strong>{apMoney(p.amountCents)}</strong><span>{apLabel(p.status)}</span><small>Beneficiary version {p.beneficiaryVersion}</small><small>{p.authorizedBy.length ? `Authorized by ${p.authorizedBy.join(", ")}` : "No payment authorization recorded"}</small></div><button type="button" onClick={()=>setSelected(p.versionId)} aria-expanded={selected===p.versionId}>Inspect payment</button></li>)}</ul> : <p className="aps-caption">No payment proposal is linked. Bill approval alone does not release funds.</p>}
    {selected && <div className="aps-payment-detail">{error ? <p className="aps-error" role="alert">{error}</p> : !payment ? <APLoading label="Loading payment evidence…"/> : <><h4>Authorized scope</h4><dl className="aps-record"><div><dt>Amount</dt><dd>{apMoney(payment.snapshot.amountCents)}</dd></div><div><dt>Funding account</dt><dd>{payment.snapshot.scope.accountId}</dd></div><div><dt>Beneficiary</dt><dd>{payment.snapshot.destination.externalAccountId} / {payment.snapshot.destination.version}</dd></div><div><dt>Approval actors</dt><dd>{payment.approvals.map(a=>`${a.seatId} (${a.kind})`).join(", ") || "Awaiting independent authorization"}</dd></div></dl>{detail.payments.find(p=>p.versionId===selected)?.status === "awaiting_approval" && <div className="aps-payment-confirm"><label className="aps-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>I authorize {apMoney(payment.snapshot.amountCents)} from this funding account to this verified beneficiary version.</label><button type="button" className="primary" onClick={()=>void authorize()} disabled={busy||!confirmed}>Authorize this payment</button><p className="aps-caption">This is a separate release decision for the payment snapshot shown above.</p></div>}<h4>Verified bank observations</h4>{payment.observations.length ? <ul className="aps-source-list">{payment.observations.map(o=><li key={o.id}><span>{apLabel(o.status)} / {apMoney(o.amountCents)}<code>{o.id}</code></span></li>)}</ul> : <p className="aps-caption">No bank outcome has been verified.</p>}<h4>Bank transactions</h4>{payment.transactions.length ? <ul className="aps-source-list">{payment.transactions.map(t=><li key={t.id}><span>{apLabel(t.purpose)} / {apLabel(t.status)} / {apMoney(t.amountCents)}<code>{t.id}</code></span></li>)}</ul> : <p className="aps-caption">No linked bank transaction.</p>}</>}</div>}
    <h4>Journal entries</h4><p className="aps-caption">Recognition records the payable. Settlement reduces AP and cash; it does not recognize the purchase again.</p>{detail.journals.length ? detail.journals.map(j=><details className="aps-journal" key={j.entryId} open><summary>{apLabel(j.kind)} / {j.date}</summary><p className="aps-caption">Journal <code>{j.entryId}</code>{j.bankTransactionId && <> / Bank transaction <code>{j.bankTransactionId}</code></>}</p><table><thead><tr><th>GL account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{j.lines.map((l,i)=><tr key={i}><td data-label="GL account">{l.account}</td><td data-label="Debit">{apMoney(l.debit)}</td><td data-label="Credit">{apMoney(l.credit)}</td></tr>)}</tbody></table></details>) : <p className="aps-empty">No journal entry is linked to this case.</p>}
  </section>;
}
export function APHistory({detail}:{detail:APCaseDetail}){
  return <section className="aps-section"><h3>Recorded decisions</h3>{detail.decisions.length ? <ol className="aps-timeline">{detail.decisions.map(d=><li key={d.decisionId}><div className="aps-section-heading"><strong>{apLabel(d.kind)}: {apLabel(d.outcome)}</strong><time dateTime={new Date(d.at).toISOString()}>{dateTime(d.at)}</time></div><p>{d.reason}</p><span>{d.actor} / {apLabel(d.actorKind)} / Candidate revision {d.candidateRevision}</span><small>Authority: {d.authority}. Policy: {d.policyVersion}.</small><details><summary>Reviewed source bindings</summary>{d.sourceBindings.map(s=><p key={`${s.sourceId}:${s.revision}`}><code>{s.sourceId}</code> / Revision {s.revision}<code>{s.sha256}</code></p>)}</details></li>)}</ol> : <p className="aps-caption">No review decision has been recorded.</p>}
    <h4>Audit timeline</h4>{detail.timeline.length ? <ol className="aps-timeline">{detail.timeline.map(e=><li key={e.eventId}><div className="aps-section-heading"><strong>{apLabel(e.kind)}</strong><time dateTime={new Date(e.at).toISOString()}>{dateTime(e.at)}</time></div><p>{e.summary}</p><small>{e.actor}</small>{e.references.length>0 && <details><summary>Linked records</summary>{e.references.map(r=><code key={r}>{r}</code>)}</details>}</li>)}</ol> : <p className="aps-caption">No historical events are available.</p>}
    <details><summary>Case and snapshot identifiers</summary><dl className="aps-record"><div><dt>Run</dt><dd><code>{detail.runId}</code></dd></div><div><dt>Snapshot</dt><dd><code>{detail.snapshotHash}</code></dd></div><div><dt>Policy</dt><dd>{detail.policyVersion}</dd></div><div><dt>Created</dt><dd>{dateTime(detail.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{dateTime(detail.updatedAt)}</dd></div></dl></details>
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
  const billAllowed=detail.states.document === "reviewed" && fieldsAllowed && !blocking && detail.states.business !== "approved" && !detail.links.recognitionJournalId;
  const decisionRecorded=detail.states.business === "approved" && !!detail.links.billId;
  return <section className="aps-actions" aria-label="Case review actions"><h3>Review this revision</h3><p className="aps-caption">Your decision binds the current sources and amounts. Backend authority and stale-revision checks apply.</p>
    {error && <p className="aps-error" role="alert">{error}</p>}{success && <p className="aps-success" role="status">{success}</p>}
    {!decisionRecorded && <><label htmlFor="ap-review-reason">Decision reason<textarea id="ap-review-reason" value={reason} onChange={e=>setReason(e.target.value)} rows={3} disabled={busy} placeholder="What did you check, and why can this case proceed?"/></label><label className="aps-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={busy}/>I inspected the correct original source revision and supporting evidence.</label><div className="aps-action-row"><label>Field review outcome<select value={outcome} onChange={e=>setOutcome(e.target.value as ReviewRequest["outcome"])} disabled={busy}><option value="approved">Approve extracted fields</option><option value="needs_evidence">Request evidence</option><option value="rejected">Reject extracted fields</option></select></label><button type="button" onClick={()=>void submit("review")} disabled={busy || !reason.trim() || !checked || outcome==="approved" && !fieldsAllowed}>{busy ? "Recording…" : "Record field review"}</button><button type="button" className="primary" onClick={()=>void submit("approve")} disabled={busy || !reason.trim() || !checked || !billAllowed}>Approve bill{detail.candidate ? ` ${apMoney(detail.candidate.totalCents)}` : ""}</button></div>
    {!fieldsAllowed && <p className="aps-caption">Incomplete extraction cannot be approved. You can record a rejection or request evidence.</p>}{blocking && <p className="aps-caption">Resolve the owned holds with supporting evidence before bill approval.</p>}{detail.states.document!=="reviewed" && fieldsAllowed && <p className="aps-caption">Record field review first; bill approval is a separate decision.</p>}</>}
    {decisionRecorded && <p className="aps-success">Bill approved. {detail.states.authorization === "not_requested" ? "Payment has not been requested." : `Payment authorization: ${apLabel(detail.states.authorization)}.`}</p>}
    <p className="aps-caption">Payment release requires the exact amount, verified beneficiary, funding account and independent authorization. Review the proposal under Accounting.</p>
  </section>;
}
function APUpload({onBusy,onComplete}:{onBusy:(busy:boolean)=>void;onComplete:(caseId:string)=>void}){
  const [files,setFiles]=useState<{file:File;kind:SourceDocument["kind"]}[]>([]);const [error,setError]=useState<string>();const [uploading,setUploading]=useState(false);const key=useRef<string | undefined>(undefined);
  const submit=async(e:FormEvent)=>{e.preventDefault();setError(undefined);if(!files.length)return;if(files.length>10||files.reduce((n,f)=>n+f.file.size,0)>8*1024*1024){setError("Choose up to 10 documents totaling no more than 8 MiB.");return;}onBusy(true);setUploading(true);key.current??=crypto.randomUUID();try{const result=await apSystemApi.intake(files,key.current);onComplete(result.caseId);}catch(e){setError(apError(e));}finally{setUploading(false);onBusy(false);}};
  return <form className="aps-upload" onSubmit={submit}><h3>Upload a source packet</h3><p>Preserve the supplier invoice with its purchase order, receipt or contract.</p><label htmlFor="ap-source-files">Original documents</label><input id="ap-source-files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.xml" disabled={uploading} onChange={e=>{key.current=undefined;setFiles(Array.from(e.target.files ?? []).map(file=>({file,kind:"invoice"})));setError(undefined);}}/>{files.length>0 && <ul>{files.map((entry,i)=><li key={`${entry.file.name}:${i}`}><span>{entry.file.name}</span><label>Document kind<select aria-label={`Kind of ${entry.file.name}`} value={entry.kind} disabled={uploading} onChange={e=>{key.current=undefined;setFiles(current=>current.map((f,n)=>n===i ? {...f,kind:e.target.value as SourceDocument["kind"]} : f));}}>{["invoice","purchase_order","receipt","contract","credit_note","correction","other"].map(kind=><option key={kind} value={kind}>{apLabel(kind)}</option>)}</select></label></li>)}</ul>}{error && <p className="aps-error" role="alert">{error}</p>}<button type="submit" className="primary" disabled={uploading||!files.length}>{uploading ? "Preserving and parsing sources…" : "Create AP case"}</button><small>PDF, scanned image or XML. Up to 10 files and 8 MiB per packet. Parsing does not approve a bill.</small></form>;
}
