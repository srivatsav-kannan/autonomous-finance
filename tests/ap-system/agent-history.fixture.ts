import {
  caseDetailSchema,
  agentTransitionSchema,
} from "../../src/ap-system/contracts";
import legacy from "../../docs/ap-orchestration/evidence/agent-case-v1/agent-case-flow.json";
import saved from "../../docs/ap-orchestration/evidence/agent-transition-v1/case-transitions.json";

export const evidenceRevision = "81dd714f4f8ea49e7795979605c174a6ac954819";
export const historyFixtures = {
  all: "All stored worker operations",
  "missing-receipt": "Missing receipt wait",
  "evidence-revision": "Later evidence revision (already in before)",
  "independent-approval": "Independent approvals (already in before)",
  "payment-proposal": "One payment proposal",
  settled: "Settled history (already in before)",
  legacy: "Legacy stored events without snapshots",
  empty: "Synthetic empty history edge case",
  long: "Synthetic long reason and ID edge case",
} as const;
export type HistoryFixture = keyof typeof historyFixtures;

/** Browser-only composition, never imported by production code. No workflow is run. */
export function historyFixture(mode: HistoryFixture = "all") {
  const detail = caseDetailSchema.parse(legacy.case);
  const indexes: Partial<Record<HistoryFixture, number[]>> = {
    "missing-receipt": [1],
    "evidence-revision": [2, 3],
    "independent-approval": [4, 6, 9],
    "payment-proposal": [8],
    settled: [11, 12],
    long: [1],
  };
  // Same projection as projection.ts in #113. Preserve every saved transition byte/value.
  detail.timeline = saved.events
    .filter((_, i) => !indexes[mode] || indexes[mode]!.includes(i))
    .map((event) => ({
      eventId: event._id,
      at: event.at,
      actor: event.actor,
      kind: `agent_${event.stage}`,
      summary: event.reason,
      references: [
        event.snapshotHash,
        `revision:${event.revision}`,
        event.transition.operationId,
      ],
      agentTransition: agentTransitionSchema.parse(event.transition),
    }));
  // The outer case is context only, composed from stored fixtures; never used to diff events.
  detail.amounts = saved.finalAmounts;
  detail.states = saved.finalStates as typeof detail.states;
  detail.links = saved.finalLinks;
  // The #113 export does not contain a complete PaymentDetail or beneficiary.
  // Do not attach the older run's payment record to these new version IDs.
  detail.payments = [];
  detail.journals = saved.journals.map((j) => ({
    entryId: j.id,
    date: j.date,
    kind: j.source.kind === "bill" ? "recognition" : "settlement",
    lines: j.lines.map((l) => ({
      account: l.account,
      debit: l.debit,
      credit: l.credit,
    })),
    bankTransactionId:
      j.source.kind === "bill"
        ? null
        : (saved.finalLinks.bankTransactionIds[0] ?? null),
  }));
  if (mode === "legacy")
    detail.timeline = caseDetailSchema.parse(legacy.case).timeline;
  if (mode === "empty") {
    detail.timeline = [];
    detail.decisions = [];
  }
  if (mode === "long") {
    detail.timeline[0]!.summary =
      "Synthetic layout stress reason: " + "a-long-unbroken-reason-".repeat(45);
    detail.timeline[0]!.agentTransition!.operationId =
      "synthetic-layout-only-".repeat(40);
    detail.timeline[0]!.actor = "synthetic-actor-".repeat(30);
    detail.timeline[0]!.agentTransition!.before.work.leaseOwner = null;
  }
  return caseDetailSchema.parse(detail);
}
