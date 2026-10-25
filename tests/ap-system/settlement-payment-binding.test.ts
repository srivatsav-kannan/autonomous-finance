import { boundPayment } from "./settlement-payment-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, paymentLeaseProof } from "../demo-fixture";
import {
  PAYMENT_EXECUTOR_VERSION,
  buildIncreaseRequestBody,
  commandRequestHash,
} from "../../src/payments/contracts";
import { accountingBindingHash } from "../../src/payments/domain/accounting-binding";
const start = Date.parse("2026-10-25T12:00:00Z");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("Frozen settlement accounting binding", () => {
  it("binds exact partial cash and credit approval, then posts and reverses the original department after policy retirement", async () => {
    const f = await boundPayment();
    const lease = (await f.claim())!;
    expect(lease.action).toBe("submit");
    const version = (await f.t.run((ctx) => ctx.db.get(f.request.versionId)))!;
    expect(version.snapshot.accountingBinding).toMatchObject({
      department: "ops",
      bills: [{ billId: f.original.billId, appliedCents: 3000 }],
      credits: [{ creditId: f.credit.creditId, appliedCents: 1000 }],
    });
    expect(lease.command.accountingBindingHash).toBe(
      await accountingBindingHash(version.snapshot.accountingBinding!),
    );
    expect(
      JSON.parse(buildIncreaseRequestBody(lease.command)),
    ).not.toHaveProperty("accountingBindingHash");
    await f.t.run(async (ctx) => {
      const p = await ctx.db.query("apBusinessPolicies").first();
      await ctx.db.patch(p!._id, { status: "superseded" });
    });
    const debit = await f.post(),
      returned = await f.post(true);
    for (const id of [debit.entryId, returned.entryId]) {
      const j = (await f.t.run((ctx) => ctx.db.get(id)))!;
      expect(j.lines.map((l) => l.dims)).toEqual([
        { department: "ops" },
        { department: "ops" },
      ]);
    }
    expect(
      (await f.t.run((ctx) => ctx.db.get(returned.entryId)))!.lines,
    ).toMatchObject([
      { account: "1000", debit: 2000, credit: 0 },
      { account: "2000", debit: 0, credit: 2000 },
    ]);
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.credit.creditId)))!.consumedCents,
    ).toBe(1000);
    expect(await f.post(true)).toMatchObject({
      entryId: returned.entryId,
      replayed: true,
    });
  });
  it("rejects a validly rehashed command with a foreign accounting binding before any attempt", async () => {
    const f = await boundPayment();
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.get(f.approved.commandId))!;
      const command = { ...row.command, accountingBindingHash: "0".repeat(64) };
      command.requestHash = await commandRequestHash(command);
      await ctx.db.patch(row._id, { command });
    });
    expect(await f.claim()).toBeNull();
    expect(
      await f.t.run((ctx) => ctx.db.query("demoAttempts").collect()),
    ).toHaveLength(0);
  });
  it("keeps possible-send reconciliation and exact command after current policy retirement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const f = await boundPayment();
    const first = (await f.claim())!;
    const failed = await f.t.mutation(api.demoPayments.fail, {
      scope: f.scope,
      token: "test-dispatch",
      paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
      ...paymentLeaseProof(first),
      errorClass: "transport",
      error: "synthetic lost response",
      retryAfterMs: 1000,
    });
    await f.t.run(async (ctx) => {
      const p = await ctx.db.query("apBusinessPolicies").first();
      await ctx.db.patch(p!._id, { status: "superseded" });
    });
    vi.setSystemTime(failed.nextAttemptAt);
    const recovery = (await f.claim("dimension-lease-recovery"))!;
    expect(recovery).toMatchObject({
      action: "reconcile",
      command: first.command,
    });
  });
  it("preserves absence and existing canonical command hash for cost-only legacy scope", async () => {
    const f = await boundPayment(true),
      lease = (await f.claim())!;
    const v = (await f.t.run((ctx) => ctx.db.get(f.request.versionId)))!;
    expect(v.snapshot).not.toHaveProperty("accountingBinding");
    expect(lease.command).not.toHaveProperty("accountingBindingHash");
    expect(await commandRequestHash(lease.command)).toBe(
      lease.command.requestHash,
    );
    const j = await f.post();
    expect(
      (await f.t.run((ctx) => ctx.db.get(j.entryId)))!.lines.every(
        (l) => !l.dims?.department,
      ),
    ).toBe(true);
  });
});
