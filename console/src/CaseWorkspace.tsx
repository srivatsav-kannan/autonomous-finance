import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { EvidenceRecord } from "./EvidenceRecord";
import { Icon } from "./Icon";
import { money, person, type CaseRecords } from "./case-model";
import { useUrlState } from "./useUrlState";
import "./case-workspace.css";
const PdfViewer = lazy(() => import("./PdfViewer"));
const VIEWS = ["overview", "evidence", "decisions", "payment", "reconciliation", "history"] as const;
const LABELS = ["Overview", "Evidence & matching", "Decisions", "Payment", "Reconciliation", "History"];

export function CaseSummary({ ask, records }: { ask: Doc<"asks">; records: CaseRecords }) {
  const bill = records.bills[0];
  return <>
    <h3>{bill ? person(bill.vendor) : ask.title}</h3>
    {bill && <p className="case-identity">{records.bills.map((b) => b.invoiceNumber).join(", ")} <span>{money(records.bills.reduce((sum, b) => sum + b.totalCents, 0))}</span></p>}
    <div className={`case-notice ${ask.status === "answered" ? "resolved" : ""}`}><Icon name={ask.status === "answered" ? "check" : "file"} /><span>{ask.status === "answered" ? "Response recorded" : ask.title}</span></div>
    <dl className="case-facts"><div><dt>Requested by</dt><dd>{person(ask.from)}</dd></div><div><dt>Decision owner</dt><dd>{person(ask.to)}</dd></div></dl>
    <CaseStages records={records} />
  </>;
}

export function CaseStages({ records }: { records: CaseRecords }) {
  return <dl className="case-stages"><div><dt>Bill</dt><dd>{records.bills.length ? [...new Set(records.bills.map((b) => b.status))].join(", ") : "Not linked"}</dd></div><div><dt>Payment</dt><dd>{records.payments.length ? [...new Set(records.payments.map((p) => p.status.replaceAll("_", " ")))].join(", ") : "Not linked"}</dd></div></dl>;
}

