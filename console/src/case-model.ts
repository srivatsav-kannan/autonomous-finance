import type { Doc } from "../../convex/_generated/dataModel";

export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export const person = (id: string) => id.split(/[-_]/).map((part) => /^(cfo|ap|ar|hr)$/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");

/** Join by recorded identities only; matching a vendor name is not case provenance. */
export function caseRecords(ask: Doc<"asks">, bills: Doc<"bills">[], payments: Doc<"paymentIntents">[]) {
  const refs = new Set(ask.evidence.map((e) => e.ref));
  const directPayment = payments.find((p) => p._id === ask.paymentIntentId);
  const relatedBills = bills.filter((b) => refs.has(b._id) || (b.decisionPath && refs.has(b.decisionPath)) || refs.has(b.documentEventId) || directPayment?.billIds.includes(b._id));
  const relatedPayments = payments.filter((p) => p._id === ask.paymentIntentId || relatedBills.some((b) => p.billIds.includes(b._id)));
  return { bills: relatedBills, payments: relatedPayments };
}
export type CaseRecords = ReturnType<typeof caseRecords>;
