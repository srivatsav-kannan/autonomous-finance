import { z } from "zod";
import {
  buildIncreaseRequestBody, canonicalJson, commandRequestHash, PAYMENT_EXECUTOR_VERSION,
  type BankCommand, type BankScope, type BankTransaction, type CommandEnvelope,
  type EffectLease, type PaymentExecutionConfig, type PaymentSnapshot, type TransferObservation,
} from "../contracts";

const nonempty = z.string().refine(value => value.trim().length > 0, "Nonempty text required");
const safeInteger = z.number().refine(Number.isSafeInteger, "Safe integer required");
export const positiveCentsSchema = safeInteger.refine(value => value > 0, "Positive USD cents required");
const timestamp = safeInteger.refine(value => value >= 0, "Nonnegative epoch milliseconds required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export const businessDateSchema = z.string().refine(isBusinessDate, "Valid YYYY-MM-DD required");
const instant = z.string().refine(value => isBusinessDate(value.slice(0, 10)) &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), "Valid bank timestamp required");
export const moneySchema = z.object({ currency: z.literal("USD"), cents: positiveCentsSchema }).strict();
export const bankScopeSchema = z.object({
  organizationId: nonempty, runId: nonempty, provider: z.enum(["fake", "increase"]),
  environment: z.enum(["local", "sandbox"]), accountId: nonempty,
}).strict().refine(scope => (scope.provider === "fake") === (scope.environment === "local"), "Provider/environment mismatch");
const destination = z.object({ externalAccountId: nonempty, version: nonempty }).strict();
const credit = z.object({ creditId: nonempty, amountCents: positiveCentsSchema }).strict();
export const paymentExecutionConfigSchema = z.object({
  scope: bankScopeSchema, paymentExecutorVersion: z.literal(PAYMENT_EXECUTOR_VERSION), policyVersion: nonempty,
  beneficiary: z.object({ vendor: nonempty, externalAccountId: nonempty, version: nonempty }).strict(),
  provenance: z.object({ decisionPath: nonempty, knowledgeCommit: nonempty }).strict().optional(),
}).strict();
export const paymentSnapshotSchema = z.object({
  scope: bankScopeSchema,
  bills: z.array(z.object({ billId: nonempty, version: positiveCentsSchema, amountCents: positiveCentsSchema }).strict()).min(1),
  credits: z.array(credit), amountCents: positiveCentsSchema, currency: z.literal("USD"),
  destination, policyVersion: nonempty,
}).strict().superRefine((snapshot, ctx) => {
  if (new Set(snapshot.bills.map(item => item.billId)).size !== snapshot.bills.length ||
      new Set(snapshot.credits.map(item => item.creditId)).size !== snapshot.credits.length) {
    ctx.addIssue({ code: "custom", message: "Distinct bill and credit identities required" });
  }
  let bills = 0, credits = 0;
  for (const item of snapshot.bills) bills += item.amountCents;
  for (const item of snapshot.credits) credits += item.amountCents;
  if (!Number.isSafeInteger(bills) || !Number.isSafeInteger(credits) || bills - credits !== snapshot.amountCents) {
    ctx.addIssue({ code: "custom", message: "Snapshot total must equal safe bill sum minus credits" });
  }
});
export const bankCommandSchema = z.object({
  commandId: nonempty, scope: bankScopeSchema, amountCents: positiveCentsSchema, currency: z.literal("USD"),
  destination, approvalVersion: nonempty, idempotencyKey: nonempty, requestHash: hash,
  providerRequest: z.string().optional(),
}).strict().superRefine((command, ctx) => {
  if (command.scope.provider !== "increase") return;
  try {
    if (!command.providerRequest || canonicalJson(JSON.parse(command.providerRequest)) !==
        canonicalJson(JSON.parse(buildIncreaseRequestBody(command)))) throw new Error("mismatch");
  } catch { ctx.addIssue({ code: "custom", message: "Saved Increase request must match approved command" }); }
});
export const transferObservationSchema = z.object({
  id: nonempty, scope: bankScopeSchema, commandId: nonempty, requestHash: hash,
  idempotencyKey: nonempty, amountCents: positiveCentsSchema, currency: z.literal("USD"), destination,
  status: z.enum(["pending", "settled", "rejected", "returned"]), createdAt: instant, updatedAt: instant,
  pendingTransactionId: nonempty.optional(), originalTransactionId: nonempty.optional(),
  returnTransactionId: nonempty.optional(), rejectionReason: nonempty.optional(),
}).strict().superRefine((observation, ctx) => {
  if ((["settled", "returned"].includes(observation.status) && !observation.originalTransactionId) ||
      (observation.status === "returned" && (!observation.returnTransactionId || observation.returnTransactionId === observation.originalTransactionId)) ||
      (observation.status === "rejected" && (observation.originalTransactionId || observation.returnTransactionId))) {
    ctx.addIssue({ code: "custom", message: "Invalid settlement/return transaction links" });
  }
});
export const bankTransactionSchema = z.object({
  id: nonempty, scope: bankScopeSchema,
  // Unrelated account activity legitimately has no payment/transfer identity.
  transferId: z.string(), commandId: z.string(), amountCents: safeInteger.refine(value => value !== 0),
  // A completed pending hold is not cash evidence; only status=posted can be posted.
  currency: z.literal("USD"), status: z.enum(["pending", "complete", "posted"]), purpose: z.enum(["debit", "return", "other"]),
  sourceCategory: nonempty.optional(), createdAt: instant, postedAt: instant.optional(), completedAt: instant.optional(),
  originalTransactionId: nonempty.optional(),
}).strict().superRefine((transaction, ctx) => {
  if ((transaction.status === "posted" && !transaction.postedAt) ||
      (transaction.status === "complete" && !transaction.completedAt) ||
      (transaction.purpose !== "other" && (!transaction.commandId.trim() || !transaction.transferId.trim())) ||
      (transaction.purpose === "debit" && transaction.amountCents >= 0) ||
      (transaction.purpose === "return" && (transaction.amountCents <= 0 || !transaction.originalTransactionId || transaction.originalTransactionId === transaction.id))) {
    ctx.addIssue({ code: "custom", message: "Invalid posted debit/return evidence" });
  }
});
const paymentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RequestPayment"), billIds: z.array(nonempty).min(1), credits: z.array(credit) }).strict(),
  z.object({ type: z.literal("ApprovePayment"), versionId: nonempty, snapshotHash: hash }).strict(),
  z.object({ type: z.literal("ApproveWithinPolicy"), versionId: nonempty, snapshotHash: hash }).strict(),
  z.object({ type: z.literal("CancelPayment"), versionId: nonempty }).strict(),
  z.object({ type: z.literal("ResumePayment"), commandId: nonempty, reason: nonempty }).strict(),
]);
export const commandEnvelopeSchema = z.object({ commandId: nonempty, command: paymentCommandSchema }).strict().superRefine(({ command }, ctx) => {
  if (command.type === "RequestPayment" && (new Set(command.billIds).size !== command.billIds.length ||
      new Set(command.credits.map(item => item.creditId)).size !== command.credits.length)) {
    ctx.addIssue({ code: "custom", message: "Distinct bill and credit identities required" });
  }
});
export const effectLeaseSchema = z.object({
  commandId: nonempty, generation: positiveCentsSchema, leaseToken: z.string().min(16), command: bankCommandSchema,
  paymentExecutorVersion: z.literal(PAYMENT_EXECUTOR_VERSION), action: z.enum(["submit", "reconcile"]),
  firstAttemptAt: timestamp, leaseExpiresAt: timestamp, providerTransferId: nonempty.optional(),
}).strict().refine(lease => lease.leaseExpiresAt > lease.firstAttemptAt &&
  (lease.action !== "submit" || (lease.generation === 1 && !lease.providerTransferId)), "Invalid first-dispatch lease");

export function parseBankScope(value: unknown): BankScope { return bankScopeSchema.parse(value); }
export function parseBankCommand(value: unknown): BankCommand { return bankCommandSchema.parse(value); }
export function parseTransferObservation(value: unknown): TransferObservation { return transferObservationSchema.parse(value); }
export function parseBankTransaction(value: unknown): BankTransaction { return bankTransactionSchema.parse(value); }
export function parsePaymentSnapshot(value: unknown): PaymentSnapshot { return paymentSnapshotSchema.parse(value); }
export function parsePaymentExecutionConfig(value: unknown): PaymentExecutionConfig { return paymentExecutionConfigSchema.parse(value); }
export function parseCommandEnvelope(value: unknown): CommandEnvelope { return commandEnvelopeSchema.parse(value); }
export function parseEffectLease(value: unknown): EffectLease { return effectLeaseSchema.parse(value); }
/** Parsing validates shape; this additionally verifies the unchanged, existing hash algorithm. */
export async function assertFrozenBankCommand(command: BankCommand): Promise<void> {
  parseBankCommand(command);
  if (await commandRequestHash(command) !== command.requestHash) throw new Error("Immutable bank request hash mismatch");
}
