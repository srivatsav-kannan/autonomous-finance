import { describe, expect, it } from "vitest";
import {
  PAYMENT_EXECUTOR_VERSION, buildIncreaseRequestBody, commandRequestHash,
  type BankCommand, type BankScope, type BankTransaction, type EffectLease,
  type PaymentExecutionConfig, type PaymentSnapshot, type TransferObservation,
} from "../../src/payments/contracts";
import {
  assertFrozenBankCommand, businessDateSchema, moneySchema, parseBankCommand,
  parseBankScope, parseBankTransaction, parseCommandEnvelope, parseEffectLease,
  parsePaymentSnapshot, parseTransferObservation,
} from "../../src/payments/domain/validation";
import {
  assertCanCancel, assertCommandMatchesSnapshot, assertObservationMatchesCommand,
  assertPaymentExecutor, assertPostingEvidence, assertSnapshotCurrent, decideRecovery, safeSumCents,
} from "../../src/payments/domain/rules";
import type { RailRecoveryCapability, TransferLookup } from "../../src/payments/ports/payment-rail";

const scope: BankScope = { organizationId: "org", runId: "run", provider: "fake", environment: "local", accountId: "account" };
const snapshot: PaymentSnapshot = {
  scope, bills: [{ billId: "bill", version: 2, amountCents: 12_000 }],
  credits: [{ creditId: "credit", amountCents: 2_000 }], amountCents: 10_000,
  currency: "USD", destination: { externalAccountId: "beneficiary", version: "beneficiary-v1" }, policyVersion: "policy-v1",
};
const config: PaymentExecutionConfig = {
  scope, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, policyVersion: "policy-v1",
  beneficiary: { vendor: "vendor", ...snapshot.destination },
};
const command: BankCommand = {
  scope, commandId: "version", approvalVersion: "version", idempotencyKey: "demo:version",
  requestHash: "a".repeat(64), amountCents: snapshot.amountCents, currency: "USD", destination: snapshot.destination,
};
const observation: TransferObservation = {
  scope, id: "transfer", commandId: command.commandId, idempotencyKey: command.idempotencyKey,
  requestHash: command.requestHash, amountCents: command.amountCents, currency: "USD", destination: command.destination,
  status: "settled", originalTransactionId: "debit", createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:01:00.000Z",
};
const debit: BankTransaction = {
  scope, id: "debit", transferId: observation.id, commandId: command.commandId, amountCents: -10_000,
  currency: "USD", status: "posted", purpose: "debit", createdAt: observation.createdAt, postedAt: observation.updatedAt,
};
const returned: TransferObservation = { ...observation, status: "returned", returnTransactionId: "return" };
const returnTransaction: BankTransaction = { ...debit, id: "return", purpose: "return", amountCents: 10_000, originalTransactionId: debit.id };
const lease: EffectLease = {
  commandId: "effect-row", generation: 2, leaseToken: "unique-worker-lease-token", command,
  paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, action: "reconcile", firstAttemptAt: 1_000, leaseExpiresAt: 20_000,
};
const absent: TransferLookup = {
  scope, commandId: command.commandId, idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
  checkedAt: 5_000, kind: "not_found", searchedBy: "operation_key",
};
const durable: RailRecoveryCapability = { lookup: "operation_key", sameKeyResend: { kind: "durable", documentation: "fixture:retained-sqlite-database" } };

