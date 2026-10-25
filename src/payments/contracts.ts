/** Compatibility types: the bank command, its hash and saved request bytes stay authoritative. */
export type {
  BankScope, BankDestination, BankCommand, TransferObservation, BankTransaction,
  BankBalance, BankPage, BankPagination, BankItemFailure, BankEvent, BankErrorClass, BankingProvider, BankingEvents,
} from "../integrations/contracts";
export {
  canonicalJson, canonicalCommand, commandRequestHash, sameBankScope, buildIncreaseRequestBody,
  BankProviderError, BankResourceOutsideScope,
} from "../integrations/contracts";
import type { BankCommand, BankDestination, BankErrorClass, BankScope } from "../integrations/contracts";

export const PAYMENT_EXECUTOR_VERSION = "scoped-ap-v2" as const;
export type PaymentExecutorVersion = typeof PAYMENT_EXECUTOR_VERSION;
export type PaymentId = string; // demoVersions._id == BankCommand.commandId
export type EffectId = string; // demoCommands._id; never the provider idempotency key
export type Version = string;
export type Money = { readonly currency: "USD"; readonly cents: number };
export type EvidenceRef = { readonly decisionPath: string; readonly knowledgeCommit: string };
export type CreditAllocation = { creditId: string; amountCents: number };

export type PaymentSnapshot = {
  scope: BankScope;
  bills: { billId: string; version: number; amountCents: number }[];
  credits: CreditAllocation[];
  amountCents: number;
  currency: "USD";
  destination: BankDestination;
  policyVersion: Version;
  /** Intended first initiation date. UTC calendar date; does not promise settlement. */
  schedule?: { executionDate: string; timeZone: "UTC" };
};
/** Read from immutable per-run config, never from an untrusted command or Git at dispatch. */
export type PaymentExecutionConfig = {
  scope: BankScope;
  paymentExecutorVersion: PaymentExecutorVersion;
  policyVersion: Version;
  beneficiary: { vendor: string; externalAccountId: string; version: Version };
  provenance?: EvidenceRef;
};
export type PaymentStatus = "awaiting_approval" | "queued" | "cancelled" | "settled" | "rejected" | "returned";
export type ExecutionStatus = "queued" | "in_flight" | "pending" | "unknown" | "settled" | "rejected" | "returned" | "cancelled" | "exception";
export type PostingStatus = "unposted" | "posted" | "returned";
export type ReconciliationStatus = "unmatched" | "matched";
export type PaymentApproval = {
  seatId: string;
  /** Authenticated issuer|subject for humans; backend derives it, never a client assertion. */
  subject: string;
  kind: "human" | "controller";
  snapshotHash: string;
  at: number;
};

export type RequestPayment = { type: "RequestPayment"; billIds: string[]; credits: CreditAllocation[]; billAmounts?: { billId: string; amountCents: number }[]; executionDate?: string };
export type ApprovePayment = { type: "ApprovePayment"; versionId: PaymentId; snapshotHash: string };
export type ApproveWithinPolicy = { type: "ApproveWithinPolicy"; versionId: PaymentId; snapshotHash: string };
export type CancelPayment = { type: "CancelPayment"; versionId: PaymentId };
export type ResumePayment = { type: "ResumePayment"; commandId: EffectId; reason: string };
/** Provider evidence that an attempted command never reached the bank, gathered just before release. */
export type UnsentProviderCheck = {
  lookup: "not_found"; searchedBy: "operation_key"; checkedAt: number;
  scanComplete: true; scannedFrom: number; transfersScanned: number; transactionsScanned: number;
  matchingTransferIds: string[]; matchingTransactionIds: string[];
};
export type ReleaseUnsentPayment = { type: "ReleaseUnsentPayment"; commandId: EffectId; reason: string; providerCheck: UnsentProviderCheck };
export type PaymentCommand = RequestPayment | ApprovePayment | ApproveWithinPolicy | CancelPayment | ResumePayment | ReleaseUnsentPayment;
/** RequestPayment.commandId maps to requestKey. For other commands it is correlation only:
 * their current backend replay/staleness semantics remain authoritative (no generic receipt ledger). */
export type CommandEnvelope<C extends PaymentCommand = PaymentCommand> = {
  commandId: string;
  command: C;
};
export type PaymentRequestResult = { versionId: PaymentId; snapshotHash: string };

export type LeaseProof = { commandId: EffectId; generation: number; leaseToken: string };
export type EffectLease = LeaseProof & {
  command: BankCommand;
  paymentExecutorVersion: PaymentExecutorVersion;
  action: "submit" | "reconcile";
  /** Original attempt time, NOT the current lease time or resettable budget start. */
  firstAttemptAt: number;
  leaseExpiresAt: number;
  providerTransferId?: string;
};
export type DispatchFailure = {
  errorClass: BankErrorClass;
  error: string;
  retryAfterMs?: number;
};
