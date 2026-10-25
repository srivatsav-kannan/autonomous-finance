import type { APCaseDetail } from "../../src/ap-system/contracts";
import { apLabel, apMoney } from "./apSystemView";

// The walkthrough identifies the exact originals from PR #111, never a vendor-name match.
export const apexTasks = [
  { invoice: "AVILA-202412-A6", sha256: "affe956edfd5d94a895ef35404bd149904199eeda2c593bd172c59bb13c9d9bc", title: "Review an invoice through settlement", description: "Original invoice → supporting evidence → approvals → payment → reconciliation.", historical: false },
  { invoice: "AVILA-202403-A1", sha256: "c974e400eacb221d0a07fae70bd00a3a1f34574b9119c427fae3940f1025c4ff", title: "Inspect an already-paid invoice", description: "Compare the original with the historical payment evidence in the APEX replay.", historical: true },
] as const;
export function apexTaskFor(detail: APCaseDetail) {
  if (detail.runId !== "apex107-replay-20261025" || detail.scope.provider !== "fake" || detail.scope.environment !== "local" || detail.organizationId !== "apex107-synthetic-sterling-marsh" || detail.scope.runId !== detail.runId || detail.scope.organizationId !== detail.organizationId || detail.scope.accountId !== "apex107-usd-operating") return undefined;
  return apexTasks.find(task => detail.candidate?.invoiceNumber === task.invoice && detail.currentSourceBindings.some(binding => binding.sha256 === task.sha256 && detail.sources.some(source => source.kind === "invoice" && source.sourceId === binding.sourceId && source.revision === binding.revision && source.sha256 === binding.sha256)));
}
export function APDemoTasks({ cases, selectedId, busy, onSelect }: { cases: APCaseDetail[]; selectedId: string; busy: boolean; onSelect: (id: string) => void }) {
  const matches = apexTasks.map(task => ({ task, detail: cases.find(c => apexTaskFor(c) === task && !c.links.duplicateOfCaseId) }));
  if (!matches.some(({ detail }) => detail)) return null;
  return <section className="aps-demo" aria-label="APEX demo tasks">
    <div className="aps-section-heading"><div><h3>APEX · Invoice to outcome</h3><p className="aps-caption">Sterling, Marsh & Associates · Synthetic benchmark documents, simulated approvals and FakeBank.</p></div><a href="https://github.com/srivatsav-kannan/autonomous-finance/pull/111" target="_blank" rel="noreferrer">Replay evidence ↗</a></div>
    <div className="aps-demo-tasks">{matches.map(({ task, detail }, i) => <button key={task.invoice} className={selectedId === detail?.caseId ? "is-selected" : ""} disabled={!detail || busy} aria-pressed={!!detail && selectedId === detail.caseId} onClick={() => detail && onSelect(detail.caseId)}>
      <span className="aps-caption">Task {i + 1} · {task.invoice}</span><strong title={task.description}>{task.title}</strong><span className="aps-demo-outcome">{detail ? `${apMoney(detail.amounts.invoicedCents)} · ${task.historical ? "Historical source review" : `${apLabel(detail.states.execution)} / ${apLabel(detail.states.reconciliation)}`}` : "Awaiting import"}</span>
    </button>)}</div>
  </section>;
}
export function APDemoContext({ detail }: { detail: APCaseDetail }) {
  const task = apexTaskFor(detail);
  if (!task) return null;
  return <p className="aps-notice">{task.historical ? "Historical source review. This invoice is paid in the APEX dataset; the replay preserves it for inspection. Its source outcome is separate from this workspace’s execution status. See Replay evidence for the ledger, bank and statement comparison." : "Follow this case from its original invoice through supporting evidence, business approval, separate payment authorization and reconciliation. Statuses below come from this local replay."}</p>;
}