describe("runtime contract validation", () => {
  it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])("rejects invalid cents %s", cents => {
    expect(() => moneySchema.parse({ currency: "USD", cents })).toThrow();
  });
  it("keeps integer arithmetic exact and rejects cumulative overflow", () => {
    expect(safeSumCents([10_000, -2_000])).toBe(8_000);
    expect(() => safeSumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => safeSumCents([0.1, 0.9])).toThrow();
    expect(() => parsePaymentSnapshot({ ...snapshot, bills: [
      { billId: "a", version: 1, amountCents: Number.MAX_SAFE_INTEGER },
      { billId: "b", version: 1, amountCents: 1 },
    ] })).toThrow();
  });
  it.each(["2025-02-29", "2026-02-30", "2026-13-01", "2026-2-01", "2026-10-23T00:00:00Z"])("rejects invalid business date %s", date => {
    expect(() => businessDateSchema.parse(date)).toThrow();
  });
  it("accepts real leap days and safe USD amounts", () => {
    expect(businessDateSchema.parse("2024-02-29")).toBe("2024-02-29");
    expect(moneySchema.parse({ currency: "USD", cents: Number.MAX_SAFE_INTEGER }).cents).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("validates the whole scope, paired provider/environment, and unknown fields", () => {
    expect(parseBankScope(scope)).toEqual(scope);
    expect(() => parseBankScope({ ...scope, accountId: " " })).toThrow();
    expect(() => parseBankScope({ ...scope, provider: "increase" })).toThrow();
    expect(() => parseBankScope({ ...scope, secret: "not-a-domain-field" })).toThrow();
  });
  it("requires distinct request bill/credit identities and forbids claimed actor identity", () => {
    const request = { commandId: "request-key", command: { type: "RequestPayment", billIds: ["bill"], credits: [] } };
    expect(parseCommandEnvelope(request)).toEqual(request);
    expect(() => parseCommandEnvelope({ ...request, command: { ...request.command, billIds: ["bill", "bill"] } })).toThrow();
    expect(() => parseCommandEnvelope({ ...request, command: { ...request.command, credits: [snapshot.credits[0], snapshot.credits[0]] } })).toThrow();
    expect(() => parseCommandEnvelope({ ...request, subject: "human|spoofed" })).toThrow();
  });
  it("checks snapshot arithmetic and duplicate identities", () => {
    expect(parsePaymentSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parsePaymentSnapshot({ ...snapshot, amountCents: 12_000 })).toThrow();
    expect(() => parsePaymentSnapshot({ ...snapshot, bills: [snapshot.bills[0], snapshot.bills[0]] })).toThrow();
  });
  it("preserves exact Increase bytes, including whitespace, and verifies their original hash", async () => {
    const increasing = { ...command, scope: { ...scope, provider: "increase" as const, environment: "sandbox" as const } };
    const providerRequest = ` ${buildIncreaseRequestBody(increasing)}\n`;
    const saved = { ...increasing, providerRequest };
    saved.requestHash = await commandRequestHash(saved);
    expect(parseBankCommand(saved).providerRequest).toBe(providerRequest);
    await expect(assertFrozenBankCommand(saved)).resolves.toBeUndefined();
    await expect(assertFrozenBankCommand({ ...saved, providerRequest: providerRequest.trim() })).rejects.toThrow("hash mismatch");
    expect(() => parseBankCommand({ ...saved, providerRequest: undefined })).toThrow();
    expect(() => parseBankCommand({ ...saved, providerRequest: providerRequest.replace('"amount":10000', '"amount":10001') })).toThrow();
  });
  it("only permits first-generation fresh leases to claim submit", () => {
    expect(parseEffectLease(lease)).toEqual(lease);
    expect(() => parseEffectLease({ ...lease, action: "submit" })).toThrow();
    expect(() => parseEffectLease({ ...lease, generation: 1, action: "submit", providerTransferId: "accepted" })).toThrow();
    expect(() => parseEffectLease({ ...lease, generation: 1, action: "submit" })).not.toThrow();
  });
});

describe("execution authority", () => {
  it("rejects unconfigured historical executors", () => {
    expect(() => assertPaymentExecutor(undefined)).toThrow();
    expect(() => assertPaymentExecutor("legacy")).toThrow();
    expect(() => assertPaymentExecutor(PAYMENT_EXECUTOR_VERSION)).not.toThrow();
  });
  it("requires unchanged policy and beneficiary before first dispatch", () => {
    expect(() => assertSnapshotCurrent(config, snapshot)).not.toThrow();
    expect(() => assertSnapshotCurrent({ ...config, policyVersion: "policy-v2" }, snapshot)).toThrow();
    expect(() => assertSnapshotCurrent({ ...config, beneficiary: { ...config.beneficiary, version: "beneficiary-v2" } }, snapshot)).toThrow();
    expect(() => assertSnapshotCurrent({ ...config, beneficiary: { ...config.beneficiary, externalAccountId: "new-destination" } }, snapshot)).toThrow();
    expect(() => assertCommandMatchesSnapshot(command, snapshot, "version")).not.toThrow();
    expect(() => assertCommandMatchesSnapshot(command, snapshot, "effect-row")).toThrow();
  });
  it("cannot cancel after any possible attempt or ambiguous execution", () => {
    expect(() => assertCanCancel(0, "queued")).not.toThrow();
    expect(() => assertCanCancel(1, "queued")).toThrow();
    expect(() => assertCanCancel(0, "unknown")).toThrow();
    expect(() => assertCanCancel(-1)).toThrow();
  });
});

