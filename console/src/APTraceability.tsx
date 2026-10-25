import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { APAgentTransition, APCaseDetail, SourceDocument } from "../../src/ap-system/contracts";
import type { BusinessProposal } from "../../src/ap-system/domain-operations";
import { OriginalPreview } from "./APSystemEvidence";
import { snapshotRows } from "./apAgentHistoryView";
import "./apTraceability.css";
import { apError, apSystemApi, type PaymentDetail } from "./apSystemApi";
import { apLabel, apMoney, paymentBelongsToCase } from "./apSystemView";
import { sourceChanges, sourceKey, sourceSnapshots, textDiff, valueDiff } from "./traceability-model";

export function APTraceability({ detail, children }: { detail: APCaseDetail; children: ReactNode }) {
  const events = useMemo(() => chronologicalEvents(detail.timeline), [detail.timeline]);
  const snapshots = useMemo(() => sourceSnapshots(detail), [detail]);
  const [beforeId, setBeforeId] = useState(snapshots[0]?.id ?? "current");
  const [afterId, setAfterId] = useState("current");
  const before = snapshots.find(s => s.id === beforeId) ?? snapshots[0]!;
  const after = snapshots.find(s => s.id === afterId) ?? snapshots.at(-1)!;
  const changes = sourceChanges(detail.sources, before.bindings, after.bindings);
  const [proposals, setProposals] = useState<BusinessProposal[]>();
  const [payments, setPayments] = useState<{ id: string; data?: PaymentDetail; error?: string }[]>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void apSystemApi.businessProposals(abort.signal).then(all => {
      if (!abort.signal.aborted) setProposals(all.filter(p => p.caseId === detail.caseId).sort((a,b) => a.createdAt - b.createdAt));
    }).catch(e => { if (!abort.signal.aborted) setError(apError(e)); });
    void Promise.all(detail.payments.map(async p => {
      try { const data = await apSystemApi.payment(p.versionId, abort.signal); if (!paymentBelongsToCase(detail, data.snapshot)) throw Error("Payment does not belong to this case and account."); return { id: p.versionId, data }; }
      catch (e) { return { id: p.versionId, error: apError(e) }; }
    })).then(rows => { if (!abort.signal.aborted) setPayments(rows); });
    return () => abort.abort();
  }, [detail]);
  const exportTrace = () => {
    const sources = detail.sources.map(({ originalBase64: _bytes, originalRef: _path, ...source }) => source);
    const blob = new Blob([JSON.stringify({ format: "ap-case-trace-v1", exportedAt: new Date().toISOString(), case: { ...detail, sources }, businessProposals: proposals ?? null, businessProposalsError: error ?? null, paymentSnapshots: payments ?? null, coverage: "Current case projection, retained source versions, recorded decisions and available proposal/payment snapshots. Historical extracted candidates and model prompts are not supplied by this API." }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `case-trace-${detail.caseId.replace(/[^a-zA-Z0-9_-]/g,"_")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyLink = async () => { try { const url = new URL(location.href); url.searchParams.set("case",detail.caseId); url.searchParams.set("apView","traceability"); await navigator.clipboard.writeText(url.href); setCopied("Trace link copied."); } catch { setCopied("Copy the address from your browser to share this trace."); } };
  return <section className="aps-trace" aria-label="Case traceability">
    <div className="aps-section-heading"><div><h3>Activity log</h3><p className="aps-caption">{events.length} recorded events, oldest first. Open an event to inspect its evidence.</p></div><div className="aps-heading-actions"><button onClick={() => void copyLink()}>Copy trace link</button><button onClick={exportTrace} disabled={!payments || (!proposals && !error)}>Export trace JSON</button></div></div>
    {copied && <p role="status" className="aps-caption">{copied}</p>}
    {events.length ? <ol className="apt-log" aria-label="Recorded case activity">{events.map(event => <li key={event.eventId}><TraceEvent event={event} sources={detail.sources}/></li>)}</ol> : <p className="apt-empty">No activity has been recorded for this case.</p>}
    <div className="apt-inspectors" aria-label="Supporting records">
    <details id="trace-sources" className="apt-inspector"><summary><span>Source changes</span><span>{detail.sources.length} versions</span></summary><div className="apt-inspector-body"><p className="aps-caption">Snapshots are taken from recorded review decisions and the current case. Case revisions and document revisions are separate.</p>
      <div className="aps-compare-controls"><label>Before<select aria-label="Before source snapshot" value={before.id} onChange={e=>setBeforeId(e.target.value)}>{snapshots.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label>After<select aria-label="After source snapshot" value={after.id} onChange={e=>setAfterId(e.target.value)}>{snapshots.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label></div>
      <p className="aps-caption">{changes.filter(c=>c.status==="added").length} added / {changes.filter(c=>c.status==="removed").length} removed / {changes.filter(c=>c.status==="changed").length} changed originals / {changes.filter(c=>c.status==="reversioned").length} new revisions with identical bytes.</p>
      {changes.map(change => <details className="aps-trace-change" key={change.key}><summary><span className={`aps-status ${change.status === "removed" ? "unresolved" : ""}`}>{change.status === "reversioned" ? "Same file, new revision" : apLabel(change.status)}</span> {change.after?.name ?? change.before?.name ?? "Source version unavailable"}</summary>{(!change.before && change.beforeBinding || !change.after && change.afterBinding) ? <p className="aps-error">A referenced original is unavailable. No content comparison is claimed.</p> : <SourceComparison before={change.before} after={change.after}/>}</details>)}
    </div></details>
    <details id="trace-proposals" className="apt-inspector"><summary><span>Business proposal diffs</span><span>{proposals?.length ?? (error ? "Unavailable" : "Loading…")}</span></summary><div className="apt-inspector-body"><p className="aps-caption">Changes compare consecutive retained requests for this case, including quantities, coding and source references.</p>
      {error ? <p className="aps-error" role="alert">{error}</p> : !proposals ? <p role="status">Loading retained proposals…</p> : !proposals.length ? <p className="aps-caption">No retained business proposal is available.</p> : proposals.map((proposal,index) => <details className="aps-trace-change" key={proposal._id}><summary>{index ? `Proposal ${index} → ${index+1}` : "First retained proposal"} / {apLabel(proposal.status)} / {apMoney(proposal.amountCents)}</summary><p className="aps-caption">{proposal.proposedBy} · {new Date(proposal.createdAt).toLocaleString()}</p><code>{proposal.hash}</code>{index ? <ValueChanges before={proposals[index-1]!.request} after={proposal.request}/> : <details><summary>Exact request</summary><pre className="aps-trace-json">{JSON.stringify(proposal.request,null,2)}</pre></details>}<ul className="aps-trace-votes">{proposal.votes.map((vote,i)=><li key={i}>{vote.principal} / {vote.groupId} / Stage {vote.stage+1}<small>{new Date(vote.at).toLocaleString()}</small></li>)}</ul></details>)}
    </div></details>
    <details id="trace-payments" className="apt-inspector"><summary><span>Payment snapshots & bank evidence</span><span>{detail.payments.length} payments</span></summary><div className="apt-inspector-body">{!payments ? <p role="status">Loading payment snapshots…</p> : !payments.length ? <p className="aps-caption">No payment snapshot is linked to this case.</p> : payments.map((payment,index) => <details key={payment.id} className="aps-trace-change"><summary>{apMoney(detail.payments.find(p=>p.versionId===payment.id)!.amountCents)} / {apLabel(detail.payments.find(p=>p.versionId===payment.id)!.status)}</summary><code>{payment.id}</code>{payment.error ? <p className="aps-error" role="alert">{payment.error}</p> : payment.data && <><dl className="aps-record"><div><dt>Snapshot hash</dt><dd><code>{payment.data.snapshotHash}</code></dd></div><div><dt>Command</dt><dd><code>{detail.payments.find(p=>p.versionId===payment.id)?.commandId ?? "Not recorded"}</code></dd></div><div><dt>Provider transfer</dt><dd><code>{detail.payments.find(p=>p.versionId===payment.id)?.providerTransferId ?? "Not recorded"}</code></dd></div><div><dt>Authorization</dt><dd>{payment.data.approvals.map(a=>`${a.seatId} (${a.kind})`).join(", ") || "None recorded"}</dd></div></dl>{index>0 && payments[index-1]?.data && <ValueChanges before={payments[index-1]!.data!.snapshot} after={payment.data.snapshot}/>}<details><summary>Exact payment, observations & transactions</summary><pre className="aps-trace-json">{JSON.stringify(payment.data,null,2)}</pre></details></>}</details>)}</div></details>
    <details id="trace-books" className="apt-inspector"><summary><span>Journal trail</span><span>{detail.journals.length} entries</span></summary><div className="apt-inspector-body">{detail.journals.map(journal=><details className="aps-trace-change" key={journal.entryId}><summary>{apLabel(journal.kind)} / {journal.date}</summary><code>{journal.entryId}</code>{journal.bankTransactionId && <p className="aps-caption">Bank transaction <code>{journal.bankTransactionId}</code></p>}<table><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{journal.lines.map((line,i)=><tr key={i}><td data-label="Account">{line.account}</td><td data-label="Debit">{apMoney(line.debit)}</td><td data-label="Credit">{apMoney(line.credit)}</td></tr>)}</tbody></table></details>)}{!detail.journals.length && <p className="aps-caption">No journal is linked. No posting is inferred.</p>}</div></details>
    <details id="trace-decisions" className="apt-inspector"><summary><span>Full review history</span><span>{detail.decisions.length} decisions</span></summary><div className="apt-inspector-body">{children}</div></details>
    <details className="apt-inspector"><summary>Trace coverage & current case record</summary><div className="apt-inspector-body"><p className="aps-caption">This view covers records retained by the case API. Full historical extracted candidates, deleted records, model prompts and reasoning are not exposed here. A missing snapshot cannot be reconstructed as an exact diff.</p><pre className="aps-trace-json">{JSON.stringify({caseId:detail.caseId,revision:detail.revision,snapshotHash:detail.snapshotHash,links:detail.links,scope:detail.scope},null,2)}</pre></div></details>
    </div>
  </section>;
}
export function chronologicalEvents(events: APCaseDetail["timeline"]) {
  return [...events].sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}
function TraceEvent({ event, sources }: { event: APCaseDetail["timeline"][number]; sources: SourceDocument[] }) {
  const date = new Date(event.at);
  const validTime = Number.isFinite(date.getTime());
  const linkedSources = sources.filter(source => event.references.includes(source.sourceId) || event.references.includes(sourceKey(source)) || event.references.includes(source.sha256) || event.agentTransition && [...event.agentTransition.before.case.sourceBindings, ...event.agentTransition.after.case.sourceBindings].some(binding => sourceKey(binding) === sourceKey(source)));
  return <details className="apt-event">
    <summary>
      <time dateTime={validTime ? date.toISOString() : undefined}>{validTime ? <><span>{date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><span>{date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></> : "Time unavailable"}</time>
      <span className="apt-event-content"><span className="apt-event-kind">{apLabel(event.kind)}</span><span className="apt-event-summary">{event.summary}</span></span>
      <span className="apt-event-actor">{event.actor}</span><span className="apt-event-toggle" aria-hidden="true">+</span>
    </summary>
    <div className="apt-event-body">
      {event.agentTransition && <TransitionDiff transition={event.agentTransition}/>}
      {event.references.length > 0 && <div className="apt-references"><h4>Linked record IDs</h4><ul>{event.references.map((reference, index) => <li key={`${reference}:${index}`}><code>{reference}</code></li>)}</ul></div>}
      {linkedSources.map(source => <LinkedOriginal key={sourceKey(source)} source={source}/>)}
      <details><summary>Raw event</summary><pre className="aps-trace-json">{JSON.stringify(event, null, 2)}</pre></details>
    </div>
  </details>;
}

function TransitionDiff({ transition }: { transition: APAgentTransition }) {
  const changed = snapshotRows(transition).filter(row => row.changed);
  return <details className="apt-transition"><summary>Recorded changes / {changed.length} fields</summary>
    <p className="aps-caption">Before and after this worker operation. Approval, evidence updates or settlement already present in the before snapshot are not attributed to this actor.</p>
    <p className="aps-caption">{apLabel(transition.action)} / {apLabel(transition.outcome)} / Operation <code>{transition.operationId}</code></p>
    {changed.length ? <div className="aps-table-wrap"><table className="aps-diff-table"><caption>Changes during this operation</caption><thead><tr><th>Recorded field</th><th>Before operation</th><th>After operation</th></tr></thead><tbody>{changed.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td data-label="Before operation">{row.before}</td><td data-label="After operation">{row.after}</td></tr>)}</tbody></table></div> : <p className="aps-caption">No business or work fields changed. Lease details remain in the raw event.</p>}
    <p className="aps-caption">Amounts retain the recorded cents. Model selection and verified human identity are not recorded in this event. The raw event contains the complete before and after snapshots.</p>
  </details>;
}
function LinkedOriginal({ source }: { source: SourceDocument }) {
  const [open, setOpen] = useState(false);
  return <details className="apt-linked-source" onToggle={event => setOpen(event.currentTarget.open)}><summary>Original: {source.name} / Revision {source.revision}</summary>{open && <><p className="aps-caption">{source.parser?.provider ?? "Parser not recorded"}</p><OriginalPreview source={source}/></>}</details>;
}
function ValueChanges({ before, after }: { before: unknown; after: unknown }) {
  const changes = valueDiff(before, after);
  return changes.length ? <div className="aps-table-wrap"><table className="aps-diff-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{changes.map(row=><tr key={row.path}><td data-label="Field"><code>{row.path}</code></td><td data-label="Before"><del>{row.before}</del></td><td data-label="After"><ins>{row.after}</ins></td></tr>)}</tbody></table></div> : <p className="aps-caption">No request field changed.</p>;
}
function SourceComparison({ before, after }: { before?: SourceDocument; after?: SourceDocument }) {
  const [preview,setPreview] = useState<"before"|"after">();
  const active=preview==="before"?before:preview==="after"?after:undefined;
  const same=before && after && before.sha256===after.sha256;
  const rows=before?.extractedText===after?.extractedText?[]:textDiff(before?.extractedText??"",after?.extractedText??"");
  return <><div className="aps-source-pair">{([['Before',before],['After',after]] as const).map(([label,source])=><div key={label}><strong>{label}</strong>{source ? <><p>{source.name} / Revision {source.revision}</p><code>{source.sha256}</code><p className="aps-caption">{source.byteLength.toLocaleString()} bytes / {source.pageCount} {source.pageCount === 1 ? "page" : "pages"} / {source.parser?.provider ?? "Parser not recorded"}</p><button onClick={()=>setPreview(label==='Before'?'before':'after')}>Open {label.toLowerCase()} original</button></> : <p className="aps-caption">Not present in this snapshot</p>}</div>)}</div>{same && <p className="aps-caption">Original PDF bytes are unchanged (matching SHA-256).</p>}<details><summary>Extracted text diff</summary><p className="aps-caption">Text comes from the recorded parser output; visual and binary changes are checked using the original files and their hashes.</p>{rows.length ? <pre className="aps-text-diff">{rows.map((row,i)=><span key={i} className={`diff-${row.kind}`}>{row.kind==='added'?'+ ':row.kind==='removed'?'− ':'  '}{row.text}{'\n'}</span>)}</pre> : <p className="aps-caption">No extracted text changed.</p>}</details>{active && <div className="aps-trace-preview"><button onClick={()=>setPreview(undefined)}>Close original preview</button><OriginalPreview key={sourceKey(active)} source={active}/></div>}</>;
}
