import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import type { CloseAction, Accrual } from "../../src/ap-system/close-contracts";
import type {
  CostCorrection,
  CostState,
} from "../../src/ap-system/cost-contracts";
import {
  businessFixture,
  acceptance,
  binding,
  br,
  cr,
  policy,
  syncPrimary,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
const closePropose = makeFunctionReference<"mutation">("apClose:propose"),
  closeVote = makeFunctionReference<"mutation">("apClose:vote"),
  closeExport = makeFunctionReference<"query">("apClose:accountingExport"),
  businessExport = makeFunctionReference<"query">("apBusinessExports:current"),
  costRef = makeFunctionReference<"query">("apClose:costState");
const coordinates = {
  store: "sf-hayes-valley",
  department: "operations",
  project: "remodel",
};
const dimensionPolicy = () => ({
  ...policy(),
  dimensions: {
    version: "ap-gl-dimensions-v1" as const,
    scope: "cost_allocations" as const,
    departments: ["operations", "sales"],
    projects: ["remodel", "expansion"],
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup(recognize = true, split = false) {
  const f = await businessFixture({ policy: dimensionPolicy() });
  const accepted = acceptance(f.input);
  Object.assign(accepted.lines[0]!.allocations[0]!, coordinates);
  if (split) {
    accepted.lines[0]!.allocations[0]!.amountCents = 3850;
    accepted.lines[0]!.allocations.push({
      ...accepted.lines[0]!.allocations[0]!,
      department: "sales",
      project: "expansion",
    });
  }
  const original = recognize ? await f.recognize(f.detail, accepted) : null;
  let n = 0;
  const evidence = [binding(f.input.documents[1]!)];
  const propose = (action: CloseAction) =>
    f.t.mutation(closePropose, {
      ...f.controller,
      input: { action, idempotencyKey: `dim-close-${++n}` },
    });
  async function approve(action: CloseAction) {
    const p = await propose(action);
    let r: any;
    for (const stage of p.route)
      r = await f.humans[
        stage.groupId === "govern" ? "governor" : stage.groupId
      ]!.mutation(closeVote, {
        scope: f.scope,
        input: {
          ...p,
          idempotencyKey: `dim-vote-${p.actionId}-${stage.groupId}`,
          outcome: "approved",
          reason: "Review exact approved dimensions",
        },
      });
    return r;
  }
  const cost = (entryId = original!.entryId) =>
    f.humans.finance!.query(costRef, {
      scope: f.scope,
      originalEntryId: entryId,
    }) as Promise<CostState>;
  const adjustment = (
    amountCents = 2000,
    originalEntryId = original!.entryId,
  ): CloseAction => ({
    kind: "adjustment",
    originalEntryId,
    date: "2026-10-31",
    fromAccount: "5000",
    toAccount: "1200",
    amountCents,
    ...coordinates,
    evidence,
    reason: "Reviewed cost allocation correction",
  });
  async function credit(correction?: CostCorrection) {
    const next = packet(`DIM-CREDIT-${++n}`),
      c = next.candidate!;
    c.kind = "credit_note";
    next.documents[0]!.kind = "credit_note";
    c.lines[0]!.quantity.decimal = "1";
    c.lines[0]!.amountCents = 3850;
    c.lines[0]!.allocations[0]!.amountCents = 3850;
    c.subtotalCents = 3850;
    c.totalCents = 3850;
    syncPrimary(next);
    const detail = await f.reviewed(next);
    const p = await f.t.mutation(br.propose!, {
      ...f.ap,
      input: {
        caseId: detail.caseId,
        expectedRevision: detail.revision,
        snapshotHash: detail.snapshotHash,
        idempotencyKey: `dim-credit-${++n}`,
        policyVersion: f.policy.version,
        supplierRevision: 1,
        accountingDate: "2026-10-31",
        credit: {
          originalCaseId: f.detail.caseId,
          originalApprovalId: original!.proposal.proposalId,
          lines: [
            {
              creditLineId: "line-1",
              originalLineId: "line-1",
              basis: "price_adjustment",
              quantity: "0",
              netCents: 3850,
              taxCents: 0,
              returnEvidence: [],
            },
          ],
          freightCents: 0,
          discountCents: 0,
          reason: "Explicit linked price credit",
          ...(correction ? { correction } : {}),
        },
      },
    });
    let r = await f.vote(p);
    if (r.status === "pending") r = await f.vote(p, "finance");
    return f.humans.finance!.query(businessExport, {
      scope: f.scope,
      caseId: detail.caseId,
    });
  }
  const accrual = (): Accrual => ({
    supplierId: f.supplier.supplierId,
    source: binding(f.input.documents[2]!),
    lineId: "receipt-line-1",
    sku: "KALE-24",
    unit: "case",
    description: "Approved received goods",
    quantity: "2",
    capacityQuantity: "2",
    unitPriceCents: 3850,
    allocations: accepted.lines[0]!.allocations,
    date: "2026-10-31",
    expectedInvoiceCaseId: f.detail.caseId,
    quote: f.input.documents[2]!.extractedText,
    reason: "Explicit cost dimension allocation",
  });
  return {
    ...f,
    proposeInvoice: f.propose,
    accepted,
    original,
    evidence,
    propose,
    approve,
    cost,
    adjustment,
    credit,
    accrual,
  };
}
describe("Governed local cost dimensions", () => {
  it("holds absent policy and unknown dimensions without posting, but retains legacy null behavior", async () => {
    const legacy = await businessFixture();
    const a = acceptance(legacy.input);
    Object.assign(a.lines[0]!.allocations[0]!, coordinates);
    await expect(legacy.propose(legacy.detail, a)).rejects.toThrow(
      /unsupported_dimension/,
    );
    const f = await setup(false);
    for (const dimensions of [
      { department: "unknown" },
      { project: "unknown" },
    ]) {
      const changed = structuredClone(f.accepted);
      Object.assign(changed.lines[0]!.allocations[0]!, dimensions);
      await expect(
        f.proposeInvoice(f.detail, changed, JSON.stringify(dimensions)),
      ).rejects.toThrow(/unknown_department|unknown_project/);
    }
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(0);
    await legacy.recognize();
    const e = await legacy.humans.finance!.query(businessExport, {
      scope: legacy.scope,
      caseId: legacy.detail.caseId,
    });
    expect(e.recognized.allocations).toEqual([
      { account: "5000", amountCents: 7700, store: coordinates.store },
    ]);
  });
  it("retains exact cost dimensions on tax-bearing lines, freight and signed discounts, and rejects changed posted dimensions", async () => {
    const input = packet(),
      c = input.candidate!;
    c.lines[0]!.taxCents = 770;
    c.lines[0]!.allocations[0]!.amountCents = 8470;
    c.taxCents = 770;
    c.freightCents = 100;
    c.discountCents = 70;
    c.totalCents = 8500;
    c.freightAllocations = [
      { ...c.lines[0]!.allocations[0]!, amountCents: 100 },
    ];
    c.discountAllocations = [
      { ...c.lines[0]!.allocations[0]!, amountCents: 70 },
    ];
    syncPrimary(input);
    const f = await businessFixture({ input, policy: dimensionPolicy() });
    const a = acceptance(input);
    a.freightCents = 100;
    a.discountCents = 70;
    a.freightAllocations = structuredClone(c.freightAllocations);
    a.discountAllocations = structuredClone(c.discountAllocations);
    for (const allocation of [
      ...a.lines[0]!.allocations,
      ...a.freightAllocations,
      ...a.discountAllocations,
    ])
      Object.assign(allocation, coordinates);
    const recognized = await f.recognize(f.detail, a);
    const exported = await f.humans.finance!.query(businessExport, {
      scope: f.scope,
      caseId: f.detail.caseId,
    });
    expect(exported.recognized.allocations).toEqual(
      [8470, 100, -70].map((amountCents) => ({
        account: "5000",
        amountCents,
        ...coordinates,
      })),
    );
    await f.t.run(async (ctx) => {
      const j = await ctx.db.get(recognized.entryId as Id<"journalEntries">);
      const lines = structuredClone(j!.lines);
      lines[0]!.dims!.project = "expansion";
      await ctx.db.patch(j!._id, { lines });
    });
    await expect(
      f.humans.finance!.query(businessExport, {
        scope: f.scope,
        caseId: f.detail.caseId,
      }),
    ).rejects.toThrow(/recognition_journal_mismatch/);
  });
  it("partitions capacity across identical account/store with distinct department and project", async () => {
    const f = await setup(true, true);
    const original = await f.t.run((ctx) => ctx.db.get(f.original!.entryId));
    expect((await f.cost()).positions).toEqual(
      expect.arrayContaining([
        { account: "5000", balanceCents: 3850, ...coordinates },
        {
          account: "5000",
          balanceCents: 3850,
          store: coordinates.store,
          department: "sales",
          project: "expansion",
        },
      ]),
    );
    await expect(f.propose(f.adjustment(3851))).rejects.toThrow(
      /adjustment_exceeds_original/,
    );
    await expect(
      f.propose({
        ...f.adjustment(1),
        department: "sales",
        project: "remodel",
      } as CloseAction),
    ).rejects.toThrow(/adjustment_exceeds_original/);
    const adjusted = await f.approve(f.adjustment(2000));
    const e = await f.humans.finance!.query(closeExport, {
      scope: f.scope,
      input: { actionId: adjusted.actionId },
    });
    expect(e.accounting.journal.lines).toEqual([
      {
        account: "1200",
        debit: 2000,
        credit: 0,
        supplierId: f.supplier.supplierId,
        ...coordinates,
      },
      {
        account: "5000",
        debit: 0,
        credit: 2000,
        supplierId: f.supplier.supplierId,
        ...coordinates,
      },
    ]);
    expect(await f.t.run((ctx) => ctx.db.get(f.original!.entryId))).toEqual(
      original,
    );
    expect((await f.cost()).positions).toContainEqual({
      account: "5000",
      balanceCents: 3850,
      store: coordinates.store,
      department: "sales",
      project: "expansion",
    });
  });
  it("retains original credit dimensions and rejects cross-dimension corrected shares", async () => {
    const f = await setup();
    const first = await f.credit();
    expect(first.recognized.allocations).toEqual([
      { account: "5000", amountCents: 3850, ...coordinates },
    ]);
    await f.approve(f.adjustment(2000));
    const correction: CostCorrection = {
      snapshotHash: (await f.cost()).snapshotHash,
      reason: "Exact remaining corrected shares",
      evidence: f.evidence,
      allocations: [
        {
          originalLineId: "line-1",
          allocationIndex: 0,
          account: "1200",
          treatment: "inventory",
          side: "credit",
          amountCents: 2000,
          ...coordinates,
        },
        {
          originalLineId: "line-1",
          allocationIndex: 0,
          account: "5000",
          treatment: "expense",
          side: "credit",
          amountCents: 1850,
          ...coordinates,
        },
      ],
    };
    const wrong = structuredClone(correction);
    wrong.allocations[0]!.project = "expansion";
    await expect(f.credit(wrong)).rejects.toThrow(/cost_original_share/);
    const last = await f.credit(correction);
    expect(last.recognized.allocations).toEqual([
      { account: "1200", amountCents: 2000, ...coordinates },
      { account: "5000", amountCents: 1850, ...coordinates },
    ]);
    expect((await f.cost()).positions.every((a) => a.balanceCents === 0)).toBe(
      true,
    );
  });
  it("preserves accrued dimensions across corrected partial reversals and immutable exports", async () => {
    const f = await setup(false);
    const accrued = await f.approve({ kind: "accrual", accrual: f.accrual() });
    await f.approve(f.adjustment(2000, accrued.entryId));
    const correction: CostCorrection = {
      snapshotHash: (await f.cost(accrued.entryId)).snapshotHash,
      reason: "Exact corrected accrued shares",
      evidence: f.evidence,
      allocations: [
        {
          originalLineId: "accrual",
          allocationIndex: 0,
          account: "1200",
          treatment: "inventory",
          side: "credit",
          amountCents: 2000,
          ...coordinates,
        },
        {
          originalLineId: "accrual",
          allocationIndex: 0,
          account: "5000",
          treatment: "expense",
          side: "credit",
          amountCents: 1850,
          ...coordinates,
        },
      ],
    };
    const reversed = await f.approve({
      kind: "reverse_accrual",
      accrualId: accrued.accrualId,
      quantity: "1",
      date: "2026-10-31",
      reason: "Reviewed partial reversal",
      evidence: f.evidence,
      correction,
    });
    const e = await f.humans.finance!.query(closeExport, {
      scope: f.scope,
      input: { actionId: reversed.actionId },
    });
    expect(e.accounting.journal.lines).toEqual([
      {
        account: "2010",
        debit: 3850,
        credit: 0,
        store: null,
        supplierId: f.supplier.supplierId,
      },
      {
        account: "1200",
        debit: 0,
        credit: 2000,
        supplierId: f.supplier.supplierId,
        ...coordinates,
      },
      {
        account: "5000",
        debit: 0,
        credit: 1850,
        supplierId: f.supplier.supplierId,
        ...coordinates,
      },
    ]);
    expect((await f.cost(accrued.entryId)).positions).toContainEqual({
      account: "5000",
      balanceCents: 3850,
      ...coordinates,
    });
  });
  it("holds new recognition of historical dimensions after the policy is retired", async () => {
    const f = await setup();
    const p = await f.t.mutation(cr.proposePolicy!, {
      ...f.controller,
      idempotencyKey: "retire-dimensions",
      policy: { ...policy(), version: "without-dimensions" },
    });
    const row = await f.t.run((ctx) =>
      ctx.db.get(p.policyId as Id<"apBusinessPolicies">),
    );
    await f.humans.governor!.mutation(cr.activatePolicy!, {
      scope: f.scope,
      policyId: p.policyId,
      expectedHash: row!.hash,
      reason: "Retire extended cost dimensions",
    });
    f.policy.version = "without-dimensions";
    await expect(f.credit()).rejects.toThrow(/credit_dimension_policy/);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(0);
    const exported = await f.humans.finance!.query(businessExport, {
      scope: f.scope,
      caseId: f.detail.caseId,
    });
    expect(exported.recognized.allocations).toEqual([
      { account: "5000", amountCents: 7700, ...coordinates },
    ]);
  });
});