describe("recovery before resend", () => {
  it("allows a retained durable operation key only after scoped absence", () => {
    expect(decideRecovery(lease, durable, absent, 5_000)).toEqual({ action: "resend" });
    expect(decideRecovery(lease, { ...durable, lookup: "transfer_id_only" }, absent, 5_000).action).toBe("review");
    expect(decideRecovery(lease, durable, { ...absent, searchedBy: "transfer_id" }, 5_000).action).toBe("review");
  });
  it("never resends on ambiguous lookup or an absent previously accepted transfer", () => {
    expect(decideRecovery(lease, durable, { ...absent, kind: "unknown", reason: "transport failed" }, 5_000).action).toBe("review");
    expect(decideRecovery({ ...lease, providerTransferId: "accepted" }, durable, absent, 5_000).action).toBe("review");
    expect(decideRecovery(lease, { ...durable, sameKeyResend: { kind: "never", reason: "unknown retention" } }, absent, 5_000).action).toBe("review");
  });
  it("expires retention at the original attempt boundary without resetting on a new generation", () => {
    const retained: RailRecoveryCapability = { lookup: "operation_key", sameKeyResend: { kind: "retained", retentionMs: 4_000, documentation: "fixture:guarantee" } };
    expect(decideRecovery(lease, retained, { ...absent, checkedAt: 4_999 }, 4_999).action).toBe("resend");
    expect(decideRecovery({ ...lease, generation: 100 }, retained, absent, 5_000).action).toBe("review");
    expect(decideRecovery(lease, { ...durable, sameKeyResend: { kind: "retained", retentionMs: Infinity, documentation: "fixture" } }, absent, 5_000).action).toBe("review");
    expect(decideRecovery(lease, { ...durable, sameKeyResend: { kind: "durable", documentation: " " } }, absent, 5_000).action).toBe("review");
  });
  it("rejects expired leases, future lookups, and changed operation identity", () => {
    expect(decideRecovery(lease, durable, absent, lease.leaseExpiresAt).action).toBe("review");
    expect(decideRecovery(lease, durable, absent, 4_999).action).toBe("review");
    expect(decideRecovery(lease, durable, { ...absent, requestHash: "b".repeat(64) }, 5_000).action).toBe("review");
    expect(decideRecovery(lease, durable, { ...absent, idempotencyKey: "new-key" }, 5_000).action).toBe("review");
  });
  it("binds found pending/settled/returned evidence without issuing another transfer", () => {
    for (const found of [{ ...observation, status: "pending" as const }, observation, returned]) {
      expect(decideRecovery(lease, durable, { ...absent, kind: "found", observation: found }, 5_000)).toEqual({ action: "complete", observation: found });
    }
    expect(() => decideRecovery(lease, durable, { ...absent, kind: "found", observation: { ...observation, requestHash: "b".repeat(64) } }, 5_000)).toThrow();
  });
  it.each(["organizationId", "runId", "accountId"] as const)("rejects cross-%s evidence and lookup", dimension => {
    const wrongScope = { ...scope, [dimension]: "foreign" };
    expect(() => assertObservationMatchesCommand(command, { ...observation, scope: wrongScope })).toThrow();
    expect(decideRecovery(lease, durable, { ...absent, scope: wrongScope }, 5_000).action).toBe("review");
  });
  it("rejects cross-provider/environment identity even with the same account", () => {
    const wrongScope: BankScope = { ...scope, provider: "increase", environment: "sandbox" };
    expect(() => assertObservationMatchesCommand(command, { ...observation, scope: wrongScope })).toThrow();
    expect(decideRecovery(lease, durable, { ...absent, scope: wrongScope }, 5_000).action).toBe("review");
  });
});

describe("independent cash evidence and separate returns", () => {
  it("requires dispatched context when supplied", () => {
    expect(() => assertObservationMatchesCommand(command, observation, { execution: "queued" })).toThrow();
    expect(() => assertObservationMatchesCommand(command, observation, { execution: "cancelled", firstAttemptAt: 1_000 })).toThrow();
    expect(() => assertObservationMatchesCommand(command, observation, { execution: "pending", firstAttemptAt: 1_000, providerTransferId: "other" })).toThrow();
  });
  it("only posts a corroborated posted debit, not pending acceptance or a pending transaction", () => {
    expect(() => assertPostingEvidence(command, observation, debit)).not.toThrow();
    expect(() => assertPostingEvidence(command, { ...observation, status: "pending" }, debit)).toThrow();
    expect(() => assertPostingEvidence(command, observation, { ...debit, status: "pending", postedAt: undefined })).toThrow();
    expect(() => assertPostingEvidence(command, observation, { ...debit, id: "other-debit" })).toThrow();
  });
  it("retains unrelated posted account activity but cannot apply it as an AP payment", () => {
    const other: BankTransaction = { ...debit, purpose: "other", amountCents: 10_000, commandId: "", transferId: "", sourceCategory: "inbound_wire_transfer" };
    expect(parseBankTransaction(other)).toEqual(other);
    expect(() => assertPostingEvidence(command, observation, other)).toThrow();
  });
  it("requires a distinct return and the correctly posted original debit", () => {
    expect(() => assertPostingEvidence(command, returned, returnTransaction, { transaction: debit, entryId: "journal-debit" })).not.toThrow();
    expect(() => assertPostingEvidence(command, returned, returnTransaction)).toThrow();
    expect(() => assertPostingEvidence(command, returned, returnTransaction, { transaction: debit, entryId: " " })).toThrow();
    expect(() => assertPostingEvidence(command, returned, returnTransaction, { transaction: { ...debit, scope: { ...scope, accountId: "foreign" } }, entryId: "journal-debit" })).toThrow();
    expect(() => assertPostingEvidence(command, returned, returnTransaction, { transaction: { ...debit, amountCents: -9_999 }, entryId: "journal-debit" })).toThrow();
  });
  it("rejects wrong signs, missing posted timestamps and collapsed return links", () => {
    expect(() => parseBankTransaction({ ...debit, amountCents: 10_000 })).toThrow();
    expect(() => parseBankTransaction({ ...returnTransaction, amountCents: -10_000 })).toThrow();
    expect(() => parseBankTransaction({ ...debit, postedAt: undefined })).toThrow();
    expect(() => parseTransferObservation({ ...returned, returnTransactionId: returned.originalTransactionId })).toThrow();
    expect(() => parseTransferObservation({ ...observation, status: "rejected" })).toThrow();
  });
});
