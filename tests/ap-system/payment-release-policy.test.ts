import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import { fixture, refs, packet } from "./accounting-fixture";
import { businessFixture, policy, subject } from "./business-fixture";
import { PAYMENT_EXECUTOR_VERSION } from "../../src/payments/contracts";
import { paymentLeaseProof } from "../demo-fixture";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const request = async (
  f: Pick<Awaited<ReturnType<typeof fixture>>, "t" | "scope" | "payer">,
  billId: any,
) =>
  f.t.mutation(api.demoPayments.requestPayment, {
    scope: f.scope,
    seatId: "payments",
    token: "token-payments",
    requestKey: `release-${billId}`,
    billIds: [billId],
    credits: [],
  });
const release = (
  f: Pick<Awaited<ReturnType<typeof fixture>>, "t" | "scope" | "payer">,
  p: any,
  h = f.payer,
) => h.mutation(api.demoPayments.approveAndQueue, { scope: f.scope, ...p });
const claim = (
  f: Pick<Awaited<ReturnType<typeof fixture>>, "t" | "scope" | "payer">,
  key = "release-policy-lease-1",
) =>
  f.t.mutation(api.demoPayments.claim, {
    scope: f.scope,
    token: "test-dispatch",
    paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
    workerId: "release-policy-test",
    leaseToken: key,
  });
it("requires distinct field reviewer, bill approver and authorized payer in first-wave AP", async () => {
  const f = await fixture(),
    d = await f.reviewed();
  await expect(
    f.fieldReviewer.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "self"), acceptedCents: 7700 },
    }),
  ).rejects.toThrow(/approval_segregation/);
  const b = await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, "bill"), acceptedCents: 7700 },
    }),
    p = await request(f, b.billId);
  await expect(release(f, p, f.human)).rejects.toThrow(
    /payment_group_required/,
  );
  await release(f, p);
  expect(await claim(f)).toMatchObject({ action: "submit" });
});
it("blocks linked AP free-text credits even before a business policy exists", async () => {
  const f = await fixture();
  await f.reviewed();
  await expect(
    f.human.mutation(api.demoPayments.recordCredit, {
      scope: f.scope,
      reference: "arbitrary",
      amountCents: 100,
      evidence: "text",
      date: "2026-10-19",
      expenseAccount: "5000",
    }),
  ).rejects.toThrow(/AP case credits/);
  expect(
    await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
  ).toHaveLength(0);
});
it.each(["owner", "finance", "verifier", "governor"])(
  "cannot release as %s even when that identity belongs to the payment group",
  async (name) => {
    const p = policy();
    p.groups.find((g) => g.groupId === "pay")!.members.push(subject(name));
    const f = await businessFixture({ policy: p }),
      b = await f.recognize(),
      r = await request(f, b.billId);
    await expect(release(f, r, f.humans[name]!)).rejects.toThrow(
      /payment_segregation/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
    ).toHaveLength(0);
    await release(f, r);
    expect(await claim(f)).toMatchObject({ action: "submit" });
  },
);
it("rejects field-reviewer business votes even when routed into an allowed approval group", async () => {
  const p = policy();
  p.groups
    .find((g) => g.groupId === "owner")!
    .members.push(subject("field-reviewer"));
  const f = await businessFixture({ policy: p }),
    proposal = await f.propose();
  await expect(
    f.fieldReviewer.mutation(
      makeFunctionReference<"mutation">("apBusiness:vote"),
      {
        scope: f.scope,
        input: {
          ...proposal,
          idempotencyKey: "field-vote",
          outcome: "approved",
          reason: "attempted self review",
        },
      },
    ),
  ).rejects.toThrow(/approval_segregation/);
});
it("checks the total batch amount and rolls back every member when it exceeds the ceiling", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const c = (await ctx.db.query("demoConfigs").collect())[0]!;
    await ctx.db.patch(c._id, {
      paymentAuthorizers: [{ subject: subject("payer"), maxCents: 10000 }],
    });
  });
  const selection = [];
  for (let i = 0; i < 2; i++) {
    const d = await f.reviewed(packet(`limit-${i}`));
    await f.human.mutation(refs.approve, {
      scope: f.scope,
      input: { ...f.request(d, `bill-${i}`), acceptedCents: 7700 },
    });
    selection.push({
      caseId: d.caseId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
    });
  }
  const run = await f.t.mutation(
    makeFunctionReference<"mutation">("apPaymentRuns:prepare"),
    {
      scope: f.scope,
      seatId: "payments",
      token: "token-payments",
      requestKey: "over-ceiling",
      selection,
    },
  );
  await expect(
    f.payer.mutation(
      makeFunctionReference<"mutation">("apPaymentRuns:authorize"),
      { scope: f.scope, ...run },
    ),
  ).rejects.toThrow(/payment_limit/);
  expect(
    await f.t.run((ctx) => ctx.db.query("demoCommands").collect()),
  ).toHaveLength(0);
  expect(
    (await f.t.run((ctx) => ctx.db.query("demoVersions").collect())).every(
      (v) => v.approvals.length === 0,
    ),
  ).toBe(true);
});
it.each([false, true])(
  "revalidates release policy before first dispatch, but preserves unknown-send recovery (attempted=%s)",
  async (attempted) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
    const f = await fixture(),
      d = await f.reviewed(),
      b = await f.human.mutation(refs.approve, {
        scope: f.scope,
        input: { ...f.request(d, "bill"), acceptedCents: 7700 },
      }),
      p = await request(f, b.billId);
    await release(f, p);
    const original = attempted ? await claim(f) : null;
    if (original)
      await f.t.mutation(api.demoPayments.fail, {
        scope: f.scope,
        token: "test-dispatch",
        paymentExecutorVersion: PAYMENT_EXECUTOR_VERSION,
        ...paymentLeaseProof(original),
        errorClass: "transport",
        error: "lost response",
        retryAfterMs: 1000,
      });
    await f.t.run(async (ctx) => {
      const c = (await ctx.db.query("demoConfigs").collect())[0]!;
      await ctx.db.patch(c._id, {
        paymentAuthorizers: [{ subject: subject("payer"), maxCents: 100 }],
      });
    });
    vi.advanceTimersByTime(2000);
    const next = await claim(f, "release-policy-recovery-2");
    if (attempted) {
      expect(next).toMatchObject({
        action: "reconcile",
        command: original!.command,
      });
    } else {
      expect(next).toBeNull();
      expect(
        await f.t.run((ctx) => ctx.db.query("demoAttempts").collect()),
      ).toHaveLength(0);
    }
  },
);
