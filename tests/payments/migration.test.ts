import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, demoFixture } from "../demo-fixture";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const claimArgs = (f: Awaited<ReturnType<typeof demoFixture>>) => ({
  scope: f.scope, token: f.dispatcherToken, workerId: "independent-migration-worker",
  leaseToken: randomUUID(), paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
});

describe("independent executor cutover and immutable execution authority", () => {
  it("records the executor explicitly and rejects an old caller without creating an attempt", async () => {
    const f = await demoFixture(); const queued = await f.queued();
    const config = (await f.t.run(ctx => ctx.db.query("demoConfigs").collect()))[0]!;
    expect(config.paymentExecutorVersion).toBe(PAYMENT_EXECUTOR_VERSION);
    const before = await f.t.run(ctx => ctx.db.get(queued.commandId));
    const { paymentExecutorVersion: _, ...legacy } = claimArgs(f);
    await expect(f.t.mutation(api.demoPayments.claim, legacy)).rejects.toThrow();
    await expect(f.t.mutation(api.demoPayments.claim, { ...claimArgs(f), paymentExecutorVersion: "legacy-v1" })).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.get(queued.commandId))).toEqual(before);
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
  });

  it.each(["queued", "unknown"] as const)("gates historical %s work with no executor metadata without rewriting its identity", async execution => {
    const f = await demoFixture(); const queued = await f.queued();
    await f.t.run(async ctx => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, { paymentExecutorVersion: undefined });
      if (execution === "unknown") await ctx.db.patch(queued.commandId, {
        execution, attemptCount: 1, generation: 1, firstAttemptAt: Date.now() - 1000,
      });
    });
    const before = await f.t.run(ctx => ctx.db.get(queued.commandId));
    await expect(f.t.mutation(api.demoPayments.claim, claimArgs(f))).rejects.toThrow();
    expect(await f.t.run(ctx => ctx.db.get(queued.commandId))).toEqual(before);
    expect(await f.t.run(ctx => ctx.db.get(queued.billId))).toMatchObject({ paidCents: 0, reservedVersionId: queued.versionId });
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
    const review = await f.human.query(api.demoPayments.humanReview, { scope: f.scope });
    expect(review.executionConfig).toMatchObject({ eligible: false, reason: expect.stringMatching(/historical.*review/i) });
    expect(review.commands[0]?.command).toEqual(before!.command);
  });

  it("refuses activation over a legacy submitted transfer without backfilling a new key", async () => {
    const f = await demoFixture();
    const legacyId = await f.t.run(async ctx => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.delete(config._id);
      return ctx.db.insert("paymentIntents", {
        runId: f.scope.runId, payee: "vendor-1", amountCents: 10_000, method: "ach",
        remitTo: { bank: "legacy", accountLast4: "1234", memorySha: "reviewed-v1" },
        billIds: [], dueDate: "2026-10-23", requestedBy: "payments", approvals: [],
        requiredApprovals: 1, requiresHuman: true, status: "submitted",
        idempotencyKey: "historical-operation-must-not-change", createdAt: Date.now(),
      });
    });
    const before = await f.t.run(ctx => ctx.db.get(legacyId));
    await expect(f.t.mutation(api.demoPayments.configure, {
      scope: f.scope, secret: "test-admin",
      beneficiary: { vendor: "vendor-1", externalAccountId: "external-account-1", version: "beneficiary-v1" },
      policyVersion: "policy-v1", controllerLimitCents: 1_000_000,
      humanSubjects: [{ subject: f.humanIdentity.tokenIdentifier, seatId: "human_cfo" }],
    })).rejects.toThrow(/fresh run|historical/i);
    expect(await f.t.run(ctx => ctx.db.get(legacyId))).toEqual(before);
    expect(await f.t.run(ctx => ctx.db.query("demoConfigs").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("demoCommands").collect())).toEqual([]);
  });

  it.each(["attempt-count", "provider-reference", "lease-generation"])("does not invent a first-attempt time for historical %s evidence", async history => {
    const f = await demoFixture(); const queued = await f.queued();
    await f.t.run(ctx => ctx.db.patch(queued.commandId, history === "attempt-count" ? { attemptCount: 1 } :
      history === "provider-reference" ? { providerTransferId: "unresolved-original-transfer" } : { generation: 1 }));
    const before = await f.t.run(ctx => ctx.db.get(queued.commandId));
    await expect(f.t.mutation(api.demoPayments.claim, claimArgs(f))).rejects.toThrow(/historical dispatch is ambiguous/i);
    expect(await f.t.run(ctx => ctx.db.get(queued.commandId))).toEqual(before);
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
    expect((await f.human.query(api.demoPayments.humanReview, { scope: f.scope })).commands[0]?.command).toEqual(before!.command);
  });

  it.each(["bill", "credit"])("rechecks the reserved %s allocation before the first send", async changed => {
    const f = await demoFixture();
    const { creditId } = await f.human.mutation(api.demoPayments.recordCredit, { scope: f.scope, reference: "migration-credit", amountCents: 2500, evidence: "reviewed-credit", date: "2026-10-23", expenseAccount: "5000" });
    const queued = await f.queued(10_000, [{ creditId, amountCents: 2500 }]);
    const before = await f.t.run(ctx => ctx.db.get(queued.commandId));
    await f.t.run(async ctx => {
      if (changed === "bill") await ctx.db.patch(queued.billId, { version: (await ctx.db.get(queued.billId))!.version + 1 });
      else await ctx.db.patch(creditId, { reservedCents: 0 });
    });
    expect(await f.t.mutation(api.demoPayments.claim, claimArgs(f))).toBeNull();
    const after = await f.t.run(ctx => ctx.db.get(queued.commandId));
    expect(after).toMatchObject({ execution: "exception", attemptCount: 0, command: before!.command });
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.get(queued.billId))).toMatchObject({ paidCents: 0, reservedVersionId: queued.versionId });
  });

  it.each(["policy", "beneficiary-version", "beneficiary-account"])("blocks first dispatch after %s changes", async change => {
    const f = await demoFixture(); const queued = await f.queued();
    const before = await f.t.run(ctx => ctx.db.get(queued.commandId));
    await f.t.run(async ctx => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, change === "policy" ? { policyVersion: "policy-v2" } : {
        beneficiary: { ...config.beneficiary, ...(change === "beneficiary-version" ? { version: "beneficiary-v2" } : { externalAccountId: "replacement-account" }) },
      });
    });
    expect(await f.t.mutation(api.demoPayments.claim, claimArgs(f))).toBeNull();
    const after = await f.t.run(ctx => ctx.db.get(queued.commandId));
    expect(after!.command).toEqual(before!.command);
    expect(after).toMatchObject({ attemptCount: 0, execution: "exception", lastError: expect.stringMatching(/stale policy, beneficiary or bank scope/i) });
    expect(await f.t.run(ctx => ctx.db.get(queued.billId))).toMatchObject({ reservedVersionId: queued.versionId });
    expect(await f.t.run(ctx => ctx.db.query("demoAttempts").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.get(queued.billId))).toMatchObject({ paidCents: 0 });
  });

  it("reclaims the original instruction after a possible send despite newer configuration and fences the old worker", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const f = await demoFixture(); const queued = await f.queued();
    const first = await f.t.mutation(api.demoPayments.claim, claimArgs(f));
    expect(first?.action).toBe("submit");
    if (!first) throw new Error("Expected initial claim");
    await f.t.run(async ctx => {
      const config = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(config._id, { policyVersion: "policy-v2", beneficiary: { ...config.beneficiary, version: "beneficiary-v2", externalAccountId: "replacement-account" } });
    });
    vi.setSystemTime(first.leaseExpiresAt + 1);
    const second = await f.t.mutation(api.demoPayments.claim, claimArgs(f));
    expect(second).toMatchObject({ action: "reconcile", firstAttemptAt: first.firstAttemptAt, command: first.command, generation: first.generation + 1 });
    const stale = { scope: f.scope, token: f.dispatcherToken, paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION, commandId: first.commandId, generation: first.generation, leaseToken: first.leaseToken };
    await expect(f.t.mutation(api.demoPayments.complete, { ...stale, providerTransferId: "late-response" })).rejects.toThrow(/stale/i);
    await expect(f.t.mutation(api.demoPayments.heartbeat, stale)).rejects.toThrow(/stale/i);
    await expect(f.t.mutation(api.demoPayments.fail, { ...stale, errorClass: "transport", error: "late failure" })).rejects.toThrow(/stale/i);
    expect(await f.t.run(ctx => ctx.db.get(queued.billId))).toMatchObject({ paidCents: 0, reservedVersionId: queued.versionId });
  });
});
