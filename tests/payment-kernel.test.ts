import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture, paymentLeaseProof } from "./demo-fixture";
import { PAYMENT_EXECUTOR_VERSION, commandRequestHash } from "../src/payments/contracts";
import type { BankTransaction, TransferObservation } from "../src/payments/contracts";

const epoch = Date.parse("2026-10-23T12:00:00.000Z");
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
type Fixture = Awaited<ReturnType<typeof demoFixture>>;
const dispatch = (f: Fixture) => ({ scope: f.scope, token: f.dispatcherToken, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION });
const claim = (f: Fixture, leaseToken = "kernel-first-lease-token") => f.t.mutation(api.demoPayments.claim, { ...dispatch(f), workerId: "kernel-worker", leaseToken });

async function config(f: Fixture) { return (await f.t.run(ctx => ctx.db.query("demoConfigs").first()))!; }
const configureArgs = (f: Fixture) => ({
  scope: f.scope, secret: "test-admin", beneficiary: { vendor: "vendor-1", externalAccountId: "external-account-1", version: "beneficiary-v1" },
  policyVersion: "policy-v1", controllerLimitCents: 1_000_000,
  humanSubjects: [{ subject: f.humanIdentity.tokenIdentifier, seatId: "human_cfo" }],
});

describe("payment executor migration authority", () => {
  it("writes an explicit immutable v2 configuration and reviewed provenance", async () => {
    const f = await demoFixture();
    expect(await config(f)).toMatchObject({ paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION });
    const previous = await config(f);
    await f.t.run(ctx => ctx.db.delete(previous._id));
    await expect(f.t.mutation(api.demoPayments.configure, { ...configureArgs(f), paymentExecutorVersion: "legacy" })).rejects.toThrow("historical outcomes");
    const provenance = { decisionPath: "decisions/payment-policy.md", knowledgeCommit: "reviewed-commit" };
    await f.t.mutation(api.demoPayments.configure, { ...configureArgs(f), provenance });
    expect(await config(f)).toMatchObject({ paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, provenance });
    await expect(f.t.mutation(api.demoPayments.configure, configureArgs(f))).rejects.toThrow("immutable");
  });

  it("keeps historical command and evidence visible while refusing execution or backfill", async () => {
    const f = await demoFixture(); const q = await f.queued();
    const original = await f.t.run(ctx => ctx.db.get(q.commandId));
    const c = await config(f);
    await f.t.run(ctx => ctx.db.patch(c._id, { paymentExecutorVersion: undefined }));
    await expect(claim(f)).rejects.toThrow("historical outcomes require review");
    await expect(f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "new", billIds: [q.billId], credits: [] })).rejects.toThrow("historical outcomes");
    await expect(f.human.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, versionId: q.versionId, snapshotHash: q.snapshotHash })).rejects.toThrow("historical outcomes");
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review).toMatchObject({ executionConfig: { paymentExecutorVersion: null, eligible: false, reason: expect.stringContaining("requires review") } });
    expect(review.commands[0]?.command).toEqual(original!.command);
    expect(await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).toHaveProperty("blockers");
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toEqual(original);
    expect((await config(f)).paymentExecutorVersion).toBeUndefined();
    await expect(f.t.mutation(api.demoPayments.configure, configureArgs(f))).rejects.toThrow("immutable");
  });

  it("refuses activation over orphaned historical scoped financial rows", async () => {
    const f = await demoFixture(); const q = await f.queued(); const c = await config(f);
    await f.t.run(ctx => ctx.db.delete(c._id));
    // Keep only scoped history: the activation gate must inspect more than legacy tables.
    await f.t.run(async ctx => { for (const entry of await ctx.db.query("journalEntries").collect()) await ctx.db.delete(entry._id); });
    await expect(f.t.mutation(api.demoPayments.configure, configureArgs(f))).rejects.toThrow("fresh run");
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toMatchObject({ attemptCount: 0 });
    expect(await f.t.run(ctx => ctx.db.query("demoConfigs").collect())).toEqual([]);
  });

  it("requires the caller executor version on all four lease mutations", async () => {
    const f = await demoFixture(); const q = await f.queued();
    for (const paymentExecutorVersion of [undefined, "scoped-ap-v1", "legacy"]) {
      await expect(f.t.mutation(api.demoPayments.claim, { scope: f.scope, token: f.dispatcherToken, paymentExecutorVersion, workerId: "old", leaseToken: "old-worker-lease-token" })).rejects.toThrow("scoped-ap-v2");
    }
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toMatchObject({ generation: 0, attemptCount: 0 });
    const leased = await claim(f); assert(leased);
    const proof = { scope: f.scope, token: f.dispatcherToken, ...paymentLeaseProof(leased) };
    for (const paymentExecutorVersion of [undefined, "legacy"]) {
      await expect(f.t.mutation(api.demoPayments.heartbeat, { ...proof, paymentExecutorVersion })).rejects.toThrow("scoped-ap-v2");
      await expect(f.t.mutation(api.demoPayments.complete, { ...proof, paymentExecutorVersion, providerTransferId: "bank-1" })).rejects.toThrow("scoped-ap-v2");
      await expect(f.t.mutation(api.demoPayments.fail, { ...proof, paymentExecutorVersion, errorClass: "transport", error: "lost" })).rejects.toThrow("scoped-ap-v2");
    }
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toMatchObject({ execution: "in_flight", generation: 1, attemptCount: 1 });
  });
});

