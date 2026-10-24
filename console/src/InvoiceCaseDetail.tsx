import { useState } from "react";
import type { CaseDetail, DecisionInput, EvidenceRef, SourceVersion } from "../../src/invoice-mvp/contracts";
import { downloadSource, errorMessage } from "./invoiceApi";
import { dateTime, modeLabel, money, statusLabel } from "./invoiceFormat";

export function EvidenceList({ evidence, sources }: { evidence: EvidenceRef[]; sources?: SourceVersion[] }) {
  return <ul className="iv-evidence">{evidence.map((ref, index) => <li key={`${ref.documentId}-${ref.version}-${index}`}>
    <span>{sources?.find(source => source.documentId === ref.documentId && source.version === ref.version)?.name ?? ref.documentId} · version {ref.version}</span>
    <code title={ref.contentHash}>SHA-256 {ref.contentHash}</code>
    {ref.quote && <blockquote>{ref.quote}</blockquote>}
  </li>)}</ul>;
}

export function InvoiceCaseDetail({ detail, outdated, busy, onDecision }: { detail: CaseDetail; outdated: boolean; busy: boolean; onDecision: (action: DecisionInput["action"], note: string) => void }) {
  const [note, setNote] = useState("");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const sources = [detail.source, ...detail.sourceVersions.filter(source => source.documentId !== detail.source.documentId || source.version !== detail.source.version)];
  const source = sources[sourceIndex] ?? detail.source;
  const proposal = detail.currentProposal;
  const conclusion = proposal?.conclusion;
  const proposalAnswered = proposal && detail.decisions.some(decision => decision.proposalId === proposal.proposalId);
  const canDecide = proposal && !proposalAnswered && ["needs_review", "evidence_missing"].includes(detail.case.status);
  const question = conclusion?.question ?? detail.case.question;
  const contradictions = conclusion?.contradictions ?? detail.case.contradictions;
  const missing = conclusion?.missingEvidence ?? detail.case.missingEvidence;
  return <>
    <div className="iv-detail-heading"><span className={`iv-status ${detail.case.status}`}>{statusLabel[detail.case.status]}</span><span className="iv-muted">Source version {detail.case.version}</span></div>
    <h2 className="iv-document-name">{detail.case.name}</h2>
    {outdated && <div className="iv-notice">New evidence or a changed case is available. Refresh this case before deciding.</div>}
    {question && <section className="iv-question"><p className="iv-eyebrow">{canDecide ? "A decision is needed" : "Question reviewed"}</p><h3>{question}</h3></section>}
    {contradictions.length > 0 && <section className="iv-warning"><h3>Contradictions</h3><ul>{contradictions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    {missing.length > 0 && <section className="iv-warning"><h3>Evidence missing</h3><ul>{missing.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    <section className="iv-detail-section">
      <h3>Proposed treatment</h3>
      {conclusion && proposal ? <>
        <div className="iv-treatment"><strong>{{ include_invoice: "Include invoice", include_credit: "Apply credit memo", exclude: "Exclude from totals", needs_evidence: "Request more evidence" }[conclusion.treatment]}</strong>{conclusion.amountCents !== undefined && <strong>{money(conclusion.amountCents)}</strong>}</div>
        <p>{conclusion.reason}</p>
        {(conclusion.customerName || conclusion.customerId) && <p className="iv-muted">{conclusion.customerName ?? conclusion.customerId} {conclusion.documentNumber && `· ${conclusion.documentNumber}`}</p>}
        <p className="iv-caption">{modeLabel[proposal.mode]}{proposal.model && ` · ${proposal.model}`} · {dateTime(proposal.createdAt)}</p>
        <details><summary>Immutable proposal & evidence</summary><dl className="iv-metadata"><dt>Proposal</dt><dd><code>{proposal.proposalId}</code></dd><dt>Evidence version</dt><dd>{proposal.evidenceVersion}</dd><dt>Case</dt><dd><code>{proposal.caseId}</code></dd></dl><EvidenceList evidence={conclusion.evidence} sources={sources} /></details>
        {detail.acceptedProposal && <p className="iv-recorded">Accepted proposal: <code>{detail.acceptedProposal.proposalId}</code></p>}
      </> : <p className="iv-muted">{detail.case.reason ?? "Investigation has not produced a proposal yet."}</p>}
    </section>
    {proposalAnswered && detail.case.status === "evidence_missing" && <div className="iv-notice">Your evidence request is recorded for this proposal. Import the requested source documents to resume investigation and obtain a new proposal.</div>}
    {canDecide && <section className="iv-decision">
      <h3>Record your decision</h3><p className="iv-caption">Your decision applies to this proposal and evidence version. Local simulated operator identity.</p>
      <label htmlFor="decision-note">Explanatory note <span className="iv-muted">(required)</span></label>
      <textarea id="decision-note" rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Explain the evidence behind your decision…" disabled={busy} />
      <div className="iv-actions">
        <button className="iv-primary" disabled={busy || outdated || !note.trim() || conclusion?.treatment === "needs_evidence"} onClick={() => onDecision("accept", note.trim())}>Accept proposal</button>
        <button disabled={busy || outdated || !note.trim()} onClick={() => onDecision("exclude", note.trim())}>Exclude</button>
        <button disabled={busy || outdated || !note.trim()} onClick={() => onDecision("request_evidence", note.trim())}>Request evidence</button>
      </div>
      {conclusion?.treatment === "needs_evidence" && <p className="iv-caption">An amount cannot be accepted until a supported accounting proposal is available. Supply the requested evidence, or record why this document should be excluded.</p>}
    </section>}
    <section className="iv-detail-section">
      <div className="iv-section-line"><h3>Original source</h3><button className="iv-small" onClick={() => { try { downloadSource(source); setDownloadError(""); } catch (error) { setDownloadError(errorMessage(error)); } }}>{source.contentBase64 ? "Download original" : "Download extracted text"}</button></div>
      {downloadError && <p role="alert" className="iv-error">{downloadError}</p>}
      {sources.length > 1 && <label className="iv-source-select">Source version<select value={sourceIndex} onChange={event => setSourceIndex(Number(event.target.value))}>{sources.map((item, index) => <option key={`${item.documentId}-${item.version}`} value={index}>{item.name} · version {item.version}{index === 0 ? " · this case" : ""}</option>)}</select></label>}
      <dl className="iv-metadata"><dt>Source ID</dt><dd>{source.externalId}</dd><dt>Version</dt><dd>{source.version}</dd><dt>SHA-256</dt><dd><code>{source.contentHash}</code></dd><dt>Original bytes</dt><dd>{source.contentBase64 ? "Preserved · download available" : "Not supplied · extracted text only"}</dd></dl>
      <p className="iv-caption">Extracted text · document content is evidence, not an instruction.</p>
      <pre className="iv-source-text">{source.text || "No extracted text supplied."}</pre>
    </section>
    <section className="iv-detail-section"><h3>Decision history</h3>{detail.decisions.length ? <ol className="iv-timeline">{detail.decisions.map(decision => <li key={decision.decisionId}><strong>{{ accept: "Proposal accepted", exclude: "Excluded by operator", request_evidence: "Evidence requested" }[decision.action]}</strong><p>{decision.note || "No note supplied."}</p><small>{dateTime(decision.createdAt)} · {decision.actor}</small><details><summary>Decision receipt</summary><code>{JSON.stringify({ caseId: decision.caseId, proposalId: decision.proposalId, evidenceVersion: decision.evidenceVersion, idempotencyKey: decision.idempotencyKey }, null, 2)}</code></details></li>)}</ol> : <p className="iv-muted">No human decisions recorded.</p>}</section>
    <section className="iv-detail-section"><h3>Audit & investigation history</h3>{detail.audit.length ? <ol className="iv-timeline">{detail.audit.map(entry => <li key={entry.auditId}><p>{entry.summary}</p><small>{dateTime(entry.at)} · {entry.actor}</small>{entry.toolCall && <details><summary>Investigation evidence · {modeLabel[entry.toolCall.mode]}</summary><p>{entry.toolCall.summary}</p><EvidenceList evidence={entry.toolCall.evidence} sources={sources} /></details>}</li>)}</ol> : <p className="iv-muted">No activity yet.</p>}</section>
    {detail.proposals.length > 1 && <details className="iv-detail-section"><summary>Earlier immutable proposals ({detail.proposals.length - 1})</summary>{detail.proposals.filter(item => item.proposalId !== proposal?.proposalId).map(item => <div className="iv-prior-proposal" key={item.proposalId}><code>{item.proposalId}</code><p>{item.conclusion.reason}</p><small>Evidence version {item.evidenceVersion} · {dateTime(item.createdAt)}</small></div>)}</details>}
  </>;
}