function EvidencePane({ runId, ask, records }: { runId: string; ask: Doc<"asks">; records: CaseRecords }) {
  const docs = useQuery(api.admin.eventsOfType, { runId, type: "document.received" });
  const receipts = useQuery(api.admin.eventsOfType, { runId, type: "receiving.logged" });
  const [selected, setSelected] = useState("");
  const [local, setLocal] = useState<{ url: string; name: string } | null>(null);
  const [fileError, setFileError] = useState("");
  useEffect(() => () => { if (local) URL.revokeObjectURL(local.url); }, [local]);
  const refs = new Set(ask.evidence.map((e) => e.ref));
  const sources = (docs ?? []).filter((d) => refs.has(d.externalId) || refs.has(d._id) || records.bills.some((b) => b.documentEventId === d._id));
  const source = sources.find((s) => s._id === selected) ?? sources[0];
  const sourceText = source ? typeof source.payload?.text === "string" ? source.payload.text : JSON.stringify(source.payload, null, 2) : "";
  const bill = records.bills.find((b) => b.documentEventId === source?._id) ?? records.bills[0];
  const receipt = bill?.deliveryId ? receipts?.find((r) => r.payload?.deliveryId === bill.deliveryId && r.payload?.vendor === bill.vendor && r.payload?.store === bill.store) : undefined;
  return <div className="evidence-workspace">
    <section className="source-pane" aria-label="Source document">
      <div className="source-toolbar"><Icon name="file" /><label className="source-select">Source<select aria-label="Source document" value={source?._id ?? ""} disabled={!sources.length} onChange={(e) => { setSelected(e.target.value); setLocal(null); }}><option value="" disabled>No linked source</option>{sources.map((s) => <option key={s._id} value={s._id}>{s.payload?.subject ?? s.externalId}</option>)}</select></label></div>
      <label className="local-pdf">Open PDF for review<input type="file" accept="application/pdf,.pdf" aria-label="Open local PDF for review" onChange={(e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".pdf")) { setFileError("Choose a PDF document."); return; }
        setFileError(""); setLocal({ url: URL.createObjectURL(file), name: file.name }); e.target.value = "";
      }} /></label>
      {fileError && <p role="alert">{fileError}</p>}
      {local ? <><p className="source-caption">Local preview only. This file has not been attached to the case. <button type="button" onClick={() => setLocal(null)}>Close PDF</button></p><Suspense fallback={<p role="status">Loading PDF viewer…</p>}><PdfViewer key={local.url} url={local.url} name={local.name} /></Suspense></> : docs === undefined ? <p className="loading" role="status">Loading source documents…</p> : source ? <><pre className="source-paper" tabIndex={0} aria-label="Scrollable original source">{sourceText}</pre><p className="source-caption">Original source text / {source.externalId}</p></> : <div className="empty"><Icon name="file" /><strong>No source document linked</strong><p>The decision records remain available on the right. Open a PDF to inspect it locally.</p></div>}
    </section>
    <section className="matching-pane"><h3>Compare supporting evidence</h3>
      {bill ? <><p className="muted">{bill.invoiceNumber} / {money(bill.totalCents)}</p><div className="table-scroll"><table className="grid matching-table"><thead><tr><th>Item</th><th>Invoiced</th><th>Received</th><th>Amount</th></tr></thead><tbody>{bill.lines.map((line, i) => {
        const match = Array.isArray(receipt?.payload?.items) && line.sku ? receipt.payload.items.find((item: { sku?: string }) => item.sku === line.sku) : undefined;
        return <tr key={i}><td>{line.description}</td><td>{line.quantity}</td><td>{receipts === undefined ? "Loading…" : typeof match?.qtyReceived === "number" ? match.qtyReceived : "Unknown"}</td><td>{money(line.amountCents)}</td></tr>;
      })}</tbody></table></div><div className="case-notice"><Icon name="file" /><span>{receipt ? `Receipt linked: ${receipt.externalId}` : "No matching receipt linked. Quantities remain unverified."}</span></div>{bill.exceptions.length > 0 && <><h3>Recorded exceptions</h3><ul className="case-exceptions">{bill.exceptions.map((e) => <li key={e}>{e}</li>)}</ul></>}</> : <p className="muted">No bill is linked to this decision. Review the source records below.</p>}
      <h3>Decision and policy records</h3>{ask.evidence.map((e) => <EvidenceRecord key={e.ref} runId={runId} reference={e.ref} label={e.label} />)}
      {records.bills.map((b) => b.decisionPath && !refs.has(b.decisionPath) ? <EvidenceRecord key={b._id} runId={runId} reference={b.decisionPath} label={`${b.invoiceNumber} decision`} /> : null)}
      <p className="source-caption">Reviewing a document does not approve a bill or authorize a payment.</p>
    </section>
  </div>;
}

function Reconciliation({ runId, records }: { runId: string; records: CaseRecords }) {
  const bank = useQuery(api.bank.workspace, { runId });
  const transactions = bank?.transactions.filter((t) => records.payments.some((p) => t.payment?.id === p._id));
  return <section className="case-section"><h3>Bank and accounting outcomes</h3><p className="muted">Settlement and posting are separate checks for the original payment.</p>{!bank ? <p role="status">Loading bank evidence…</p> : !transactions?.length ? <p className="empty">No bank transaction is linked to this case yet.</p> : transactions.map((t) => <div className="reconciliation-row" key={t.id}><h4>{t.description}</h4><dl className="case-facts"><div><dt>Bank reference</dt><dd>{t.bankRef ?? "Not recorded"}</dd></div><div><dt>Payment status</dt><dd>{t.payment?.status}</dd></div><div><dt>Reconciliation</dt><dd>{t.status.replaceAll("_", " ")}</dd></div><div><dt>Accounting entries</dt><dd>{t.entries.length ? t.entries.map((e) => `#${e.sequence} (${e.status})`).join(", ") : "No linked journal entry"}</dd></div></dl></div>)}</section>;
}

