import type { APCaseDetail } from "./contracts";

export const AP_AGENT_VERSION = "ap-case-agent-v1";
export type APAgentRole = "ap_clerk" | "payments";
export type APAgentPlan = {
  stage: string;
  role: APAgentRole;
  owner: string;
  reason: string;
  requirements: string[];
  action: "wait" | "prepare_payment" | "complete";
};
/** Deterministic policy reads backend facts. Source text is evidence, never an instruction. */
export function planAPCase(d: APCaseDetail): APAgentPlan {
  const plan = (
    stage: string,
    owner: string,
    reason: string,
    requirements: string[] = [],
    action: APAgentPlan["action"] = "wait",
    role: APAgentRole = "ap_clerk",
  ): APAgentPlan => ({ stage, owner, reason, requirements, action, role });
  const active = d.payments.filter(
    (p) => !["cancelled", "settled", "returned", "rejected"].includes(p.status),
  );
  if (["returned", "rejected", "exception"].includes(d.states.execution))
    return plan(
      "operator_resolution",
      "controller",
      "Payment outcome requires controlled review; never automatically repay.",
      ["payment_outcome_review"],
    );
  if (
    active.length ||
    ["queued", "in_flight", "pending", "unknown"].includes(d.states.execution)
  ) {
    if (d.states.authorization === "awaiting_approval")
      return plan(
        "payment_authorization",
        "human_payment_authorizer",
        "Exact payment proposal awaits independent human authorization.",
        ["independent_payment_authorization"],
      );
    return plan(
      "bank_settlement",
      "payment_evidence_worker",
      "Observe the original authorized command until bank evidence is posted and matched.",
      ["verified_bank_debit", "settlement_journal"],
    );
  }
  if (
    d.states.business === "approved" &&
    d.states.execution === "settled" &&
    d.states.reconciliation === "matched" &&
    d.amounts.outstandingCents === 0 &&
    d.links.settlementJournalIds.length
  )
    return plan(
      "reconciled",
      "accountant",
      "Verified bank settlement and local accounting match; no outstanding payable.",
      [],
      "complete",
    );
  if (d.payments.length)
    return plan(
      "operator_resolution",
      "controller",
      "Prior payment history requires an explicit next allocation or correction; automatic replacement is disabled.",
      ["payment_allocation_or_correction"],
    );
  if (d.states.business === "rejected")
    return plan(
      "bill_rejected",
      "business_reviewer",
      "Bill rejection is retained; corrected evidence and a new review are required.",
      ["authorized_bill_resolution"],
    );
  const holds = d.exceptions.filter(
    (e) =>
      e.blocking &&
      e.status !== "resolved" &&
      // These are later workflow gates, not missing source evidence. The
      // field-review and bill-approval branches below keep their authority intact.
      !["geometry_review_required", "business_plan_required", "business_approval_pending"].includes(e.code),
  );
  if (holds.length)
    return plan(
      "missing_evidence",
      [...new Set(holds.map((e) => e.ownerRole))].join(", "),
      holds.map((e) => e.code).join(", "),
      [...new Set(holds.flatMap((e) => e.requiredEvidence))],
    );
  if (d.states.document !== "reviewed")
    return plan(
      "field_review",
      "human_field_reviewer",
      "Current original fields require the existing independent review.",
      ["current_source_field_review"],
    );
  if (
    d.states.business !== "approved" ||
    d.states.accounting !== "recognized" ||
    !d.links.billId
  )
    return plan(
      "bill_approval",
      "human_business_reviewer",
      "Current bill and coding require the configured approval route before recognition.",
      ["current_bill_approval"],
    );
  if (
    d.candidate?.kind !== "invoice" ||
    !d.amounts.outstandingCents ||
    d.amounts.outstandingCents < 0
  )
    return plan(
      "operator_resolution",
      "controller",
      "Unsupported or zero-cash treatment requires an explicit accounting disposition.",
      ["accounting_disposition"],
    );
  return plan(
    "prepare_payment",
    "payments",
    "Prepare one proposal for the current approved outstanding amount; no bank execution.",
    [],
    "prepare_payment",
    "payments",
  );
}
/** Excludes timeline/worker bookkeeping so polling cannot manufacture progress. */
export function apCaseProgress(d: APCaseDetail) {
  return {
    revision: d.revision,
    snapshotHash: d.snapshotHash,
    policyVersion: d.policyVersion,
    states: d.states,
    amounts: d.amounts,
    links: d.links,
    payments: d.payments,
    decisions: d.decisions.map((x) => ({
      id: x.decisionId,
      outcome: x.outcome,
    })),
    exceptions: d.exceptions.map((x) => ({
      id: x.exceptionId,
      code: x.code,
      status: x.status,
      blocking: x.blocking,
      required: x.requiredEvidence,
    })),
  };
}
