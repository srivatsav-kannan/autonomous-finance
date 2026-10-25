import { useId } from "react";
import type {
  APAgentTransition,
  APCaseDetail,
} from "../../src/ap-system/contracts";
import { apLabel } from "./apSystemView";
import {
  decisionAnchor,
  referenceTarget,
  snapshotReferences,
  snapshotRows,
  type HistoryRow,
} from "./apAgentHistoryView";
import "./apAgentHistory.css";

type Event = APCaseDetail["timeline"][number];
function EventTime({ at }: { at: number }) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <span>{at === Number.MAX_SAFE_INTEGER ? "Not scheduled" : "Time unavailable"}</span>;
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "long",
      })}
    </time>
  );
}
function Comparison({
  rows,
  caption,
}: {
  rows: HistoryRow[];
  caption: string;
}) {
  return (
    <table className="aph-comparison">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Recorded field</th>
          <th scope="col">Before operation</th>
          <th scope="col">After operation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td data-label="Before operation">{row.before}</td>
            <td data-label="After operation">{row.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function RecordedReferences({
  transition,
  detail,
  onOpenAccounting,
}: {
  transition: APAgentTransition;
  detail: APCaseDetail;
  onOpenAccounting?: () => void;
}) {
  const refs = snapshotReferences(transition);
  return (
    <details className="aph-secondary">
      <summary>Recorded references ({refs.length})</summary>
      <p className="aps-caption">
        <a href="#ap-case-heading">Case summary</a> <code>{detail.caseId}</code>
        . Links open records available in this case now; their current state may
        differ from these snapshots.
      </p>
      {refs.length ? (
        <ul className="aph-references">
          {refs.map((ref) => {
            const target = referenceTarget(ref, detail);
            return (
              <li key={`${ref.kind}:${ref.id}`}>
                <strong>{ref.kind}</strong>
                <code>{ref.id}</code>
                <span>
                  {ref.before && ref.after
                    ? "Before and after"
                    : ref.before
                      ? "Before only"
                      : "After only"}
                </span>
                {target === "decision" ? (
                  <a href={`#${decisionAnchor(ref.id)}`}>
                    View recorded decision
                  </a>
                ) : target === "accounting" && onOpenAccounting ? (
                  <button
                    type="button"
                    className="aps-text-button"
                    onClick={onOpenAccounting}
                  >
                    View {ref.kind.toLowerCase()} in Accounting
                  </button>
                ) : (
                  <small>Reference only; no linked record view available</small>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="aps-caption">
          No linked records were saved in these snapshots.
        </p>
      )}
    </details>
  );
}
function Operation({
  event,
  detail,
  onOpenAccounting,
}: {
  event: Event;
  detail: APCaseDetail;
  onOpenAccounting?: () => void;
}) {
  const transition = event.agentTransition!;
  const id = useId();
  const rows = snapshotRows(transition),
    changed = rows.filter((row) => row.changed),
    unchanged = rows.filter((row) => !row.changed);
  const before = transition.before.case.states;
  return (
    <details className="aph-operation">
      <summary aria-describedby={id}>
        <span className="aph-summary">
          <strong>
            {apLabel(transition.action)}: {apLabel(transition.after.work.stage)}
          </strong>
          <span className="aph-outcome">{apLabel(transition.outcome)}</span>
          <EventTime at={event.at} />
          <span className="aph-summary-reason">{event.summary}</span>
          <span className="aph-summary-meta">
            Saved actor: {event.actor || "Not recorded"} / {changed.length}{" "}
            changed {changed.length === 1 ? "field" : "fields"}
          </span>
        </span>
      </summary>
      <div className="aph-operation-body">
        <p id={id} className="aph-scope">
          Recorded before and after one worker operation. Approval, evidence
          updates or bank settlement may have happened between operations; these
          snapshots do not attribute those changes to this actor.
        </p>
        <p className="aph-observed">
          <strong>Already observed before this operation:</strong> bill{" "}
          {apLabel(before.business).toLowerCase()}, payment authorization{" "}
          {apLabel(before.authorization).toLowerCase()}, bank execution{" "}
          {apLabel(before.execution).toLowerCase()}.
        </p>
        <p className="aps-caption">
          Amounts show exact cents with a decimal equivalent. Currency is not
          recorded in these snapshots. Unknown (recorded null) is distinct from
          zero.
        </p>
        {changed.length ? (
          <Comparison rows={changed} caption="Changes during this operation" />
        ) : (
          <p className="aph-observed">
            No business or work fields below changed during this operation.
            Lease changes are in operation details.
          </p>
        )}
        <details className="aph-secondary">
          <summary>Unchanged recorded fields ({unchanged.length})</summary>
          <Comparison
            rows={unchanged}
            caption="Same value before and after this operation"
          />
        </details>
        <RecordedReferences
          transition={transition}
          detail={detail}
          onOpenAccounting={onOpenAccounting}
        />
        <details className="aph-secondary">
          <summary>Operation details and lease identifiers</summary>
          <dl className="aps-record">
            <div>
              <dt>Evidence version</dt>
              <dd>{transition.version}</dd>
            </div>
            <div>
              <dt>Operation ID</dt>
              <dd>
                <code>{transition.operationId}</code>
              </dd>
            </div>
            <div>
              <dt>Event ID / kind</dt>
              <dd>
                <code>{event.eventId}</code>
                {event.kind}
              </dd>
            </div>
            <div>
              <dt>Saved actor</dt>
              <dd>{event.actor || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Model / verified human identity</dt>
              <dd>Not recorded in this event</dd>
            </div>
            {(["before", "after"] as const).map((side) => (
              <div key={side}>
                <dt>{apLabel(side)} lease</dt>
                <dd>
                  Owner:{" "}
                  {transition[side].work.leaseOwner ?? "None (recorded null)"}
                  <br />
                  Generation: {transition[side].work.generation}
                  <br />
                  Worker version: {transition[side].work.version}
                  <br />
                  Lease expires:{" "}
                  {transition[side].work.leaseUntil === null ? (
                    "None (recorded null)"
                  ) : (
                    <EventTime at={transition[side].work.leaseUntil} />
                  )}
                  <br />
                  Waiting since:{" "}
                  {transition[side].work.waitSince === null ? (
                    "None (recorded null)"
                  ) : (
                    <EventTime at={transition[side].work.waitSince} />
                  )}
                  <br />
                  Next check:{" "}
                  <EventTime at={transition[side].work.nextCheckAt} />
                  <br />
                  Deadline:{" "}
                  {transition[side].work.deadlineAt === null ? (
                    "None (recorded null)"
                  ) : (
                    <EventTime at={transition[side].work.deadlineAt} />
                  )}
                  <br />
                  Attempts: {transition[side].work.attempts}; transitions:{" "}
                  {transition[side].work.transitions}
                </dd>
              </div>
            ))}
            <div>
              <dt>Event references</dt>
              <dd>
                {event.references.length
                  ? event.references.map((ref, i) => <code key={i}>{ref}</code>)
                  : "None recorded"}
              </dd>
            </div>
          </dl>
        </details>
      </div>
    </details>
  );
}

export function APAgentTimeline({
  detail,
  onOpenAccounting,
}: {
  detail: APCaseDetail;
  onOpenAccounting?: () => void;
}) {
  return (
    <div className="aph-history">
      <h4>Audit timeline</h4>
      <p className="aps-caption">
        Saved events in chronological order. Worker snapshots are retained
        observations, not a complete audit of denied requests. Actor identifiers
        do not establish model selection or verified human identity.
      </p>
      {detail.timeline.length ? (
        <ol className="aps-timeline">
          {detail.timeline.map((event) => (
            <li key={event.eventId}>
              {event.agentTransition ? (
                <Operation
                  event={event}
                  detail={detail}
                  onOpenAccounting={onOpenAccounting}
                />
              ) : (
                <>
                  <div className="aps-section-heading">
                    <strong>{apLabel(event.kind)}</strong>
                    <EventTime at={event.at} />
                  </div>
                  <p>{event.summary}</p>
                  <small>Saved actor: {event.actor || "Not recorded"}</small>
                  <p className="aps-caption">
                    {event.kind.startsWith("agent_")
                      ? "Legacy worker event. "
                      : "Event only. "}
                    Before/after snapshots were not recorded.
                  </p>
                  {event.references.length > 0 && (
                    <details className="aph-secondary">
                      <summary>Recorded event references</summary>
                      {event.references.map((ref, i) => (
                        <code key={i}>{ref}</code>
                      ))}
                      <p className="aps-caption">
                        Reference identifiers only; no historical state is
                        inferred.
                      </p>
                    </details>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="aph-empty">No historical events are available.</p>
      )}
    </div>
  );
}
