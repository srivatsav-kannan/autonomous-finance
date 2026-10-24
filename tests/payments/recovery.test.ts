import { describe, expect, it, vi } from "vitest";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import {
  BankProviderError, PAYMENT_EXECUTOR_VERSION, buildIncreaseRequestBody, commandRequestHash,
  type BankCommand, type EffectLease, type TransferObservation,
} from "../../src/payments/contracts";
import type { PaymentKernel } from "../../src/payments/ports/payment-kernel";
import type { PaymentRail, RailRecoveryCapability, TransferLookup } from "../../src/payments/ports/payment-rail";

async function fixture() {
  const firstAttemptAt = 1_792_785_600_000;
  const request = {
    commandId: "immutable-payment-version", approvalVersion: "immutable-payment-version",
    scope: { organizationId: "org", runId: "run", provider: "increase" as const, environment: "sandbox" as const, accountId: "account_approved" },
    amountCents: 9750, currency: "USD" as const,
    destination: { externalAccountId: "external_approved", version: "beneficiary-v1" },
    idempotencyKey: "original-provider-operation",
  };
  // Semantically valid whitespace deliberately differs from the normal builder.
  // A recovery executor may validate these saved bytes but must not normalize them.
  const saved = { ...request, providerRequest: `\n${buildIncreaseRequestBody(request)}\n` };
  const command: BankCommand = { ...saved, requestHash: await commandRequestHash(saved) };
  const lease: EffectLease = { commandId: "outbox-effect-row", generation: 2, leaseToken: "unique-current-lease-token",
    command, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, action: "reconcile", firstAttemptAt, leaseExpiresAt: firstAttemptAt + 30_000 };
  const observation: TransferObservation = { id: "original-bank-transfer", scope: command.scope,
    commandId: command.commandId, idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
    amountCents: command.amountCents, currency: "USD", destination: command.destination,
    status: "pending", createdAt: new Date(firstAttemptAt).toISOString(), updatedAt: new Date(firstAttemptAt).toISOString() };
  let now = firstAttemptAt + 1000;
  let lookup: TransferLookup = { scope: command.scope, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    requestHash: command.requestHash, checkedAt: now, kind: "found", observation };
  let recovery: RailRecoveryCapability = { lookup: "operation_key", sameKeyResend: { kind: "never", reason: "No provider retention established" } };
  const order: string[] = [];
  const kernel: PaymentKernel = {
    claim: vi.fn(async () => structuredClone(lease)),
    heartbeat: vi.fn(async () => ({ ok: true as const })),
    complete: vi.fn(async () => ({ ok: true as const })),
    fail: vi.fn(async () => ({ execution: "exception" as const, nextAttemptAt: now })),
  };
  const rail: PaymentRail = {
    get recovery() { return recovery; },
    createTransfer: vi.fn(async () => { order.push("create"); return structuredClone(observation); }),
    lookupTransfer: vi.fn(async () => { order.push("lookup"); return structuredClone(lookup); }),
  };
  const stop = vi.fn();
  const worker = new ExecutePaymentEffect(kernel, rail, "independent-port-worker", {
    now: () => now, newLeaseToken: () => "unique-current-lease-token", startHeartbeat: () => stop,
  });
  return { command, lease, observation, kernel, rail, worker, stop, order,
    setNow(value: number) { now = value; },
    setLookup(value: TransferLookup) { lookup = value; },
    get lookup() { return lookup; },
    setRecovery(value: RailRecoveryCapability) { recovery = value; },
  };
}