describe("atomic request reservations", () => {
  it("reserves before approval, replays without doubling credits, and releases on cancellation", async () => {
    const f = await demoFixture(); const billId = await f.bill();
    const { creditId } = await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "credit", amountCents: 3000, evidence: "credit.pdf", date: "2026-10-23", expenseAccount: "5000" });
    const args = { ...f.payments, requestKey: "reserved-request", billIds: [billId], credits: [{ creditId, amountCents: 2000 }] };
    const requested = await f.t.mutation(api.demoPayments.requestPayment, args);
    expect(await f.t.mutation(api.demoPayments.requestPayment, args)).toEqual(requested);
    expect(await f.t.run(ctx => ctx.db.get(billId))).toMatchObject({ reservedVersionId: requested.versionId });
    expect(await f.t.run(ctx => ctx.db.get(creditId))).toMatchObject({ reservedCents: 2000, consumedCents: 0 });
    expect(await f.t.run(ctx => ctx.db.query("demoCommands").collect())).toEqual([]);
    await f.t.mutation(api.demoPayments.approveWithinPolicy, { ...f.controller, ...requested });
    expect(await claim(f)).toBeNull();
    await f.human.mutation(api.demoPayments.cancel, { scope: f.scope, versionId: requested.versionId });
    expect((await f.t.run(ctx => ctx.db.get(billId)))?.reservedVersionId).toBeUndefined();
    expect(await f.t.run(ctx => ctx.db.get(creditId))).toMatchObject({ reservedCents: 0, consumedCents: 0 });
    expect(await f.t.run(ctx => ctx.db.get(requested.versionId))).toMatchObject({ status: "cancelled", reservations: "released" });
  });

  it("rolls back a request that encounters a conflicting bill without partial reservation", async () => {
    const f = await demoFixture(); const a = await f.bill(), b = await f.bill();
    await f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "owner", billIds: [b], credits: [] });
    await expect(f.t.mutation(api.demoPayments.requestPayment, { ...f.payments, requestKey: "conflict", billIds: [a, b], credits: [] })).rejects.toThrow("not available");
    expect((await f.t.run(ctx => ctx.db.get(a)))?.reservedVersionId).toBeUndefined();
    expect(await f.t.run(ctx => ctx.db.query("demoVersions").collect())).toHaveLength(1);
  });
});

