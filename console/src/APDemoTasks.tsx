import { useEffect, useState } from "react";
import type { ApexCorpus } from "../../src/ap-system/replay/apex-corpus";
import { apRequestPath, isApexWorkspace } from "./apRuntime";
import type { APCaseDetail } from "../../src/ap-system/contracts";
import { apLabel, apMoney } from "./apSystemView";

// The walkthrough identifies the exact originals from PR #111, never a vendor-name match.
export const apexTasks = [
  { invoice: "AVILA-202412-A6", sha256: "affe956edfd5d94a895ef35404bd149904199eeda2c593bd172c59bb13c9d9bc", title: "Review an invoice through settlement", description: "Original invoice → supporting evidence → approvals → payment → reconciliation.", historical: false },
  { invoice: "AVILA-202403-A1", sha256: "c974e400eacb221d0a07fae70bd00a3a1f34574b9119c427fae3940f1025c4ff", title: "Inspect an already-paid invoice", description: "Compare the original with the historical payment evidence in the APEX replay.", historical: true },
] as const;
export function apexTaskFor(detail: APCaseDetail) {
  if (!/^apex107-(?:replay-20261025|live-[0-9]{8}-[a-z0-9-]{1,40})$/.test(detail.runId) || detail.scope.provider !== "fake" || detail.scope.environment !== "local" || detail.organizationId !== "apex107-synthetic-sterling-marsh" || detail.scope.runId !== detail.runId || detail.scope.organizationId !== detail.organizationId || detail.scope.accountId !== "apex107-usd-operating") return undefined;
  return apexTasks.find(task => detail.candidate?.invoiceNumber === task.invoice && detail.currentSourceBindings.some(binding => binding.sha256 === task.sha256 && detail.sources.some(source => source.kind === "invoice" && source.sourceId === binding.sourceId && source.revision === binding.revision && source.sha256 === binding.sha256)));
}
export function APDemoTasks({ cases, selectedId, busy, onSelect }: { cases: APCaseDetail[]; selectedId: string; busy: boolean; onSelect: (id: string) => void }) {
  const [corpus, setCorpus] = useState<ApexCorpus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!isApexWorkspace()) return;
    const abort = new AbortController();
    fetch(apRequestPath("/api/ap-system/runtime"), {signal:abort.signal, credentials:"same-origin"}).then(async response => {
      if (!response.ok) throw Error("Dataset coverage is unavailable.");
      const runtime = await response.json();
      if (runtime.corpus) setCorpus(runtime.corpus);
    }).catch(failure => {if (!abort.signal.aborted) setError(failure.message);});
    return () => abort.abort();
  }, []);
  const matches = apexTasks.map(task => ({ task, detail: cases.find(c => apexTaskFor(c) === task && !c.links.duplicateOfCaseId) }));
  if (!corpus && !matches.some(({ detail }) => detail)) return null;
  return <section className="aps-demo" aria-label="APEX demo tasks">
    <div className="aps-section-heading"><div><h3>{corpus ? "APEX World 9 / All invoice originals" : "APEX · Invoice to outcome"}</h3><p className="aps-caption">Sterling, Marsh & Associates · Synthetic benchmark documents, simulated approvals and FakeBank.</p></div><a href="https://github.com/srivatsav-kannan/autonomous-finance/pull/111" target="_blank" rel="noreferrer">Replay evidence ↗</a></div>
    {error && <p role="status">{error}</p>}
    {corpus && <>
      <p className="aps-corpus-status"><strong>{corpus.entries.filter(entry => cases.some(detail => matchesOriginal(detail,entry.sha256))).length} / {corpus.totalInvoices} originals imported</strong><span>{corpus.entries.filter(entry => cases.some(detail => detail.extraction.status === "complete" && matchesOriginal(detail,entry.sha256))).length} parsed</span><span>{corpus.supplierCount} suppliers</span><span>{corpus.sourcePaidInvoices} historically paid</span><span>{corpus.openInvoices} open in source ledger</span></p>
      <p className="aps-caption">All available contract-attorney invoice PDFs from this APEX world. Missing approvals, arithmetic discrepancies and incomplete evidence remain visible holds.</p>
      <details className="aps-corpus"><summary>Browse every invoice and its source reconciliation</summary><ul>{corpus.entries.map(entry => {
        const detail = cases.find(candidate => !candidate.links.duplicateOfCaseId && matchesOriginal(candidate,entry.sha256));
        return <li key={entry.sha256}><div className="aps-section-heading"><button type="button" className="aps-text-button" disabled={busy || !detail} onClick={() => detail && onSelect(detail.caseId)}>{entry.invoiceNumber ?? entry.file}</button><strong>{entry.totalCents === null ? "Unresolved amount" : apMoney(entry.totalCents)}</strong></div><p>{entry.supplierName} / {entry.classification === "historical_paid" ? "Historically paid" : entry.classification === "open" ? "Open in source ledger" : "Source comparison needs review"} / {detail ? "Imported" : "Not imported"}</p><details><summary>Ledger and bank comparison{entry.classification === "historical_paid" ? ` / ${entry.reconciliation.status}` : ""}</summary><ul>{[...entry.ledgerChecks,...entry.reconciliation.checks].map((check,index) => <li key={index}>{check.passed ? "Pass" : "Needs review"}: {check.check}</li>)}</ul>{entry.reconciliation.reference && <p>Bank reference: {entry.reconciliation.reference}. Statement: {entry.reconciliation.statement}</p>}<p className="aps-caption">These are historical source records, separate from new payments in this workspace.</p></details></li>;
      })}</ul></details>
    </>}
    {!corpus && <div className="aps-demo-tasks">{matches.map(({ task, detail }, i) => <button key={task.invoice} className={selectedId === detail?.caseId ? "is-selected" : ""} disabled={!detail || busy} aria-pressed={!!detail && selectedId === detail.caseId} onClick={() => detail && onSelect(detail.caseId)}>
      <span className="aps-caption">Task {i + 1} · {task.invoice}</span><strong title={task.description}>{task.title}</strong><span className="aps-demo-outcome">{detail ? `${apMoney(detail.amounts.invoicedCents)} · ${task.historical ? "Historical source review" : `${apLabel(detail.states.execution)} / ${apLabel(detail.states.reconciliation)}`}` : "Awaiting import"}</span>
    </button>)}</div>}
  </section>;
}
export function APDemoContext({ detail }: { detail: APCaseDetail }) {
  const task = apexTaskFor(detail);
  if (detail.sourceOutcome) return <section className="aps-notice"><strong>Historically paid / New payment blocked</strong><p>{detail.sourceOutcome.reason}</p><p>{apMoney(detail.sourceOutcome.amountCents)} / {detail.sourceOutcome.sourceReference}</p><small>This status is retained by the backend across reimports and revisions. It is not a new bank settlement.</small></section>;
  if (!task) return null;
  return <p className="aps-notice">{task.historical ? "Historical source review. This invoice is paid in the APEX dataset; the replay preserves it for inspection. Its source outcome is separate from this workspace’s execution status. See Replay evidence for the ledger, bank and statement comparison." : "Follow this case from its original invoice through supporting evidence, business approval, separate payment authorization and reconciliation. Statuses below come from this local replay."}</p>;
}

function matchesOriginal(detail: APCaseDetail, hash: string) {
  return detail.currentSourceBindings.some(binding => binding.sha256 === hash && detail.sources.some(source => source.kind === "invoice" && source.sourceId === binding.sourceId && source.revision === binding.revision && source.sha256 === hash));
}