describe("independent application recovery contract", () => {
  it("finds the original transfer without sending again and records only acceptance", async () => {
    const f = await fixture(); await f.worker.tick();
    expect(f.order).toEqual(["lookup"]);
    expect(f.rail.lookupTransfer).toHaveBeenCalledWith(f.command, undefined);
    expect(f.kernel.complete).toHaveBeenCalledWith({ commandId: f.lease.commandId, generation: f.lease.generation, leaseToken: f.lease.leaseToken, providerTransferId: f.observation.id });
    expect(f.kernel.fail).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledOnce();
  });

  it("allows the first send while preserving exact saved Increase request bytes", async () => {
    const f = await fixture(); f.lease.action = "submit"; f.lease.generation = 1;
    await f.worker.tick();
    expect(f.order).toEqual(["create"]);
    const submitted = vi.mocked(f.rail.createTransfer).mock.calls[0]![0];
    expect(submitted).toEqual(f.command);
    expect(submitted.providerRequest).toBe(f.command.providerRequest);
    expect(submitted.providerRequest).not.toBe(buildIncreaseRequestBody(submitted));
    expect(await commandRequestHash(submitted)).toBe(f.command.requestHash);
  });

  it.each(["organizationId", "runId", "accountId", "provider", "environment"] as const)("rejects a lookup for the wrong %s without binding or resending", async field => {
    const f = await fixture();
    const value = field === "provider" ? "fake" : field === "environment" ? "local" : "foreign";
    f.setLookup({ ...f.lookup, scope: { ...f.command.scope, [field]: value } });
    await f.worker.tick();
    expect(f.order).toEqual(["lookup"]); expect(f.kernel.complete).not.toHaveBeenCalled();
    expect(f.kernel.fail).toHaveBeenCalledWith(expect.objectContaining({ errorClass: "configuration" }));
  });

  it.each(["amount", "operation-key", "request-hash", "command", "destination", "destination-version"])("rejects a found transfer with mismatched %s", async mismatch => {
    const f = await fixture();
    const observation = structuredClone(f.observation);
    if (mismatch === "amount") observation.amountCents++;
    if (mismatch === "operation-key") observation.idempotencyKey = "different-operation";
    if (mismatch === "request-hash") observation.requestHash = "f".repeat(64);
    if (mismatch === "command") observation.commandId = "different-version";
    if (mismatch === "destination") observation.destination.externalAccountId = "different-account";
    if (mismatch === "destination-version") observation.destination.version = "beneficiary-v2";
    f.setLookup({ ...f.lookup, kind: "found", observation });
    await f.worker.tick();
    expect(f.order).toEqual(["lookup"]); expect(f.kernel.complete).not.toHaveBeenCalled();
    expect(f.kernel.fail).toHaveBeenCalledWith(expect.objectContaining({ errorClass: "configuration" }));
  });

  it.each(["never", "expired", "known-transfer", "transfer-id-only", "unknown"])("preserves unresolved work when recovery is %s", async condition => {
    const f = await fixture();
    f.setLookup({ ...f.lookup, kind: "not_found", searchedBy: "operation_key" });
    if (condition === "expired") f.setRecovery({ lookup: "operation_key", sameKeyResend: { kind: "retained", retentionMs: 1000, documentation: "test provider guarantee" } });
    if (condition === "known-transfer") {
      f.lease.providerTransferId = "previously-known-transfer";
      f.setRecovery({ lookup: "operation_key", sameKeyResend: { kind: "durable", documentation: "test provider guarantee" } });
    }
    if (condition === "transfer-id-only") {
      f.setRecovery({ lookup: "transfer_id_only", sameKeyResend: { kind: "durable", documentation: "test provider guarantee" } });
      f.setLookup({ ...f.lookup, kind: "not_found", searchedBy: "transfer_id" });
    }
    if (condition === "unknown") f.setLookup({ ...f.lookup, kind: "unknown", reason: "Provider scan was incomplete" });
    await f.worker.tick();
    expect(f.order).toEqual(["lookup"]); expect(f.kernel.complete).not.toHaveBeenCalled();
    expect(f.kernel.fail).toHaveBeenCalled();
  });

  it("resends only after a complete negative lookup within documented original retention", async () => {
    const f = await fixture();
    f.setLookup({ ...f.lookup, kind: "not_found", searchedBy: "operation_key" });
    f.setRecovery({ lookup: "operation_key", sameKeyResend: { kind: "retained", retentionMs: 1001, documentation: "test provider guarantee" } });
    await f.worker.tick();
    expect(f.order).toEqual(["lookup", "create"]);
    expect(vi.mocked(f.rail.createTransfer).mock.calls[0]![0]).toEqual(f.command);
    expect(f.kernel.complete).toHaveBeenCalledOnce();
  });

  it("a lookup transport error never turns into absence or a new send", async () => {
    const f = await fixture();
    vi.mocked(f.rail.lookupTransfer).mockRejectedValue(new BankProviderError("transport", "lookup unavailable", true));
    await f.worker.tick();
    expect(f.rail.createTransfer).not.toHaveBeenCalled(); expect(f.kernel.complete).not.toHaveBeenCalled();
    expect(f.kernel.fail).toHaveBeenCalledWith(expect.objectContaining({ errorClass: "transport" }));
  });

  it("lease expiry while lookup runs prevents resend even within the provider guarantee", async () => {
    const f = await fixture();
    f.setRecovery({ lookup: "operation_key", sameKeyResend: { kind: "durable", documentation: "test provider guarantee" } });
    vi.mocked(f.rail.lookupTransfer).mockImplementation(async () => {
      f.setNow(f.lease.leaseExpiresAt);
      return { ...f.lookup, kind: "not_found", searchedBy: "operation_key" };
    });
    await f.worker.tick();
    expect(f.rail.createTransfer).not.toHaveBeenCalled(); expect(f.kernel.complete).not.toHaveBeenCalled();
    expect(f.kernel.fail).toHaveBeenCalled();
  });
});