describe("first dispatch is an authoritative financial boundary", () => {
  it.each(["policy", "beneficiary", "snapshot_hash", "command_amount", "provider_request", "bill_version", "bill_flags", "bill_reservation", "credit", "human_identity"] as const)("blocks %s changes atomically before any attempt", async change => {
    const f = await demoFixture(`first-${change}`, { provider: "increase", environment: "sandbox" });
    const { creditId } = await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "credit", amountCents: 1000, evidence: "credit.pdf", date: "2026-10-23", expenseAccount: "5000" });
    const q = await f.queued(10_000, [{ creditId, amountCents: 1000 }]);
    const c = await config(f);
    await f.t.run(async ctx => {
      const row = (await ctx.db.get(q.commandId))!;
      const version = (await ctx.db.get(q.versionId))!;
      if (change === "policy") await ctx.db.patch(c._id, { policyVersion: "policy-v2" });
      if (change === "beneficiary") await ctx.db.patch(c._id, { beneficiary: { ...c.beneficiary, externalAccountId: "replaced-destination", version: "v2" } });
      if (change === "snapshot_hash") await ctx.db.patch(q.versionId, { snapshot: { ...version.snapshot, policyVersion: "tampered" } });
      if (change === "command_amount" || change === "provider_request") {
        const command = change === "command_amount" ? { ...row.command, amountCents: row.command.amountCents + 1 } : { ...row.command, providerRequest: row.command.providerRequest!.replace("external-account-1", "attacker-account") };
        await ctx.db.patch(row._id, { command: { ...command, requestHash: await commandRequestHash(command) } });
      }
      if (change === "bill_version") await ctx.db.patch(q.billId, { version: 99 });
      if (change === "bill_flags") await ctx.db.patch(q.billId, { flags: ["disputed"] });
      if (change === "bill_reservation") await ctx.db.patch(q.billId, { reservedVersionId: undefined });
      if (change === "credit") await ctx.db.patch(creditId, { reservedCents: 0 });
      if (change === "human_identity") await ctx.db.patch(q.versionId, { approvals: version.approvals.map(a => ({ ...a, subject: "forged|human" })) });
    });
    expect(await claim(f)).toBeNull();
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toMatchObject({ execution: "exception", attemptCount: 0, generation: 0 });
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.get(q.versionId))).toMatchObject({ reservations: "reserved", status: "queued" });
    expect((await f.t.run(ctx => ctx.db.get(q.billId)))?.paidCents).toBe(0);
    expect(await claim(f, "later-worker-lease-token")).toBeNull();
  });

  it("allows cancellation of a blocked never-attempted payment and prevents unsafe resume", async () => {
    const f = await demoFixture(); const q = await f.queued(); const c = await config(f);
    await f.t.run(ctx => ctx.db.patch(c._id, { policyVersion: "policy-v2" }));
    expect(await claim(f)).toBeNull();
    await expect(f.human.mutation(api.demoPayments.resume, { scope: f.scope, commandId: q.commandId, reason: "try again" })).rejects.toThrow("No original dispatch time");
    await f.human.mutation(api.demoPayments.cancel, { scope: f.scope, versionId: q.versionId });
    expect(await f.t.run(ctx => ctx.db.get(q.commandId))).toMatchObject({ execution: "cancelled", attemptCount: 0 });
    expect((await f.t.run(ctx => ctx.db.get(q.billId)))?.reservedVersionId).toBeUndefined();
  });
});