export function CaseWorkspace({ runId, ask, asks, records }: { runId: string; ask: Doc<"asks">; asks: Doc<"asks">[]; records: CaseRecords }) {
  const [view, setView] = useUrlState("caseView", "evidence", VIEWS);
  const related = asks.filter((a) => a._id === ask._id || (a.taskId && a.taskId === ask.taskId) || (a.paymentIntentId && records.payments.some((p) => p._id === a.paymentIntentId)) || a.evidence.some((e) => records.bills.some((b) => b.decisionPath === e.ref)));
  return <>
    <CaseStages records={records} />
    <nav className="tab-strip case-tabs" aria-label="Case sections">{VIEWS.map((v, i) => <button type="button" className={`tab-item ${v === view ? "is-active" : ""}`} aria-current={v === view ? "page" : undefined} key={v} onClick={() => setView(v)}>{LABELS[i]}</button>)}</nav>
    <div className="case-panel">
      <div hidden={view !== "evidence"}><EvidencePane runId={runId} ask={ask} records={records} /></div>
      {view === "overview" && <section className="case-section"><h3>What needs your attention</h3><pre className="ask-body">{ask.body}</pre><dl className="case-facts"><div><dt>Requested by</dt><dd>{person(ask.from)}</dd></div><div><dt>Decision owner</dt><dd>{person(ask.to)}</dd></div><div><dt>Received</dt><dd>{new Date(ask.createdAt).toLocaleString()}</dd></div></dl>{records.bills.map((b) => <div key={b._id} className="case-bill"><h3>{person(b.vendor)} / {b.invoiceNumber}</h3><p>{money(b.totalCents)} / Due {b.dueDate}</p><p className="muted">Recognition journal: {b.entryId ?? "Not linked"}</p></div>)}</section>}
      {view === "decisions" && <section className="case-section"><h3>Decisions in this case</h3>{related.map((a) => <article className="case-decision" key={a._id}><h4>{a.title}</h4><pre className="ask-body">{a.body}</pre><p className="muted">{person(a.from)} / {a.status}</p>{a.answer && <p>Response: {a.options.find((o) => o.id === a.answer?.optionId)?.label ?? a.answer.optionId}</p>}</article>)}</section>}
      {view === "payment" && <section className="case-section"><h3>Saved payment proposal</h3>{!records.payments.length ? <p className="empty">No payment proposal is linked to this decision.</p> : records.payments.map((p) => <article key={p._id} className="case-payment"><h4>{person(p.payee)} / {money(p.amountCents)}</h4><dl className="case-facts"><div><dt>Payment identity</dt><dd>{p._id}</dd></div><div><dt>Status</dt><dd>{p.status.replaceAll("_", " ")}</dd></div><div><dt>Destination</dt><dd>{p.remitTo.bank} / ending {p.remitTo.accountLast4}</dd></div><div><dt>Beneficiary memory version</dt><dd><code>{p.remitTo.memorySha}</code></dd></div><div><dt>Method / Due</dt><dd>{p.method.toUpperCase()} / {p.dueDate}</dd></div><div><dt>Approvals</dt><dd>{p.approvals.length} of {p.requiredApprovals}</dd></div><div><dt>Bank reference</dt><dd>{p.bankRef ?? "Not recorded"}</dd></div></dl><p className="muted">{p.requiresHuman ? "Human authorization is required by policy." : "Authorization follows the recorded approval policy."}</p></article>)}</section>}
      {view === "reconciliation" && <Reconciliation runId={runId} records={records} />}
      {view === "history" && <section className="case-section"><h3>Contextual history</h3><ol className="case-history">{related.flatMap((a) => [{ key: `${a._id}-created`, at: a.createdAt, label: `${person(a.from)} requested: ${a.title}` }, ...(a.answer ? [{ key: `${a._id}-answered`, at: a.answer.at, label: `${person(a.answer.by)} responded: ${a.options.find((o) => o.id === a.answer?.optionId)?.label ?? a.answer.optionId}` }] : [])]).concat(records.payments.flatMap((p) => [{ key: p._id, at: p.createdAt, label: `Payment proposed: ${money(p.amountCents)}` }, ...p.approvals.map((a, i) => ({ key: `${p._id}-${i}`, at: a.at, label: `${person(a.seatId)} recorded ${a.kind} approval` }))])).sort((a, b) => a.at - b.at).map((event) => <li key={event.key}><Icon name="file" /><div><p>{event.label}</p><time>{new Date(event.at).toLocaleString()}</time></div></li>)}</ol></section>}
    </div>
  </>;
}
