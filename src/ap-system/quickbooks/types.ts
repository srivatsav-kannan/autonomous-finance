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
  grossAppliedCents?: number;
  credits?: AppliedCredit[];
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
  recognizedCredit?: RecognizedCredit;
  creditApplication?: CreditApplication;
  holds?: AccountingHold[];
  correction?: AccountingCorrection;
  requiredCorrections?: BankReturnCorrection[];
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
export type RecognizedCredit = CreditExport & {
  kind: "credit";
  approvalId: string;
  sourceRevision: number;
  sourceSnapshotHash: string;
};
export type AppliedCredit = {
  recognition: RecognizedCredit;
  amountCents: number;
};
export type CreditApplication = {
  applicationId: string;
  applicationIds: string[];
  requestKey: string;
  billId: string;
  date: string;
  amountCents: number;
  credits: AppliedCredit[];
};
export type AccountingHold = {
  code: string;
  owner: "controller";
  reason: string;
  relatedIds: string[];
};
export type SyncHold = AccountingHold & {
  state: "held";
  realmId: string;
  caseId: string;
  request: ExportRequest;
  createdAt: number;
  updatedAt: number;
};
export type ExportRequest = {
  caseId: string;
  paymentVersionId?: string;
  creditApplicationId?: string;
  correctionId?: string;
};
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
export type Entity = "Bill" | "BillPayment" | "VendorCredit" | "JournalEntry";
export type LocalLinks = {
  caseId: string;
  billId: string;
  recognitionJournalId: string;
  paymentVersionId: string | null;
  commandId: string | null;
  bankTransactionId: string | null;
  settlementJournalId: string | null;
  creditId: string | null;
  creditApplicationId?: string;
  appliedCreditIds?: string[];
  correctionId?: string;
  restoredCorrectionIds?: string[];
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
/** Server-issued approval for the first external POST; never replaced by a recovery reader. */
export type SubmissionAuthorization = {
  subject: string;
  planHash: string;
  decidedAt: number;
};
export type Operation = Plan & {
  submissionAuthorization?: SubmissionAuthorization;
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

/** Exact already-posted bank return and its approved external replication authority. */
export type BankReturnEvidence = {
  kind: "bank_return";
  caseId: string;
  billId: string;
  supplierId: string;
  recognitionJournalId: string;
  amountCents: number;
  currency: "USD";
  date: string;
  bankAccount: "1000";
  apAccount: "2000";
  original: Settlement;
  originalJournalHash: string;
  returnTransactionId: string;
  returnTransactionRowId: string;
  observationId: string;
  returnJournalId: string;
  returnJournalHash: string;
};
export type CorrectionApproval = {
  correctionId: string;
  proposalHash: string;
  policyHash: string;
  approvedAt: number;
};
export type BankReturnCorrection = BankReturnEvidence & CorrectionApproval;
export type PaymentAllocationEvidence = {
  kind: "payment_allocation";
  caseId: string;
  billId: string;
  supplierId: string;
  amountCents: number;
  settlement: Settlement;
  originalBillCents: number;
  restoredPayables: Array<{
    correction: BankReturnCorrection;
    amountCents: number;
  }>;
};
export type PaymentAllocationCorrection = PaymentAllocationEvidence &
  CorrectionApproval;
export type AccountingCorrection =
  BankReturnCorrection | PaymentAllocationCorrection;
