import type { APCaseDetail } from "../../src/ap-system/contracts";
import { agentTransitionSchema } from "../../src/ap-system/contracts";
import { apLabel, evidenceForCase } from "./apSystemView";
import "./apConnectedProcess.css";

type View = "evidence" | "traceability" | "history";

/** Current source versions and validated persisted model records only. */
export function connectedProcessFacts(detail: APCaseDetail) {
  const sources = detail.sources.filter(source => detail.currentSourceBindings.some(binding =>
    binding.sourceId === source.sourceId && binding.revision === source.revision && binding.sha256 === source.sha256));
  const transitions = detail.timeline.flatMap(event => {
    const parsed = agentTransitionSchema.safeParse(event.agentTransition);
    return parsed.success ? [{ event, transition: parsed.data }] : [];
  }).sort((a,b) => a.event.at - b.event.at);
  const latest = transitions.at(-1);
  return {
    sources,
    parsers: [...new Set(sources.flatMap(source => source.parser ? [source.parser.provider] : []))],
    missingParsers: sources.filter(source => !source.parser).length,
    recordedOperations: new Set(transitions.map(item => item.transition.operationId)).size,
    latestWork: latest ? {...latest.transition.after.work, reason:latest.event.summary, updatedAt:latest.event.at} : null,
    agentEvents: new Set(detail.timeline.filter(event => event.agentTransition || event.kind.startsWith("agent_")).map(event => event.eventId)).size,
    holds: detail.exceptions.filter(exception => exception.blocking && exception.status !== "resolved").length,
  };
}

function recordedTime(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Time unavailable";
}

export function APConnectedProcess({ detail, onView }: { detail: APCaseDetail; onView: (view: View) => void }) {
  const facts = connectedProcessFacts(detail);
  const work = detail.agentProgress ?? facts.latestWork;
  const sourceCount = evidenceForCase(detail).filter(field => field.fieldPath.startsWith("source.")).length;
  const sourceParsed = sourceCount > 0 && facts.sources.length > 0 && facts.sources.every(source => source.pageStatus.every(page => page.status === "complete"));
  const stages = [
    ...(sourceParsed ? [{ label: "PDF parsing", status: "source_values_available", done: true }] : []),
    { label: sourceParsed ? "AP mapping" : "Extraction", status: sourceParsed ? "needs_review" : detail.extraction.status, done: detail.extraction.status === "complete" },
    { label: "Source review", status: detail.states.document, done: detail.states.document === "reviewed" },
    { label: "Bill approval", status: detail.states.business, done: detail.states.business === "approved" },
    { label: "Accounting", status: detail.states.accounting, done: ["recognized", "corrected"].includes(detail.states.accounting) },
    { label: "Payment", status: detail.states.execution, done: detail.states.execution === "settled" },
    { label: "Reconciliation", status: detail.states.reconciliation, done: detail.states.reconciliation === "matched" },
  ];
  return <section className="aps-connected-process" aria-label="Connected case processing">
    <div className="acp-heading"><div><h3>Case processing</h3><p>Original documents, agent work and recorded outcomes for this case.</p></div><div className="acp-connection"><span>{detail.identityMode === "authenticated_human" ? "Auth0 verified" : "Simulated identity"}</span><span>{detail.scope.provider === "increase" ? "Increase sandbox" : "Local FakeBank"}</span></div></div>
    <ol className="acp-stages" aria-label="Persisted case stages">{stages.map(stage => <li key={stage.label} data-complete={stage.done}><span>{stage.label}</span><strong>{apLabel(stage.status)}</strong></li>)}</ol>
    <div className="acp-details">
      <div className="acp-source"><span className="acp-label">Originals & parser</span><strong>{facts.sources.length} current {facts.sources.length === 1 ? "document" : "documents"}</strong><p>{facts.parsers.length ? facts.parsers.join(" / ") : "No parser result recorded"}{facts.missingParsers > 0 && facts.parsers.length > 0 ? ` / ${facts.missingParsers} without parser provenance` : ""}</p><button type="button" className="aps-text-button" onClick={() => onView("evidence")}>Inspect original & fields</button></div>
      <div className="acp-work"><span className="acp-label">Persisted agent work</span><strong>{work ? `${apLabel(work.status)} / ${apLabel(work.stage)}` : "No work record yet"}</strong><p>{work ? `Owner: ${work.owner}` : "No agent execution is recorded for this case."}</p>{work && <><p>{work.reason}</p>{work.requirements.length > 0 && <p className="acp-requirements">Required: {work.requirements.map(apLabel).join("; ")}</p>}<small>Work snapshot updated {recordedTime(work.updatedAt)}</small></>}</div>
      <div className="acp-trace"><span className="acp-label">Traceability</span><strong>{facts.recordedOperations} recorded worker {facts.recordedOperations === 1 ? "operation" : "operations"}</strong><p>Retained before-and-after snapshots show what each operation observed and changed.</p><p>{facts.agentEvents} agent {facts.agentEvents === 1 ? "event" : "events"} / {facts.holds} unresolved blocking {facts.holds === 1 ? "issue" : "issues"}</p><div className="acp-actions"><button type="button" className="aps-text-button" onClick={() => onView("traceability")}>View all diffs</button><button type="button" className="aps-text-button" onClick={() => onView("history")}>Work history</button></div></div>
    </div>
    <p className="aps-caption">Payment authorization: {apLabel(detail.states.authorization)}. Stages show saved backend records; parser completion and agent activity do not grant payment approval.</p>
  </section>;
}
