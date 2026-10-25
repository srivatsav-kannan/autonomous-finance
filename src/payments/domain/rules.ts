import {
  PAYMENT_EXECUTOR_VERSION, canonicalJson, sameBankScope,
  type BankCommand, type BankTransaction, type EffectLease, type ExecutionStatus,
  type PaymentExecutionConfig, type PaymentSnapshot, type TransferObservation, type UnsentProviderCheck,
} from "../contracts";
import type { RailRecoveryCapability, TransferLookup } from "../ports/payment-rail";
import { parseBankCommand, parseBankTransaction, parseEffectLease, parsePaymentSnapshot, parseTransferObservation } from "./validation";

export function safeSumCents(values: readonly number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) throw new Error("Unsafe cumulative USD cents");
    return total + value;
  }, 0);
}
export function assertPaymentExecutor(version: unknown): asserts version is typeof PAYMENT_EXECUTOR_VERSION {
  if (version !== PAYMENT_EXECUTOR_VERSION) throw new Error("Run is not configured for scoped-ap-v2; historical outcomes require review");
}
/** Call inside the authoritative mutation before first dispatch; preserve the original command on reclaim. */
export function assertSnapshotCurrent(config: PaymentExecutionConfig, snapshot: PaymentSnapshot): void {
  assertPaymentExecutor(config.paymentExecutorVersion);
  parsePaymentSnapshot(snapshot);
  if (!sameBankScope(config.scope, snapshot.scope) || config.policyVersion !== snapshot.policyVersion ||
      config.beneficiary.externalAccountId !== snapshot.destination.externalAccountId ||
      config.beneficiary.version !== snapshot.destination.version) throw new Error("Stale policy, beneficiary or bank scope");
}
export function assertCommandMatchesSnapshot(command: BankCommand, snapshot: PaymentSnapshot, versionId: string): void {
  parseBankCommand(command);
  parsePaymentSnapshot(snapshot);
  if (!sameBankScope(command.scope, snapshot.scope) || command.commandId !== versionId || command.approvalVersion !== versionId ||
      command.amountCents !== snapshot.amountCents || command.currency !== snapshot.currency ||
      canonicalJson(command.destination) !== canonicalJson(snapshot.destination)) throw new Error("Command differs from approved snapshot");
}
export function assertCanCancel(attemptCount: number, execution?: ExecutionStatus): void {
  if (!Number.isSafeInteger(attemptCount) || attemptCount !== 0 || (execution !== undefined && execution !== "queued")) {
    throw new Error("Submission may have started; resolve bank outcome before changing payment");
  }
}
export function assertObservationMatchesCommand(command: BankCommand, observation: TransferObservation, context?: {
  providerTransferId?: string; firstAttemptAt?: number; execution: ExecutionStatus;
}): void {
  parseBankCommand(command);
  parseTransferObservation(observation);
  if (!sameBankScope(command.scope, observation.scope) || command.commandId !== observation.commandId ||
      command.requestHash !== observation.requestHash || command.idempotencyKey !== observation.idempotencyKey ||
      command.amountCents !== observation.amountCents || command.currency !== observation.currency ||
      canonicalJson(command.destination) !== canonicalJson(observation.destination)) throw new Error("Bank transfer differs from approved command");
  if (context && (context.firstAttemptAt === undefined || context.execution === "cancelled" ||
      (context.providerTransferId !== undefined && context.providerTransferId !== observation.id))) throw new Error("Transfer does not match a dispatched command");
}

export type OriginalDebitEvidence = { transaction: BankTransaction; entryId: string };
/** A transfer's accepted/settled status alone never permits a journal entry. */
export function assertPostingEvidence(command: BankCommand, observation: TransferObservation, transaction: BankTransaction,
  original?: OriginalDebitEvidence): void {
  assertObservationMatchesCommand(command, observation);
  parseBankTransaction(transaction);
  if (!sameBankScope(command.scope, transaction.scope) || transaction.status !== "posted" || transaction.purpose === "other" ||
      transaction.commandId !== command.commandId || transaction.transferId !== observation.id ||
      transaction.currency !== command.currency || Math.abs(transaction.amountCents) !== command.amountCents) {
    throw new Error("Unverified economic evidence");
  }
  if (transaction.purpose === "debit") {
    if (!["settled", "returned"].includes(observation.status) || observation.originalTransactionId !== transaction.id) {
      throw new Error("Bank settlement evidence missing");
    }
    return;
  }
  if (observation.status !== "returned" || observation.returnTransactionId !== transaction.id ||
      transaction.originalTransactionId !== observation.originalTransactionId || !original?.entryId.trim()) {
    throw new Error("Return requires distinct verified original debit and return");
  }
  const debit = original.transaction;
  if (debit.purpose !== "debit" || debit.id !== transaction.originalTransactionId) throw new Error("Post original debit before the return");
  assertPostingEvidence(command, observation, debit);
}