describe("recovery preserves the original money identity", () => {
  it("reconciles after authority changes and manual resume, preserving bytes, key and first time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const f = await demoFixture("recovery", { provider: "increase", environment: "sandbox" }); const q = await f.queued();
    // Same semantics with distinct whitespace: the original provider bytes must survive every lease.
    await f.t.run(async ctx => { const row = (await ctx.db.get(q.commandId))!; const command = { ...row.command, providerRequest: ` ${row.command.providerRequest}\n` }; await ctx.db.patch(row._id, { command: { ...command, requestHash: await commandRequestHash(command) } }); });
    const first = await claim(f); assert(first);
    expect(first).toMatchObject({ action: "submit", paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION });
    const firstAttemptAt = first.firstAttemptAt;
    expect(firstAttemptAt).toBeGreaterThanOrEqual(epoch);
    expect(first.leaseExpiresAt - firstAttemptAt).toBe(30_000);
    const c = await config(f);
    await f.t.run(async ctx => {
      await ctx.db.patch(c._id, { policyVersion: "new-policy", beneficiary: { ...c.beneficiary, externalAccountId: "new-account", version: "v2" } });
      await ctx.db.patch(q.billId, { version: 99, flags: ["arrived after dispatch"] });
    });
    vi.setSystemTime(first.leaseExpiresAt + 1);
    const second = await claim(f, "kernel-reclaim-lease-token"); assert(second);
    expect(second).toMatchObject({ action: "reconcile", command: first.command, firstAttemptAt, generation: 2 });
    const stale = { ...dispatch(f), ...paymentLeaseProof(first) };
    await expect(f.t.mutation(api.demoPayments.heartbeat, stale)).rejects.toThrow("Stale");
    await expect(f.t.mutation(api.demoPayments.complete, { ...stale, providerTransferId: "bank-1" })).rejects.toThrow("Stale");
    await expect(f.t.mutation(api.demoPayments.fail, { ...stale, errorClass: "transport", error: "late" })).rejects.toThrow("Stale");
    await f.t.mutation(api.demoPayments.fail, { ...dispatch(f), ...paymentLeaseProof(second), errorClass: "configuration", error: "review retention" });
    vi.setSystemTime(epoch + 60_000);
    await f.human.mutation(api.demoPayments.resume, { scope: f.scope, commandId: q.commandId, reason: "read-only reconciliation" });
    const resumed = await claim(f, "kernel-resumed-lease-token"); assert(resumed);
    expect(resumed).toMatchObject({ action: "reconcile", command: first.command, firstAttemptAt, generation: 3 });
    expect((await f.t.run(ctx => ctx.db.get(q.billId)))?.reservedVersionId).toBe(q.versionId);
  });

  it("does not invent a new retention clock for an ambiguous historical attempt", async () => {
    const f = await demoFixture(); const q = await f.queued(); const original = (await f.t.run(ctx => ctx.db.get(q.commandId)))!.command;
    await f.t.run(ctx => ctx.db.patch(q.commandId, { execution: "unknown", attemptCount: 1, generation: 1 }));
    await expect(claim(f)).rejects.toThrow("original first attempt required");
    const row = (await f.t.run(ctx => ctx.db.get(q.commandId)))!;
    expect(row.firstAttemptAt).toBeUndefined(); expect(row.command).toEqual(original);
    expect(row.attemptCount).toBe(1);
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
  });
});

describe("verified account evidence stays separate from cash posting", () => {
  it("validates unknown transfer evidence before retaining it for review", async () => {
    const f = await demoFixture();
    const observation: TransferObservation = { id: "external-transfer", scope: f.scope, commandId: "external-command", idempotencyKey: "external-key", requestHash: "0".repeat(64), amountCents: 2000, currency: "USD", destination: { externalAccountId: "external-account-1", version: "v1" }, status: "pending", createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z" };
    const service = { scope: f.scope, token: f.evidenceToken };
    await expect(f.t.mutation(api.demoEvidence.observeTransfer, { ...service, observation: { ...observation, amountCents: -1 }, transactions: [] })).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.query("demoObservations").collect())).toEqual([]);
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...service, observation, transactions: [] });
    expect(await f.human.query(api.demoEvidence.humanView, { scope: f.scope })).toMatchObject({ blockers: expect.arrayContaining([expect.objectContaining({ id: observation.id })]) });
  });

  it("retains an unrelated posted transaction without settling a matching-looking AP payment", async () => {
    const f = await demoFixture(); const q = await f.queued(); const leased = await claim(f); assert(leased);
    const observation: TransferObservation = { ...leased.command, id: "transfer", status: "settled", originalTransactionId: "tx", createdAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:01.000Z" };
    // Observation shape contains only bank evidence fields, never the provider request payload.
    const { approvalVersion: _a, providerRequest: _p, ...observed } = observation as TransferObservation & { approvalVersion?: string; providerRequest?: string };
    const transaction: BankTransaction = { id: "tx", scope: f.scope, commandId: q.versionId, transferId: "transfer", amountCents: -10_000, currency: "USD", purpose: "other", status: "posted", createdAt: observed.createdAt, postedAt: observed.updatedAt };
    const service = { scope: f.scope, token: f.evidenceToken };
    await f.t.mutation(api.demoEvidence.observeTransfer, { ...service, observation: observed, transactions: [transaction] });
    await expect(f.t.mutation(api.demoEvidence.postTransaction, { ...service, transactionId: "tx" })).rejects.toThrow("Unverified economic evidence");
    expect(await f.t.run(ctx => ctx.db.query("demoTransactions").collect())).toMatchObject([{ transaction }]);
    expect(await f.t.run(ctx => ctx.db.get(q.billId))).toMatchObject({ paidCents: 0, reservedVersionId: q.versionId });
    expect(await f.t.run(ctx => ctx.db.query("journalEntries").collect())).toHaveLength(1);
  });
});
