import type {
  APAgentTransition,
  APCaseDetail,
} from "../../src/ap-system/contracts";
import { apLabel } from "./apSystemView";

type Snapshot = APAgentTransition["before"];
export type HistoryRow = {
  label: string;
  before: string;
  after: string;
  changed: boolean;
};

/** Do not use a current candidate's currency to label a historical snapshot. */
export function recordedCents(value: number | null | undefined): string {
  if (value === null) return "Unknown (recorded null)";
  if (value === undefined) return "Not recorded";
  if (!Number.isSafeInteger(value) || value < 0)
    return "Invalid recorded amount";
  const cents = BigInt(value);
  return `${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")} (${cents.toLocaleString("en-US")} cents)`;
}

export function snapshotRows(transition: APAgentTransition): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const add = <T>(
    label: string,
    get: (s: Snapshot) => T,
    format: (v: T) => string = String,
  ) => {
    const before = get(transition.before),
      after = get(transition.after);
    rows.push({
      label,
      before: format(before),
      after: format(after),
      changed: JSON.stringify(before) !== JSON.stringify(after),
    });
  };
  const states = {
    document: "Document review",
    business: "Bill decision",
    accounting: "Accounting",
    authorization: "Payment authorization",
    execution: "Bank execution",
    reconciliation: "Reconciliation",
  };
  for (const [key, label] of Object.entries(states))
    add(label, (s) => s.case.states[key as keyof typeof states], apLabel);
  const amounts = {
    invoicedCents: "Invoiced",
    acceptedCents: "Accepted",
    disputedCents: "Disputed",
    creditedCents: "Credited",
    instructedCents: "Instructed",
    settledCents: "Settled",
    outstandingCents: "Outstanding",
  };
  for (const [key, label] of Object.entries(amounts))
    add(
      label,
      (s) => s.case.amounts[key as keyof typeof amounts],
      recordedCents,
    );
  add("Worker status", (s) => s.work.status, apLabel);
  add("Stage / wait context", (s) => s.work.stage, apLabel);
  add("Owner", (s) => s.work.owner);
  add("Worker role", (s) => s.work.role, apLabel);
  add(
    "Required next action / evidence",
    (s) => [...s.work.requirements].sort(),
    (v) => (v.length ? v.map(apLabel).join("; ") : "None recorded"),
  );
  add("Case revision", (s) => s.case.revision);
  add("Policy version", (s) => s.case.policyVersion);
  add(
    "Source revisions",
    (s) =>
      [...s.case.sourceBindings].sort(
        (a, b) =>
          a.sourceId.localeCompare(b.sourceId) ||
          a.revision - b.revision ||
          a.sha256.localeCompare(b.sha256),
      ),
    (v) =>
      v.length
        ? v
            .map(
              (s: Snapshot["case"]["sourceBindings"][number]) =>
                `${s.sourceId} / Revision ${s.revision}\nSHA-256 ${s.sha256}`,
            )
            .join("\n\n")
        : "None recorded",
  );
  add("Evidence snapshot hash", (s) => s.case.snapshotHash);
  return rows;
}

export type HistoryReference = {
  kind: string;
  id: string;
  before: boolean;
  after: boolean;
};
export function snapshotReferences(
  transition: APAgentTransition,
): HistoryReference[] {
  const references = new Map<string, HistoryReference>();
  const fields = {
    billId: "Bill",
    paymentVersionIds: "Payment",
    commandIds: "Command",
    providerTransferIds: "Provider transfer",
    bankTransactionIds: "Bank transaction",
    journalIds: "Journal",
    decisionIds: "Decision",
  } as const;
  for (const side of ["before", "after"] as const)
    for (const [field, kind] of Object.entries(fields)) {
      const value = transition[side].case[field as keyof typeof fields];
      for (const id of typeof value === "string" ? [value] : (value ?? [])) {
        const key = `${kind}:${id}`;
        const ref = references.get(key) ?? {
          kind,
          id,
          before: false,
          after: false,
        };
        ref[side] = true;
        references.set(key, ref);
      }
    }
  return [...references.values()];
}

export const decisionAnchor = (id: string) =>
  `ap-history-decision-${encodeURIComponent(id)}`;

/** Only offer a destination when this scoped case response contains the record. */
export function referenceTarget(
  ref: Pick<HistoryReference, "kind" | "id">,
  detail: APCaseDetail,
): "accounting" | "decision" | undefined {
  if (
    ref.kind === "Decision" &&
    detail.decisions.some((d) => d.decisionId === ref.id)
  )
    return "decision";
  if (
    (ref.kind === "Bill" && detail.links.billId === ref.id) ||
    (ref.kind === "Payment" &&
      detail.payments.some((p) => p.versionId === ref.id)) ||
    (ref.kind === "Journal" &&
      detail.journals.some((j) => j.entryId === ref.id))
  )
    return "accounting";
  return undefined;
}