/** Minimum time between the first attempt and an operator release of a never-accepted command.
 * Increase guarantees at most one object per idempotency key but documents no key retention or
 * read-visibility window, and advises against automating on list reads
 * (https://increase.com/documentation/idempotency-keys). Our own bounds are far shorter: a 15 s
 * request timeout, a 30 s lease and a 24 h automatic recovery budget. Waiting a full day past the
 * first attempt, then re-checking, leaves a late-visible POST every chance to appear first. */
export const RELEASE_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The provider check must be this fresh when the release commits. */
export const RELEASE_CHECK_MAX_AGE_MS = 15 * 60 * 1000;

/** Shared by the operator service (before asking) and the kernel mutation (authoritative). */
export function assertReleasableUnsent(command: { execution: ExecutionStatus; firstAttemptAt?: number; providerTransferId?: string; release?: unknown },
  now: number, check?: UnsentProviderCheck): void {
  if (command.release) throw new Error("Payment was already released");
  if (command.execution !== "exception" || command.providerTransferId) throw new Error("Only an exception command with no accepted provider transfer can be released");
  if (command.firstAttemptAt === undefined || !Number.isSafeInteger(command.firstAttemptAt)) throw new Error("No original dispatch time; use cancel for a never-attempted payment");
  if (now - command.firstAttemptAt < RELEASE_SAFETY_WINDOW_MS) throw new Error("Release safety window has not passed since the first attempt");
  if (!check) return;
  const counts = [check.checkedAt, check.scannedFrom, check.transfersScanned, check.transactionsScanned];
  if (check.lookup !== "not_found" || check.searchedBy !== "operation_key" || check.scanComplete !== true ||
      !counts.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Provider check must be a complete operation-key lookup and account scan");
  if (check.matchingTransferIds.length || check.matchingTransactionIds.length) throw new Error("Provider shows a possible matching transfer; reconcile it instead of releasing");
  if (check.scannedFrom > command.firstAttemptAt || check.checkedAt < command.firstAttemptAt + RELEASE_SAFETY_WINDOW_MS ||
      check.checkedAt > now || now - check.checkedAt > RELEASE_CHECK_MAX_AGE_MS) throw new Error("Provider check is stale or does not cover the attempt window");
}

export type RecoveryDecision =
  | { action: "complete"; observation: TransferObservation }
  | { action: "resend" }
  | { action: "review"; reason: string };
/** Run after lookup, immediately before any same-key resend. Never changes command/key/bytes. */
export function decideRecovery(lease: EffectLease, capability: RailRecoveryCapability, lookup: TransferLookup, now: number): RecoveryDecision {
  parseEffectLease(lease);
  const review = (reason: string): RecoveryDecision => ({ action: "review", reason });
  if (lease.action !== "reconcile") return review("Recovery requires a reconciliation lease");
  if (![now, lease.firstAttemptAt, lease.leaseExpiresAt, lookup.checkedAt].every(value => Number.isSafeInteger(value) && value >= 0) ||
      now < lease.firstAttemptAt || now >= lease.leaseExpiresAt || lookup.checkedAt < lease.firstAttemptAt || lookup.checkedAt > now) {
    return review("Expired lease or invalid recovery timestamps");
  }
  const command = lease.command;
  if (!sameBankScope(command.scope, lookup.scope) || command.commandId !== lookup.commandId ||
      command.idempotencyKey !== lookup.idempotencyKey || command.requestHash !== lookup.requestHash) return review("Lookup does not describe the frozen scoped command");
  if (lookup.kind === "found") {
    assertObservationMatchesCommand(command, lookup.observation, { execution: "in_flight", firstAttemptAt: lease.firstAttemptAt, providerTransferId: lease.providerTransferId });
    return { action: "complete", observation: lookup.observation };
  }
  if (lookup.kind === "unknown") return review(lookup.reason);
  if (lease.providerTransferId) return review("Previously accepted transfer is missing; preserve its identity for review");
  if (capability.lookup !== "operation_key" || lookup.searchedBy !== "operation_key") return review("Scoped operation-key lookup is required before resend");
  const policy = capability.sameKeyResend;
  if (policy.kind === "never") return review(policy.reason);
  if (!policy.documentation.trim()) return review("Provider idempotency guarantee is undocumented");
  if (policy.kind === "retained" && (!Number.isSafeInteger(policy.retentionMs) || policy.retentionMs <= 0 || now - lease.firstAttemptAt >= policy.retentionMs)) {
    return review("Provider idempotency retention expired or is invalid");
  }
  return { action: "resend" };
}
