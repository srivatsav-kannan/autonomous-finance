import { loadApprovedCloseExport } from "../../convex/lib/apSystem/closeExport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import type {
  TaxAdjustment,
  TaxShare,
} from "../../src/ap-system/tax-adjustment-contracts";
import { taxProportion } from "../../src/ap-system/tax-policy";
import { readTaxState } from "../../convex/lib/apSystem/taxAdjustments";
import { readCostState } from "../../convex/lib/apSystem/costState";
import { taxBusinessFixture } from "./tax-business-fixture";
import { cr } from "./business-fixture";
afterEach(() => vi.unstubAllEnvs());
const vote = makeFunctionReference<"mutation">("apClose:vote");
async function fixture(initial = 10000) {
  const f = await taxBusinessFixture({ recoveryBps: initial });
  const original = await f.propose(f.detail, f.a);
  await f.approve(original);
  const entry = (await f.state()).journals[0]!;
  const state = () => f.t.run((ctx) => readTaxState(ctx, f.scope, entry._id));
  async function policy(bps: number, enabled = true, jurisdiction?: string) {
    f.policy.version = `test-tax-recovery-${bps}`;
    f.policy.taxCodes.find((t) => t.code === "TEST")!.recovery!.adjustments = {
      mode: "reviewed_remaining_tax",
      attribution: "explicit_original_allocation",
      creditRounding: "half_up_cumulative_latest_adjustment",
    };
    f.policy.taxCodes.find((t) => t.code === "TEST")!.recovery!.recoverableBps =
      bps;
    if (!enabled)
      delete f.policy.taxCodes.find((t) => t.code === "TEST")!.recovery!
        .adjustments;
    if (jurisdiction)
      f.policy.taxCodes.find((t) => t.code === "TEST")!.recovery!.jurisdiction =
        jurisdiction;
    const next = await f.t.mutation(cr.proposePolicy!, {
      ...f.controller,
      idempotencyKey: f.policy.version,
      policy: f.policy,
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get(next.policyId as Id<"apBusinessPolicies">),
    );
    await f.humans.governor!.mutation(cr.activatePolicy!, {
      scope: f.scope,
      policyId: next.policyId,
      expectedHash: row!.hash,
      reason:
        "Explicit synthetic revised eligibility policy; no real taxpayer decision",
    });
  }
  async function propose(action: TaxAdjustment, key = "tax-adjustment") {
    return f.t.mutation(f.close, {
      ...f.controller,
      input: { idempotencyKey: key, action },
    });
  }
  async function approve(prop: any) {
    let result: any;
    for (const step of prop.route)
      result = await f.humans[
        step.groupId === "tax-review"
          ? "second"
          : step.groupId === "owner"
            ? "owner"
            : "finance"
      ]!.mutation(vote, {
        scope: f.scope,
        input: {
          actionId: prop.actionId,
          actionHash: prop.actionHash,
          idempotencyKey: `tax-vote-${prop.actionId}-${step.groupId}`,
          outcome: "approved",
          reason:
            "Review exact tax basis, allocation, retained evidence and policy",
        },
      });
    return result;
  }
  async function action(
    target: number,
    movements: TaxAdjustment["movements"],
    initialAttribution?: TaxShare[],
  ): Promise<TaxAdjustment> {
    const s = await state();
    return {
      kind: "tax_adjustment",
      originalEntryId: entry._id,
      originalApprovalId: original.proposalId,
      costSnapshotHash: s.costSnapshotHash,
      taxSnapshotHash: s.snapshotHash,
      targets: [{ originalLineId: "line-1", recoverableCents: target }],
      movements,
      date: "2026-10-19",
      eligibilityEvidence: f.a.lines[0]!.tax!.eligibilityEvidence,
      reason: "Supported synthetic eligibility correction",
      ...(initialAttribution ? { initialAttribution } : {}),
    };
  }
  function reversal(s: Awaited<ReturnType<typeof state>>, amount: number) {
    const line = s.lines[0]!;
    let recover =
        taxProportion(
          line.creditBasisRecoverableCents,
          line.creditedTaxCents + amount,
          line.creditBasisTaxCents,
        ) - line.creditedRecoverableCents,
      cost = amount - recover;
    const allocations: TaxShare[] = [];
    for (const b of s.buckets) {
      const n = Math.min(b.amountCents, b.treatment === "tax" ? recover : cost);
      if (n) allocations.push({ ...b, amountCents: n });
      if (b.treatment === "tax") recover -= n;
      else cost -= n;
    }
    return {
      snapshotHash: s.snapshotHash,
      allocations,
      reason: "Explicit reviewed current tax reversal",
    };
  }
  return {
    ...f,
    original,
    entry,
    taxState: state,
    changePolicy: policy,
    adjustment: action,
    proposeTax: propose,
    approveTax: approve,
    reversal,
  };
}

describe("immutable governed remaining-tax eligibility correction", () => {
  it("posts a separate correction and couples later credits to current remaining tax buckets", async () => {
    const f = await fixture();
    const before = await f.state();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const a = await f.adjustment(385, [
      {
        from: { ...s.buckets[0]!, amountCents: 385 },
        toAccount: "5000",
        toTreatment: "expense",
      },
    ]);
    const p = await f.proposeTax(a);
    expect(p.route.map((s: any) => s.groupId)).toEqual([
      "owner",
      "finance",
      "tax-review",
    ]);
    const r = await f.approveTax(p);
    const after = await f.state();
    expect(after.journals[0]).toEqual(before.journals[0]);
    expect(after.bills).toEqual(before.bills);
    expect(after.commands).toHaveLength(0);
    expect(
      after.journals[1]!.lines.map((l) => [l.account, l.debit, l.credit]),
    ).toEqual([
      ["5000", 385, 0],
      ["1180", 0, 385],
    ]);
    expect(r.entryId).toBe(after.journals[1]!._id);
    const exported = await f.t.run((ctx) =>
      loadApprovedCloseExport(ctx, f.scope, { actionId: p.actionId }),
    );
    expect(exported.kind).toBe("tax_reclassification");
    expect(exported.journal.source).toEqual({
      kind: "ap_tax_adjustment",
      ref: f.entry._id,
    });
    expect(
      exported.journal.lines.map((l) => [l.account, l.debit, l.credit]),
    ).toEqual([
      ["5000", 385, 0],
      ["1180", 0, 385],
    ]);
    expect(await f.approveTax(p)).toEqual(r);
    expect((await f.state()).journals).toHaveLength(2);
    for (const n of [1, 2]) {
      const c = await f.credit(
        f.original.proposalId,
        `ADJUSTED-RETURN-${n}`,
        3850,
        385,
      );
      await expect(c.propose()).rejects.toThrow(/stale_tax_snapshot/);
      c.plan.taxReversal = f.reversal(await f.taxState(), 385);
      await f.approve(await c.propose());
    }
    const result = await f.state();
    for (const account of ["5000", "1180", "2000"])
      expect(
        result.journals
          .flatMap((j) => j.lines)
          .filter((l) => l.account === account)
          .reduce((n, l) => n + l.debit - l.credit, 0),
      ).toBe(0);
    expect((await f.taxState()).buckets).toHaveLength(0);
    const cost = await f.t.run((ctx) =>
      readCostState(ctx, f.scope, f.entry._id),
    );
    expect(cost.positions.every((p) => p.balanceCents === 0)).toBe(true);
  });
  it("requires positive original-line attribution before increasing formerly embedded recovery", async () => {
    const f = await fixture(5000);
    await f.changePolicy(10000);
    const s = await f.taxState();
    expect(s.lines[0]!.unattributedCostCents).toBe(385);
    const share: TaxShare = {
      originalLineId: "line-1",
      allocationIndex: 0,
      account: "5000",
      treatment: "expense",
      store: "sf-hayes-valley",
      department: null,
      project: null,
      amountCents: 385,
    };
    const movement = {
      from: share,
      toAccount: "1180",
      toTreatment: "tax" as const,
    };
    await expect(
      f.proposeTax(await f.adjustment(770, [movement])),
    ).rejects.toThrow(/tax_attribution/);
    await f.approveTax(
      await f.proposeTax(await f.adjustment(770, [movement], [share])),
    );
    const final = await f.taxState();
    expect(final.lines[0]!.unattributedCostCents).toBe(0);
    expect(final.buckets.reduce((n, b) => n + b.amountCents, 0)).toBe(770);
    expect(final.buckets.every((b) => b.treatment === "tax")).toBe(true);
  });
  it("reviews embedded remaining tax after prior credits and a cost reclassification without rewriting either", async () => {
    const f = await fixture(5000);
    const first = await f.credit(
      f.original.proposalId,
      "BEFORE-REVIEW",
      3850,
      385,
    );
    await f.approve(await first.propose());
    const costAction = await f.t.mutation(f.close, {
      ...f.controller,
      input: {
        idempotencyKey: "earlier-cost",
        action: {
          kind: "adjustment",
          originalEntryId: f.entry._id,
          fromAccount: "5000",
          toAccount: "1200",
          amountCents: 4043,
          store: "sf-hayes-valley",
          date: "2026-10-19",
          evidence: f.proof,
          reason: "Earlier approved remaining cost reclassification",
        },
      },
    });
    await f.approveTax(costAction);
    const originals = structuredClone((await f.state()).journals);
    await f.changePolicy(10000);
    const share: TaxShare = {
      originalLineId: "line-1",
      allocationIndex: 0,
      account: "1200",
      treatment: "inventory",
      store: "sf-hayes-valley",
      department: null,
      project: null,
      amountCents: 193,
    };
    await f.approveTax(
      await f.proposeTax(
        await f.adjustment(
          385,
          [{ from: share, toAccount: "1180", toTreatment: "tax" }],
          [share],
        ),
      ),
    );
    const c = await f.credit(f.original.proposalId, "AFTER-REVIEW", 3850, 385);
    const state = await f.taxState();
    c.plan.taxReversal = f.reversal(state, 385);
    c.plan.correction = {
      snapshotHash: state.costSnapshotHash,
      allocations: [
        {
          originalLineId: "line-1",
          allocationIndex: 0,
          account: "1200",
          treatment: "inventory",
          store: "sf-hayes-valley",
          department: null,
          project: null,
          side: "credit",
          amountCents: 3850,
        },
      ],
      evidence: f.proof,
      reason:
        "Reverse only corrected net cost; tax uses its separately approved buckets",
    };
    await f.approve(await c.propose());
    const result = await f.state();
    expect(result.journals.slice(0, 3)).toEqual(originals);
    for (const account of ["5000", "1200", "1180", "2000"])
      expect(
        result.journals
          .flatMap((j) => j.lines)
          .filter((l) => l.account === account)
          .reduce((n, l) => n + l.debit - l.credit, 0),
      ).toBe(0);
  });
  it("supports a reviewed zero recovery target without new AP or cash", async () => {
    const f = await fixture();
    await f.changePolicy(0);
    const s = await f.taxState();
    await f.approveTax(
      await f.proposeTax(
        await f.adjustment(0, [
          { from: s.buckets[0]!, toAccount: "5000", toTreatment: "expense" },
        ]),
      ),
    );
    expect(
      (await f.taxState()).buckets.every((b) => b.treatment === "expense"),
    ).toBe(true);
    expect(
      (await f.state()).journals[1]!.lines.some((l) =>
        ["2000", "1000"].includes(l.account),
      ),
    ).toBe(false);
  });
  it.each([
    "wrong_target",
    "cash",
    "invoice_evidence",
    "stale_source",
    "wrong_original",
    "over_capacity",
    "closed_period",
  ])("rejects %s before posting", async (kind) => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const a = await f.adjustment(385, [
      {
        from: { ...s.buckets[0]!, amountCents: 385 },
        toAccount: "5000",
        toTreatment: "expense",
      },
    ]);
    if (kind === "wrong_target") a.targets[0]!.recoverableCents = 400;
    if (kind === "cash") a.movements[0]!.toAccount = "1000";
    if (kind === "invoice_evidence")
      a.eligibilityEvidence = [f.a.lines[0]!.tax!.facts.tax];
    if (kind === "stale_source") a.eligibilityEvidence[0]!.source.revision++;
    if (kind === "wrong_original") a.originalApprovalId = "wrong";
    if (kind === "over_capacity") a.movements[0]!.from.amountCents = 771;
    if (kind === "closed_period")
      await f.t.run(async (ctx) => {
        const p = (await ctx.db.query("periods").collect()).find(
          (p) => p.period === "2026-10",
        )!;
        await ctx.db.patch(p._id, { status: "closed" });
      });
    await expect(f.proposeTax(a)).rejects.toThrow();
    expect((await f.state()).journals).toHaveLength(1);
  });
  it("rechecks changed accounting state and current distinct reviewers at the final vote", async () => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const action = await f.adjustment(385, [
      {
        from: { ...s.buckets[0]!, amountCents: 385 },
        toAccount: "5000",
        toTreatment: "expense",
      },
    ]);
    const a = await f.proposeTax(action, "compete-a"),
      b = await f.proposeTax(action, "compete-b");
    await f.approveTax(a);
    await expect(f.approveTax(b)).rejects.toThrow(/stale_tax_snapshot/);
    expect((await f.state()).journals).toHaveLength(2);
    const s2 = await f.taxState();
    const move = s2.buckets.find((b) => b.treatment === "expense")!;
    const p = await f.proposeTax(
      await f.adjustment(385, [
        { from: move, toAccount: "1200", toTreatment: "inventory" },
      ]),
      "review-alias",
    );
    for (const who of ["owner", "finance"])
      await f.humans[who]!.mutation(vote, {
        scope: f.scope,
        input: {
          actionId: p.actionId,
          actionHash: p.actionHash,
          idempotencyKey: who,
          outcome: "approved",
          reason: "Exact independent review",
        },
      });
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "human-second",
      )!;
      await ctx.db.patch(row._id, { status: "retired" });
    });
    await expect(
      f.humans.second!.mutation(vote, {
        scope: f.scope,
        input: {
          actionId: p.actionId,
          actionHash: p.actionHash,
          idempotencyKey: "retired",
          outcome: "approved",
          reason: "Cannot approve",
        },
      }),
    ).rejects.toThrow();
    expect((await f.state()).journals).toHaveLength(2);
  });
  it.each(["disabled", "jurisdiction"])(
    "holds an unsupported %s policy without inferring eligibility",
    async (kind) => {
      const f = await fixture();
      await f.changePolicy(
        5000,
        kind !== "disabled",
        kind === "jurisdiction" ? "OTHER-SYNTHETIC" : undefined,
      );
      const s = await f.taxState();
      await expect(
        f.proposeTax(
          await f.adjustment(385, [
            {
              from: { ...s.buckets[0]!, amountCents: 385 },
              toAccount: "5000",
              toTreatment: "expense",
            },
          ]),
        ),
      ).rejects.toThrow(/tax_target/);
    },
  );
  it("serializes competing final votes and exposes only authenticated tax inventory", async () => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const action = await f.adjustment(385, [
      {
        from: { ...s.buckets[0]!, amountCents: 385 },
        toAccount: "5000",
        toTreatment: "expense",
      },
    ]);
    const a = await f.proposeTax(action, "race-a"),
      b = await f.proposeTax(action, "race-b");
    for (const p of [a, b])
      for (const who of ["owner", "finance"])
        await f.humans[who]!.mutation(vote, {
          scope: f.scope,
          input: {
            actionId: p.actionId,
            actionHash: p.actionHash,
            idempotencyKey: `${p.actionId}-${who}`,
            outcome: "approved",
            reason: "Independent current approval",
          },
        });
    const results = await Promise.allSettled(
      [a, b].map((p) =>
        f.humans.second!.mutation(vote, {
          scope: f.scope,
          input: {
            actionId: p.actionId,
            actionHash: p.actionHash,
            idempotencyKey: `${p.actionId}-tax`,
            outcome: "approved",
            reason: "Final independent tax review",
          },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.state()).journals).toHaveLength(2);
    const ref = makeFunctionReference<"query">("apClose:taxState");
    expect(
      (
        await f.humans.owner!.query(ref, {
          scope: f.scope,
          originalEntryId: f.entry._id,
        })
      ).adjusted,
    ).toBe(true);
    await expect(
      f.t.query(ref, { scope: f.scope, originalEntryId: f.entry._id }),
    ).rejects.toThrow();
  });
  it("rejects double use of a tax cent through an intermediate movement destination", async () => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const from = { ...s.buckets[0]!, amountCents: 385 };
    const action = await f.adjustment(385, [
      { from, toAccount: "5000", toTreatment: "expense" },
      {
        from: { ...from, account: "5000", treatment: "expense" },
        toAccount: "1200",
        toTreatment: "inventory",
      },
    ]);
    await expect(f.proposeTax(action)).rejects.toThrow(/tax_capacity/);
    expect((await f.state()).journals).toHaveLength(1);
  });
  it("uses cumulative latest-adjustment rounding for repeated one-cent credits", async () => {
    const f = await fixture();
    await f.changePolicy(3333);
    const s = await f.taxState();
    await f.approveTax(
      await f.proposeTax(
        await f.adjustment(257, [
          {
            from: { ...s.buckets[0]!, amountCents: 513 },
            toAccount: "5000",
            toTreatment: "expense",
          },
        ]),
      ),
    );
    for (const n of [1, 2, 3]) {
      const c = await f.credit(
        f.original.proposalId,
        `CENT-${n}`,
        0,
        1,
        "tax_adjustment",
      );
      c.plan.taxReversal = f.reversal(await f.taxState(), 1);
      await f.approve(await c.propose());
    }
    expect(
      (await f.state()).credits.map((c) =>
        c.allocations
          .filter((a: any) => a.treatment === "tax")
          .reduce((n: number, a: any) => n + a.amountCents, 0),
      ),
    ).toEqual([0, 1, 0]);
    const final = await f.taxState();
    expect(final.lines[0]!.creditedTaxCents).toBe(3);
    expect(final.lines[0]!.creditedRecoverableCents).toBe(1);
  });
  it("detects tampered posted corrections rather than trusting a saved approval", async () => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    const p = await f.proposeTax(
      await f.adjustment(385, [
        {
          from: { ...s.buckets[0]!, amountCents: 385 },
          toAccount: "5000",
          toTreatment: "expense",
        },
      ]),
    );
    await f.approveTax(p);
    await f.t.run(async (ctx) => {
      const j = (await ctx.db.query("journalEntries").collect())[1]!;
      await ctx.db.patch(j._id, {
        lines: j.lines.map((l) => ({
          ...l,
          debit: l.debit ? l.debit + 1 : 0,
          credit: l.credit ? l.credit + 1 : 0,
        })),
      });
    });
    await expect(f.taxState()).rejects.toThrow(/cost_journal_changed/);
    await expect(
      f.t.run((ctx) =>
        loadApprovedCloseExport(ctx, f.scope, { actionId: p.actionId }),
      ),
    ).rejects.toThrow(/close_export_journal/);
  });
  it("reserves tax-bearing cost against ordinary reclassification and checks explicit reversal proportions", async () => {
    const f = await fixture();
    await f.changePolicy(5000);
    const s = await f.taxState();
    await f.approveTax(
      await f.proposeTax(
        await f.adjustment(385, [
          {
            from: { ...s.buckets[0]!, amountCents: 385 },
            toAccount: "5000",
            toTreatment: "expense",
          },
        ]),
      ),
    );
    await expect(
      f.t.mutation(f.close, {
        ...f.controller,
        input: {
          idempotencyKey: "consume-tax-cost",
          action: {
            kind: "adjustment",
            originalEntryId: f.entry._id,
            fromAccount: "5000",
            toAccount: "1200",
            amountCents: 8085,
            store: "sf-hayes-valley",
            date: "2026-10-19",
            evidence: f.proof,
            reason: "Cannot move reserved tax via ordinary cost route",
          },
        },
      }),
    ).rejects.toThrow(/adjustment_exceeds_original/);
    const c = await f.credit(
      f.original.proposalId,
      "WRONG-POOL",
      0,
      385,
      "tax_adjustment",
    );
    const current = await f.taxState();
    c.plan.taxReversal = {
      snapshotHash: current.snapshotHash,
      allocations: [current.buckets.find((b) => b.treatment === "tax")!],
      reason: "Wrong all-recovery portion",
    };
    await expect(c.propose()).rejects.toThrow(/tax_reversal_proportion/);
    c.plan.taxReversal = f.reversal(current, 385);
    await f.approve(await c.propose());
    expect((await f.taxState()).lines[0]!.remainingTaxCents).toBe(385);
  });
});
