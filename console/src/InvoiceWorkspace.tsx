import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseDetail, CaseSummary, DecisionInput, SourceInput, WorkspaceSnapshot } from "../../src/invoice-mvp/contracts";
import { InvoiceCaseDetail } from "./InvoiceCaseDetail";
import { ReviewDrawer } from "./ReviewDrawer";
import { errorMessage, InvoiceApiError, invoiceApi, readSourceFiles } from "./invoiceApi";
import { dateTime, modeLabel, money, statusLabel } from "./invoiceFormat";
import "./invoice.css";

type Filter = "all" | "review" | "recorded";
const unresolved = (item: CaseSummary) => item.status === "needs_review" || item.status === "evidence_missing";
const initialCase = () => new URLSearchParams(location.search).get("case");

export type InvoiceContext = Pick<WorkspaceSnapshot, "company" | "runId" | "runtimeMode">;

export function InvoiceWorkspace({ onContextChange, onBusyChange }: { onContextChange?: (context: InvoiceContext) => void; onBusyChange?: (busy: boolean) => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [lastSynced, setLastSynced] = useState<number>();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(initialCase);
  const [detail, setDetail] = useState<CaseDetail>();
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [lastDecision, setLastDecision] = useState<DecisionInput>();
  const [decisionUncertain, setDecisionUncertain] = useState(false);
  const [expandedCustomer, setExpandedCustomer] = useState<string>();
  const detailSequence = useRef(0);
  const loadingWorkspace = useRef(false);
  const working = useRef(false);
  const pendingImport = useRef<{ label: string; documents: SourceInput[]; key: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workspace) onContextChange?.({ company: workspace.company, runId: workspace.runId, runtimeMode: workspace.runtimeMode });
  }, [workspace?.company, workspace?.runId, workspace?.runtimeMode, onContextChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const refresh = useCallback(async () => {
    if (loadingWorkspace.current) return;
    loadingWorkspace.current = true;
    try { setWorkspace(await invoiceApi.workspace()); setLastSynced(Date.now()); setLoadError(""); }
    catch (error) { setLoadError(errorMessage(error)); }
    finally { loadingWorkspace.current = false; }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const onPop = () => setSelected(initialCase());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadDetail = useCallback(async (caseId: string) => {
    const sequence = ++detailSequence.current;
    setDetailLoading(true); setDetailError("");
    try { const next = await invoiceApi.detail(caseId); if (sequence === detailSequence.current) setDetail(next); }
    catch (error) { if (sequence === detailSequence.current) setDetailError(errorMessage(error)); }
    finally { if (sequence === detailSequence.current) setDetailLoading(false); }
  }, []);
  useEffect(() => {
    setDetail(undefined); setDetailError(""); setLastDecision(undefined); setDecisionUncertain(false);
    if (selected) void loadDetail(selected);
    else { detailSequence.current++; setDetailLoading(false); }
  }, [selected, loadDetail]);

  const selectCase = (caseId: string | null) => {
    setSelected(caseId);
    setActionError(""); setNotice("");
    const url = new URL(location.href);
    if (caseId) url.searchParams.set("case", caseId); else url.searchParams.delete("case");
    history.pushState(null, "", url);
  };

  async function runAction(name: string, action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(name); setActionError(""); setNotice("");
    try { await action(); }
    catch (error) { setActionError(errorMessage(error)); }
    finally { working.current = false; setBusy(""); await refresh(); }
  }

  async function importDocuments(batch: { label: string; documents: SourceInput[]; key: string }) {
    pendingImport.current = batch;
    await invoiceApi.import(batch.label, batch.documents, batch.key);
    pendingImport.current = undefined;
    setNotice(`“${batch.label}” imported. Processing continues in this workspace.`);
    setFiles([]); setLabel(""); setImportOpen(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  const importDemo = (late: boolean) => void runAction(late ? "Adding correction…" : "Importing demo…", async () => {
    const batch = await invoiceApi.demo(late);
    await importDocuments({ ...batch, key: crypto.randomUUID() });
  });

  async function submitDecision(request: DecisionInput) {
    setLastDecision(request);
    try {
      await invoiceApi.decide(request);
      setDecisionUncertain(false);
      setNotice("Decision saved. The latest case, totals and audit history reflect its persisted outcome.");
      await loadDetail(request.caseId);
    } catch (error) {
      if (error instanceof InvoiceApiError && error.status === 409) {
        setDecisionUncertain(false); setLastDecision(undefined);
        setActionError(`This decision was not applied because the proposal changed or conflicts with an existing answer. ${error.message} The latest case has been loaded; review it before submitting a new decision.`);
        await loadDetail(request.caseId);
      } else {
        setDecisionUncertain(true);
        throw error;
      }
    }
  }

  const decide = (action: DecisionInput["action"], note: string) => {
    if (!detail?.currentProposal) return;
    const request: DecisionInput = { caseId: detail.case.caseId, proposalId: detail.currentProposal.proposalId, evidenceVersion: detail.currentProposal.evidenceVersion, idempotencyKey: crypto.randomUUID(), action, note };
    void runAction("Saving decision…", () => submitDecision(request));
  };

  const activeDetail = detail?.case.caseId === selected ? detail : undefined;
  const currentSummary = workspace?.cases.find(item => item.caseId === selected);
  const outdated = Boolean(activeDetail && currentSummary && (activeDetail.case.evidenceVersion !== currentSummary.evidenceVersion || activeDetail.case.currentProposalId !== currentSummary.currentProposalId || activeDetail.case.status !== currentSummary.status));
  const cases = [...(workspace?.cases ?? [])].filter(item => (filter === "all" || (filter === "review" ? unresolved(item) : item.status === "recorded")) && `${item.name} ${item.reason ?? ""} ${item.customerId ?? ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(unresolved(b)) - Number(unresolved(a)) || b.updatedAt - a.updatedAt);
  const progress = workspace?.progress;
  const needsAttention = (progress?.needsReview ?? 0) + (progress?.evidenceMissing ?? 0);
  const completed = progress ? progress.total - progress.pending : 0;
  const netCents = workspace?.customerTotals.reduce((sum, total) => sum + total.netCents, 0) ?? 0;
  const hasDemo = workspace?.batches.some(batch => /demo|synthetic/i.test(batch.label)) ?? false;

  return <div className="iv-app">
    <section aria-labelledby="invoice-heading">
      <div className="page-heading"><div><h2 id="invoice-heading" tabIndex={-1}>Invoices</h2><p>Review customer invoices, resolve exceptions, and trace every recorded total to its source.</p></div><button className="iv-primary" aria-expanded={importOpen || Boolean(workspace && !workspace.batches.length)} aria-controls="invoice-import" disabled={!workspace || Boolean(busy)} onClick={() => setImportOpen(!importOpen)}>＋ Import documents</button></div>
      <div className="iv-announcements" aria-live="polite">
        {loadError && <div className="iv-error" role="alert"><strong>Connection needs attention.</strong> {loadError} {workspace && "Showing the last saved snapshot."}<button onClick={() => void refresh()}>Retry connection</button></div>}
        {actionError && <div className="iv-error" role="alert">{actionError}{pendingImport.current && <button disabled={Boolean(busy)} onClick={() => void runAction("Retrying import…", () => importDocuments(pendingImport.current!))}>Retry same import</button>}</div>}
        {notice && <div className="iv-success" role="status">{notice}</div>}
        {busy && <p className="iv-busy" role="status">{busy}</p>}
      </div>
      {(!workspace && !loadError) && <div className="iv-empty">Loading the saved workspace…</div>}
      {workspace && <>
        <section className="iv-stats" aria-label="Workspace summary">
          <div className="iv-stat iv-stat-total"><span>Net invoiced</span><strong>{money(netCents)}</strong><small>Recorded invoices less credits</small></div>
          <div className="iv-stat"><span>Needs attention</span><strong>{needsAttention}</strong><small>{progress?.needsReview ?? 0} to review · {progress?.evidenceMissing ?? 0} missing evidence</small></div>
          <div className="iv-stat"><span>Documents processed</span><strong>{completed}<small> / {progress?.total ?? 0}</small></strong><small>{progress?.pending ? `${progress.pending} in progress` : "All current processing complete"}</small></div>
          <div className="iv-stat"><span>Recorded documents</span><strong>{progress?.recorded ?? 0}</strong><small>{progress?.duplicate ?? 0} duplicate · {progress?.superseded ?? 0} superseded</small></div>
        </section>
        <p className="iv-accounting-note">Net invoiced totals are not cash or outstanding balances. Unresolved documents are excluded until supported and recorded.</p>
        {(importOpen || !workspace.batches.length) && <section id="invoice-import" className="iv-import iv-panel" aria-label="Import a document batch">
          <div className="iv-import-demo"><h3>Try a sample batch</h3><p>Synthetic invoices, credits, supporting records and an exception. No real customer data.</p><button className="iv-primary" disabled={Boolean(busy)} onClick={() => importDemo(false)}>Import synthetic demo</button>{hasDemo && <button disabled={Boolean(busy)} onClick={() => importDemo(true)}>Add late correction</button>}</div>
          <form className="iv-import-form" onSubmit={event => { event.preventDefault(); void runAction("Importing documents…", async () => { const documents = await readSourceFiles(files); await importDocuments({ label: label.trim() || `Upload · ${files[0]?.name ?? "Documents"}`, documents, key: crypto.randomUUID() }); }); }}>
            <h3>Or use your own documents</h3><label htmlFor="batch-label">Batch name</label><input id="batch-label" value={label} onChange={event => setLabel(event.target.value)} placeholder="October customer invoices" />
            <label htmlFor="source-files">Source files</label><input ref={fileInput} id="source-files" type="file" accept=".txt,.json,.csv" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} />
            <p className="iv-caption">TXT, CSV or JSON · up to 2 MB per file. Uploading the same filename with changed content creates a new version.</p>
            <details className="iv-caption"><summary>JSON bundles & PDF support</summary><p>A JSON bundle uses <code>{'{"documents":[{"externalId":"invoice-1","name":"invoice.pdf","mimeType":"application/pdf","text":"extracted text","contentBase64":"original bytes"}]}'}</code>. PDF bundles require original bytes and extracted text; this browser does not extract PDFs. Reusing an <code>externalId</code> is refused unless the document sets <code>"newVersion": true</code>; a new version of a recorded invoice waits for your review before it replaces the original. Plain files get their own ID, so two files with the same name never replace each other.</p></details>
            <button disabled={!files.length || Boolean(busy)} type="submit">Import {files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "selected files"}</button>
          </form>
        </section>}
        <div className="iv-work-grid">
          <section className="iv-panel iv-totals"><div className="iv-panel-heading"><div><h2>Customer totals</h2></div><span className="iv-caption">USD</span></div>
            {workspace.customerTotals.length ? <div className="iv-table-wrap"><table aria-label="Recorded customer totals"><thead><tr><th>Customer / evidence</th><th>Invoices</th><th>Credits</th><th>Net invoiced</th></tr></thead><tbody>{workspace.customerTotals.map(customer => <CustomerRows key={customer.customerId} customer={customer} expanded={expandedCustomer === customer.customerId} onToggle={() => setExpandedCustomer(expandedCustomer === customer.customerId ? undefined : customer.customerId)} onSelect={selectCase} />)}</tbody></table></div> : <div className="iv-empty"><span className="iv-empty-symbol">≡</span><h3>Your customer totals will appear here.</h3><p>Import documents to start building an evidence-backed record.</p></div>}
            <footer className="iv-panel-footer">Each recorded amount links to an immutable proposal and source evidence.</footer>
          </section>
          <section className="iv-panel iv-batches"><div className="iv-panel-heading"><div><h2>Document batches</h2></div></div>{workspace.batches.length ? <ul>{[...workspace.batches].reverse().map(batch => { const items = workspace.cases.filter(item => item.batchId === batch.batchId); const pending = items.filter(item => ["received", "investigating"].includes(item.status)).length; return <li key={batch.batchId}><strong>{batch.label}</strong><span>{batch.documentIds.length} documents · {dateTime(batch.createdAt)}</span><progress max={Math.max(1, items.length)} value={items.length - pending} aria-label={`${batch.label} progress`} /><small>{pending ? `${pending} processing` : "Processing complete"} · {items.filter(unresolved).length} unresolved</small></li>; })}</ul> : <p className="iv-empty">No batches imported yet.</p>}{hasDemo && <div className="iv-panel-footer"><button disabled={Boolean(busy)} onClick={() => importDemo(true)}>Add late correction</button><p className="iv-caption">Import a separate revision to demonstrate supersession.</p></div>}</section>
        </div>
        <section className="iv-panel iv-cases"><div className="iv-panel-heading"><div><h2>Document review</h2></div><button disabled={Boolean(busy)} onClick={() => void runAction("Resuming investigation…", async () => { await invoiceApi.process(); setNotice("Pending investigation resumed using deterministic rules. No live model requested."); if (selected) await loadDetail(selected); })}>Resume processing</button></div><div className="iv-case-controls"><div className="iv-tabs" aria-label="Filter documents">{([["all", `All documents ${workspace.cases.length}`], ["review", `Needs attention ${needsAttention}`], ["recorded", `Recorded ${progress?.recorded ?? 0}`]] as const).map(([value, text]) => <button key={value} aria-pressed={filter === value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{text}</button>)}</div><input aria-label="Search documents" placeholder="Search documents…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          {cases.length ? <div className="iv-table-wrap"><table className="iv-case-table" aria-label="Document review"><thead><tr><th>Document</th><th>Status</th><th>What needs to happen</th><th>Version</th><th><span className="iv-sr-only">Open</span></th></tr></thead><tbody>{cases.map(item => <tr key={item.caseId}><td data-label="Document"><button className="iv-document-link" onClick={() => selectCase(item.caseId)}>{item.name}</button><small>{item.externalId}</small></td><td data-label="Status"><span className={`iv-status ${item.status}`}>{statusLabel[item.status]}</span></td><td data-label="Next step" className="iv-case-reason">{item.question ?? item.reason ?? (item.status === "received" ? "Waiting for investigation" : "Open the source and investigation history")}</td><td data-label="Version">v{item.version}</td><td data-label="Review"><button className="iv-icon-button" aria-label={`Review ${item.name}`} onClick={() => selectCase(item.caseId)}>↗</button></td></tr>)}</tbody></table></div> : <div className="iv-empty">{workspace.cases.length ? "No documents match this view." : "Imported documents will appear here, including anything that needs your attention."}</div>}
        </section>
        <footer className="iv-workspace-footer"><span>{loadError ? "Connection interrupted" : `Saved in backend · refreshed ${lastSynced ? dateTime(lastSynced) : "just now"}`}</span><span>One company · USD · {workspace ? modeLabel[workspace.runtimeMode] : ""}</span></footer>
      </>}
    </section>
    {selected && <ReviewDrawer open onClose={() => { if (!busy) selectCase(null); }} labelledBy="invoice-case-heading" fallbackFocusId="invoice-heading" closeDisabled={Boolean(busy)}><div className="iv-detail"><h2 className="iv-sr-only" id="invoice-case-heading">Document case detail</h2><div className="iv-detail-toolbar"><button disabled={detailLoading || Boolean(busy)} onClick={() => void loadDetail(selected)}>Refresh case</button></div>
      {detailError && <div className="iv-error" role="alert">{detailError}<button onClick={() => void loadDetail(selected)}>Retry case</button></div>}
      {detailLoading && <p role="status" className="iv-muted">Loading saved case…</p>}
      {actionError && <div className="iv-error" role="alert">{actionError}</div>}{notice && <div className="iv-success" role="status">{notice}</div>}
      {lastDecision && <div className="iv-receipt"><p>{decisionUncertain ? "The last submission could not be confirmed. Retry the exact request safely." : "Your last decision request is retained for a safe replay."}</p><button disabled={Boolean(busy)} onClick={() => void runAction("Checking saved decision…", () => submitDecision(lastDecision))}>{decisionUncertain ? "Retry same decision" : "Replay last decision"}</button></div>}
      {activeDetail && <InvoiceCaseDetail key={`${activeDetail.case.caseId}:${activeDetail.currentProposal?.proposalId}:${activeDetail.case.evidenceVersion}`} detail={activeDetail} outdated={outdated} busy={Boolean(busy) || decisionUncertain || detailLoading} onDecision={decide} />}
    </div></ReviewDrawer>}
  </div>;
}

function CustomerRows({ customer, expanded, onToggle, onSelect }: { customer: WorkspaceSnapshot["customerTotals"][number]; expanded: boolean; onToggle: () => void; onSelect: (id: string) => void }) {
  const contributions = customer.contributions.filter(item => item.active);
  return <><tr><td data-label="Customer"><button className="iv-customer-button" aria-expanded={expanded} onClick={onToggle}>{customer.legalName}<span>{customer.validInvoiceCount} valid invoices · {expanded ? "Hide evidence ↑" : "View evidence ↓"}</span></button></td><td data-label="Invoices">{money(customer.grossCents)}</td><td data-label="Credits">{money(customer.creditCents)}</td><td data-label="Net invoiced" className="iv-net">{money(customer.netCents)}</td></tr>{expanded && <tr className="iv-contribution-row"><td colSpan={4}>{contributions.length ? <ul>{contributions.map(item => <li key={item.contributionId}><div><button className="iv-document-link" onClick={() => onSelect(item.caseId)}>{item.documentNumber} ↗</button><small>{item.kind === "credit" ? "Credit memo" : "Invoice"} · {item.evidence.length} evidence reference{item.evidence.length === 1 ? "" : "s"}</small>{item.evidence.map((ref, index) => <code key={index} title={ref.contentHash}>{ref.documentId} / v{ref.version} / SHA-256 {ref.contentHash.slice(0, 12)}…</code>)}</div><strong>{item.kind === "credit" ? "−" : ""}{money(item.amountCents)}</strong></li>)}</ul> : <p className="iv-muted">No recorded contributions. This customer remains visible with a zero total.</p>}</td></tr>}</>;
}
