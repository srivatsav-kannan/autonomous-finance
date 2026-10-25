/** Browser-safe types only. Export values are issued by authenticated backend queries. */
import type { APCaseDetail } from "../contracts";
export type Settlement = {
  paymentVersionId: string;
  commandId: string;
  requestHash: string;
  bankTransactionId: string;
  providerTransferId: string;
  journalId: string;
  amountCents: number;
  date: string;
};
/** Exact immutable B3 recognition, not a rewritten invoice candidate. */
export type RecognizedInvoice = {
  kind: "invoice";
  caseId: string;
  billId: string;
  journalId: string;
  supplierId: string;
  reference: string;
  date: string;
  amountCents: number;
  allocations: Array<{ account: string; amountCents: number }>;
  approvalId: string;
  sourceRevision: number;
  sourceSnapshotHash: string;
  creditId: null;
};
export type AccountingExport = {
  version: "ap-qbo-export-v1";
  exportedAt: number;
  authorizedSubject: string;
  detail: APCaseDetail;
  billRecordHash: string;
  settlement: Settlement | null;
  recognizedInvoice?: RecognizedInvoice;
};
export type CreditExport = {
  creditId: string;
  caseId: string;
  billId: string;
  journalId: string;
  supplierId: string;
  reference: string;
  date: string;
  amountCents: number;
  allocations: Array<{ account: string; amountCents: number }>;
};
export type ExportRequest = { caseId: string; paymentVersionId?: string };
/** Inject a request-bound authenticated backend query, never a browser-supplied export. */
export type ExportLoader = (
  request: ExportRequest,
) => Promise<AccountingExport>;
export type Mappings = {
  version: string;
  realmId: string;
  country: "US";
  vendors: Record<string, { id: string; displayName: string }>;
  accounts: Record<string, { id: string; name: string; type: string }>;
  apAccount: string;
  bankAccount: string;
};
export type Entity = "Bill" | "BillPayment" | "VendorCredit";
export type LocalLinks = {
  caseId: string;
  billId: string;
  recognitionJournalId: string;
  paymentVersionId: string | null;
  commandId: string | null;
  bankTransactionId: string | null;
  settlementJournalId: string | null;
  creditId: string | null;
};
export type Plan = {
  version: "ap-qbo-operation-v1";
  realmId: string;
  minorVersion: 75;
  entity: Entity;
  identity: string;
  links: LocalLinks;
  mappingHash: string;
  payload: Record<string, unknown>;
};
export type Operation = Plan & {
  requestId: string;
  payloadHash: string;
  state:
    "prepared" | "sending" | "unknown" | "succeeded" | "conflict" | "rejected";
  createdAt: number;
  updatedAt: number;
  attempts: number;
  externalId: string | null;
  syncToken: string | null;
  lastError: string | null;
  responseHash: string | null;
};
