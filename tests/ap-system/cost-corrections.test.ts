import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import type { APIntake } from "../../src/ap-system/contracts";
import type { CloseAction, Accrual } from "../../src/ap-system/close-contracts";
import type {
  CostCorrection,
  CorrectedCostAllocation,
  CostState,
} from "../../src/ap-system/cost-contracts";
import type { CreditPlan } from "../../src/ap-system/domain-contracts";
import {
  businessFixture,
  acceptance,
  binding,
  syncPrimary,
  br,
} from "./business-fixture";
import { packet } from "./accounting-fixture";
const closeRefs = Object.fromEntries(
  ["propose", "vote"].map((n) => [
    n,
    makeFunctionReference<"mutation">(`apClose:${n}`),
  ]),
);
const costRef = makeFunctionReference<"query">("apClose:costState"),
  exportRef = makeFunctionReference<"query">("apClose:accountingExport"),
  creditExportRef = makeFunctionReference<"query">("apBusinessExports:current");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup(input = packet(), recognize = true) {
  const f = await businessFixture({ input });
  const accepted = acceptance(input);
  accepted.lines[0]!.allocations = structuredClone(
    input.candidate!.lines[0]!.allocations,
  );
  accepted.freightCents = input.candidate!.freightCents;
  accepted.freightAllocations = structuredClone(
    input.candidate!.freightAllocations,
  );
  accepted.discountCents = input.candidate!.discountCents;
  accepted.discountAllocations = structuredClone(
    input.candidate!.discountAllocations,
  );
  const original = recognize ? await f.recognize(f.detail, accepted) : null;
  let n = 0;
  const proof = binding(input.documents[1]!);
  const cost = (id = original!.entryId) =>
    f.humans.finance!.query(costRef, {
      scope: f.scope,
      originalEntryId: id,
    }) as Promise<CostState>;
  const proposeClose = (action: CloseAction) =>
    f.t.mutation(closeRefs.propose!, {
      ...f.controller,
      input: { action, idempotencyKey: `cost-close-${++n}` },
    });
  const voteClose = (p: any, name: string) =>
    f.humans[name]!.mutation(closeRefs.vote!, {
      scope: f.scope,
      input: {
        ...p,
        idempotencyKey: `cost-vote-${p.actionId}-${name}`,
        outcome: "approved",
        reason: "Explicit current cost and source review",
      },
    });
  async function approveClose(action: CloseAction) {
    const p = await proposeClose(action);
    let result: any;
    for (const stage of p.route)
      result = await voteClose(
        p,
        stage.groupId === "owner"
          ? "owner"
          : stage.groupId === "govern"
            ? "governor"
            : "finance",
      );
    return { ...result, proposal: p };
  }
  const adjustment = (
    amount = 4000,
    from = "5000",
    to = "1200",
    entry = original!.entryId,
  ): CloseAction => ({
    kind: "adjustment",
    originalEntryId: entry,
    date: "2026-10-31",
    fromAccount: from,
    toAccount: to,
    amountCents: amount,
    store: "sf-hayes-valley",
    evidence: [proof],
    reason: "Reviewed correction of original cost classification",
  });
  const allocation = (
    account: string,
    amountCents: number,
    index = 0,
    line = "line-1",
    side: "credit" | "debit" = "credit",
  ): CorrectedCostAllocation => ({
    originalLineId: line,
    allocationIndex: index,
    account,
    store: "sf-hayes-valley",
    treatment:
      account === "5000"
        ? "expense"
        : account === "1300"
          ? "prepayment"
          : "inventory",
    side,
    amountCents,
  });
  const correction = async (
    allocations: CorrectedCostAllocation[],
    entry = original!.entryId,
  ): Promise<CostCorrection> => ({
    snapshotHash: (await cost(entry)).snapshotHash,
    allocations,
    evidence: [proof],
    reason: "Compared corrected cost balances with original allocation shares",
  });
  async function credit(
    options: {
      net?: number;
      tax?: number;
      discount?: number;
      quantityReturn?: boolean;
    } = {},
  ) {
    const net = options.net ?? 3850,
      tax = options.tax ?? 0,
      discount = options.discount ?? 0;
    const next = packet(`CORRECTED-CREDIT-${++n}`),
      c = next.candidate!;
    c.kind = "credit_note";
    next.documents[0]!.kind = "credit_note";
    Object.assign(c.lines[0]!, {
      unitPriceCents: net,
      amountCents: net,
      taxCents: tax,
    });
    c.lines[0]!.quantity.decimal = "1";
    c.lines[0]!.allocations[0]!.amountCents = net + tax;
    c.subtotalCents = net;
    c.taxCents = tax;
    c.totalCents = net + tax - discount;
    c.discountCents = discount;
    c.discountAllocations = discount
      ? [{ ...c.lines[0]!.allocations[0]!, amountCents: discount }]
      : [];
    if (options.quantityReturn) {
      const doc = next.documents[2]!,
        body = `Unique approved returned case ${n}`;
      Object.assign(doc, {
        extractedText: body,
        originalBase64: Buffer.from(body).toString("base64"),
        byteLength: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      next.purchasingEvidence[1]!.source = binding(doc);
      next.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
    }
    syncPrimary(next);
    const detail = await f.reviewed(next);
    const plan: CreditPlan = {
      originalCaseId: f.detail.caseId,
      originalApprovalId: original!.proposal.proposalId,
      freightCents: 0,
      discountCents: discount,
      lines: [
        {
          creditLineId: "line-1",
          originalLineId: "line-1",
          basis: options.quantityReturn
            ? "quantity_return"
            : "price_adjustment",
          quantity: options.quantityReturn ? "1" : "0",
          netCents: net,
          taxCents: tax,
          returnEvidence: options.quantityReturn
            ? [binding(next.documents[2]!)]
            : [],
        },
      ],
      reason: "Explicit supplier credit linked to original recognized invoice",
    };
    const propose = (correction?: CostCorrection, date = "2026-10-31") =>
      f.t.mutation(br.propose!, {
        ...f.ap,
        input: {
          caseId: detail.caseId,
          expectedRevision: detail.revision,
          snapshotHash: detail.snapshotHash,
          idempotencyKey: `credit-proposal-${++n}`,
          policyVersion: f.policy.version,
          supplierRevision: 1,
          accountingDate: date,
          credit: { ...plan, ...(correction ? { correction } : {}) },
        },
      });
    return { detail, plan, propose };
  }
  const approveCredit = async (p: any) => {
    let result = await f.vote(p);
    if (result.status === "pending") result = await f.vote(p, "finance");
    return result;
  };
  const accrual = (): Accrual => ({
    supplierId: f.supplier.supplierId,
    source: binding(input.documents[2]!),
    lineId: "receipt-line-1",
    sku: "KALE-24",
    unit: "case",
    description: "Received two cases awaiting invoice",
    quantity: "2",
    capacityQuantity: "2",
    unitPriceCents: 3850,
    allocations: structuredClone(input.candidate!.lines[0]!.allocations),
    date: "2026-10-31",
    expectedInvoiceCaseId: f.detail.caseId,
    quote: input.documents[2]!.extractedText,
    reason: "Review received accrual",
  });
  return {
    ...f,
    original,
    proof,
    cost,
    proposeClose,
    voteClose,
    approveClose,
    adjustment,
    allocation,
    correction,
    credit,
    approveCredit,
    accrual,
  };
}
describe("Governed corrected cost allocation", () => {
  it("reverses exact corrected cost for linked returns, retains original journals and adds variance approval", async () => {
    const f = await setup(),
      before = await f.t.run((ctx) => ctx.db.get(f.original!.entryId));
    await f.approveClose(f.adjustment());
    const c = await f.credit({ quantityReturn: true });
    await expect(c.propose()).rejects.toThrow(/credit_classification_changed/);
    const p = await c.propose(
      await f.correction([
        f.allocation("1200", 3000),
        f.allocation("5000", 850),
      ]),
    );
    expect(p.route.map((r: any) => r.groupId)).toEqual(["owner", "finance"]);
    const result = await f.approveCredit(p);
    expect(await f.vote(p, "finance")).toEqual(result);
    const exported = await f.humans.finance!.query(creditExportRef, {
      scope: f.scope,
      caseId: c.detail.caseId,
    });
    expect(exported.recognized.allocations).toEqual([
      { account: "1200", amountCents: 3000, store: "sf-hayes-valley" },
      { account: "5000", amountCents: 850, store: "sf-hayes-valley" },
    ]);
    expect(await f.t.run((ctx) => ctx.db.get(f.original!.entryId))).toEqual(
      before,
    );
    const second = await f.credit({ quantityReturn: true });
    await f.approveCredit(
      await second.propose(
        await f.correction([
          f.allocation("1200", 1000),
          f.allocation("5000", 2850),
        ]),
      ),
    );
    expect((await f.cost()).positions.every((x) => x.balanceCents === 0)).toBe(
      true,
    );
    const rows = await f.t.run(async (ctx) => ({
      bills: await ctx.db.query("demoBills").collect(),
      journals: await ctx.db.query("journalEntries").collect(),
      commands: await ctx.db.query("demoCommands").collect(),
    }));
    expect(rows.bills).toHaveLength(1);
    expect(rows.journals).toHaveLength(4);
    expect(rows.commands).toHaveLength(0);
    expect(
      rows.journals
        .flatMap((j) => j.lines)
        .filter((l) => l.account === "2000")
        .reduce((n, l) => n + l.credit - l.debit, 0),
    ).toBe(0);
  });
  it("rejects stale, unmapped, overdrawn, wrong-side and cross-store allocations without posting", async () => {
    const f = await setup();
    await f.approveClose(f.adjustment());
    const c = await f.credit();
    const good = await f.correction([f.allocation("1200", 3850)]);
    for (const [change, error] of [
      [{ snapshotHash: "0".repeat(64) }, /stale_cost_snapshot/],
      [{ allocations: [f.allocation("1300", 3850)] }, /cost_correction_path/],
      [{ allocations: [f.allocation("5000", 3850)] }, /cost_capacity_exceeded/],
      [
        { allocations: [{ ...f.allocation("1200", 3850), store: null }] },
        /cost_original_share/,
      ],
      [
        { allocations: [{ ...f.allocation("1200", 3850), side: "debit" }] },
        /cost_original_share/,
      ],
      [{ allocations: [f.allocation("1200", 3849)] }, /cost_original_share/],
      [{ allocations: [f.allocation("1200", 3850, 1)] }, /cost_original_share/],
      [
        {
          allocations: [
            { ...f.allocation("1200", 3850), treatment: "expense" },
          ],
        },
        /cost_correction_account/,
      ],
    ] as const)
      await expect(
        c.propose({ ...good, ...change } as CostCorrection),
      ).rejects.toThrow(error);
    await expect(c.propose(good, "2026-10-30")).rejects.toThrow(
      /cost_correction_date/,
    );
    await expect(
      f.t.query(costRef, {
        scope: f.scope,
        originalEntryId: f.original!.entryId,
      }),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(2);
  });
  it("revalidates concurrent credit and reclassification capacity at final approval", async () => {
    const f = await setup();
    await f.approveClose(f.adjustment());
    const a = await f.credit(),
      b = await f.credit();
    const corrected = await f.correction([f.allocation("1200", 3850)]);
    const pa = await a.propose(corrected),
      pb = await b.propose(corrected);
    await f.vote(pa);
    await f.vote(pb);
    await f.vote(pa, "finance");
    await expect(f.vote(pb, "finance")).rejects.toThrow(/stale_cost_snapshot/);
    const next = await b.propose(
      await f.correction([
        f.allocation("1200", 150),
        f.allocation("5000", 3700),
      ]),
    );
    await f.vote(next);
    await f.approveClose(f.adjustment(1000, "5000", "1200"));
    await expect(f.vote(next, "finance")).rejects.toThrow(
      /stale_cost_snapshot/,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(1);
  });
  it("supports reviewed correction chains while refusing a correction journal as a new capacity root", async () => {
    const f = await setup();
    const first = await f.approveClose(f.adjustment(4000));
    const second = await f.approveClose(f.adjustment(2000, "1200", "1300"));
    await expect(
      f.proposeClose(f.adjustment(1, "1200", "1300", first.entryId)),
    ).rejects.toThrow(/cost_original_required/);
    const c = await f.credit();
    await f.approveCredit(
      await c.propose(
        await f.correction([
          f.allocation("1300", 2000),
          f.allocation("1200", 1850),
        ]),
      ),
    );
    const exp = await f.humans.finance!.query(exportRef, {
      scope: f.scope,
      input: { actionId: second.actionId },
    });
    expect(exp.accounting).toMatchObject({
      kind: "cost_reclassification",
      originalEntryId: f.original!.entryId,
      journal: {
        lines: [
          { account: "1300", debit: 2000, credit: 0 },
          { account: "1200", debit: 0, credit: 2000 },
        ],
      },
    });
    expect((await f.cost()).positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account: "1200", balanceCents: 150 }),
        expect.objectContaining({ account: "1300", balanceCents: 0 }),
      ]),
    );
  });
  it("preserves exact tax and original allocation rounding across successive corrected credits", async () => {
    const input = packet(),
      c = input.candidate!;
    c.lines[0]!.taxCents = 770;
    c.taxCents = 770;
    c.totalCents = 8470;
    c.lines[0]!.allocations = [
      { ...c.lines[0]!.allocations[0]!, amountCents: 4235 },
      {
        ...c.lines[0]!.allocations[0]!,
        account: "1200",
        treatment: "inventory",
        amountCents: 4235,
      },
    ];
    syncPrimary(input);
    const f = await setup(input);
    await f.approveClose(f.adjustment(4235, "5000", "1300"));
    for (const [first, second] of [
      [2118, 2117],
      [2117, 2118],
    ]) {
      const credit = await f.credit({ tax: 385 });
      await f.approveCredit(
        await credit.propose(
          await f.correction([
            f.allocation("1300", first!, 0),
            f.allocation("1200", second!, 1),
          ]),
        ),
      );
    }
    expect((await f.cost()).positions.every((x) => x.balanceCents === 0)).toBe(
      true,
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(2);
  });
  it("retains signed discount reversals without creating another AP obligation or cash journal", async () => {
    const input = packet(),
      c = input.candidate!;
    c.discountCents = 770;
    c.totalCents = 6930;
    c.discountAllocations = [
      { ...c.lines[0]!.allocations[0]!, amountCents: 770 },
    ];
    syncPrimary(input);
    const f = await setup(input);
    await f.approveClose(f.adjustment(1000));
    const credit = await f.credit({ net: 7700, discount: 770 });
    await f.approveCredit(
      await credit.propose(
        await f.correction([
          f.allocation("1200", 1000),
          f.allocation("5000", 6700),
          f.allocation("5000", 770, 0, "discount", "debit"),
        ]),
      ),
    );
    const exported = await f.humans.finance!.query(creditExportRef, {
      scope: f.scope,
      caseId: credit.detail.caseId,
    });
    expect(exported.recognized.allocations).toEqual([
      { account: "1200", amountCents: 1000, store: "sf-hayes-valley" },
      { account: "5000", amountCents: 6700, store: "sf-hayes-valley" },
      { account: "5000", amountCents: -770, store: "sf-hayes-valley" },
    ]);
    expect(exported.recognized.amountCents).toBe(6930);
    expect((await f.cost()).positions.every((x) => x.balanceCents === 0)).toBe(
      true,
    );
  });
  it("corrects accrued cost and requires exact reviewed reversal shares, including partial rounding", async () => {
    const f = await setup(packet(), false);
    const accrued = f.accrual();
    accrued.allocations = [
      { ...accrued.allocations[0]!, amountCents: 3851 },
      {
        ...accrued.allocations[0]!,
        account: "1200",
        treatment: "inventory",
        amountCents: 3849,
      },
    ];
    const a = await f.approveClose({ kind: "accrual", accrual: accrued });
    await f.approveClose(f.adjustment(3851, "5000", "1300", a.entryId));
    const reversal: CloseAction = {
      kind: "reverse_accrual",
      accrualId: a.accrualId,
      quantity: "1",
      date: "2026-10-31",
      evidence: [f.proof],
      reason: "Explicit corrected partial reversal",
    };
    await expect(f.proposeClose(reversal)).rejects.toThrow(
      /accrual_classification_changed/,
    );
    for (const [left, right] of [
      [1926, 1924],
      [1925, 1925],
    ]) {
      const corrected = await f.correction(
        [
          f.allocation("1300", left!, 0, "accrual"),
          f.allocation("1200", right!, 1, "accrual"),
        ],
        a.entryId,
      );
      const result = await f.approveClose({
        ...reversal,
        correction: corrected,
      });
      const ex = await f.humans.finance!.query(exportRef, {
        scope: f.scope,
        input: { actionId: result.actionId },
      });
      expect(ex.accounting.journal.lines).toEqual([
        expect.objectContaining({ account: "2010", debit: 3850, credit: 0 }),
        expect.objectContaining({ account: "1300", debit: 0, credit: left }),
        expect.objectContaining({ account: "1200", debit: 0, credit: right }),
      ]);
    }
    expect(
      (await f.cost(a.entryId)).positions.every((x) => x.balanceCents === 0),
    ).toBe(true);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoBills").collect()),
    ).toHaveLength(0);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(4);
  });
  it("reverses corrected accrual atomically with invoice recognition and rejects stale pending reversal", async () => {
    const f = await setup(packet(), false);
    const a = await f.approveClose({ kind: "accrual", accrual: f.accrual() });
    await f.approveClose(f.adjustment(7700, "5000", "1200", a.entryId));
    const corrected = await f.correction(
      [f.allocation("1200", 7700, 0, "accrual")],
      a.entryId,
    );
    const stale = await f.proposeClose({
      kind: "reverse_accrual",
      accrualId: a.accrualId,
      quantity: "2",
      date: "2026-10-31",
      evidence: [f.proof],
      reason: "Competing full reversal",
      correction: corrected,
    });
    await f.voteClose(stale, "owner");
    const args = {
      ...f.ap,
      input: {
        caseId: f.detail.caseId,
        expectedRevision: f.detail.revision,
        snapshotHash: f.detail.snapshotHash,
        idempotencyKey: "corrected-invoice",
        policyVersion: f.policy.version,
        supplierRevision: 1,
        accountingDate: "2026-10-31",
        acceptance: acceptance(f.input),
        accrualApplications: [
          { accrualId: a.accrualId, quantity: "2", correction: corrected },
        ],
      },
    };
    const p = await f.t.mutation(br.propose!, args);
    await f.vote(p);
    const bill = await f.vote(p, "finance");
    await expect(f.voteClose(stale, "finance")).rejects.toThrow(
      /reversal_excess|stale_cost_snapshot/,
    );
    const apps = await f.t.run((ctx) =>
      ctx.db.query("apAccrualApplications").collect(),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.allocations).toEqual([
      expect.objectContaining({
        account: "1200",
        amountCents: 7700,
        originalAllocationIndex: 0,
      }),
    ]);
    const ex = await f.humans.finance!.query(exportRef, {
      scope: f.scope,
      input: { accrualApplicationId: apps[0]!._id },
    });
    expect(ex.accounting).toMatchObject({
      billId: bill.billId,
      amountCents: 7700,
      approval: { id: p.proposalId, kind: "business" },
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(4);
  });
  it("keeps original accrual allocation indexes when one share is split across corrected accounts", async () => {
    const f = await setup(packet(), false),
      accrual = f.accrual();
    accrual.allocations = [
      { ...accrual.allocations[0]!, amountCents: 3851 },
      {
        ...accrual.allocations[0]!,
        account: "1200",
        treatment: "inventory",
        amountCents: 3849,
      },
    ];
    const a = await f.approveClose({ kind: "accrual", accrual });
    await f.approveClose(f.adjustment(1000, "5000", "1300", a.entryId));
    const action: CloseAction = {
      kind: "reverse_accrual",
      accrualId: a.accrualId,
      quantity: "1",
      date: "2026-10-31",
      evidence: [f.proof],
      reason: "Reviewed allocation split",
    };
    await f.approveClose({
      ...action,
      correction: await f.correction(
        [
          f.allocation("1300", 1000, 0, "accrual"),
          f.allocation("5000", 926, 0, "accrual"),
          f.allocation("1200", 1924, 1, "accrual"),
        ],
        a.entryId,
      ),
    });
    expect(
      (await f.cost(a.entryId)).originalShares.map((a) => a.remainingCents),
    ).toEqual([1925, 1925]);
    await f.approveClose({
      ...action,
      correction: await f.correction(
        [
          f.allocation("5000", 1925, 0, "accrual"),
          f.allocation("1200", 1925, 1, "accrual"),
        ],
        a.entryId,
      ),
    });
    expect(
      (await f.cost(a.entryId)).positions.every((a) => a.balanceCents === 0),
    ).toBe(true);
    expect(
      (await f.cost(a.entryId)).originalShares.every(
        (a) => a.remainingCents === 0,
      ),
    ).toBe(true);
  });
  it("requires retained voters to remain current before corrected-credit recognition", async () => {
    const f = await setup();
    await f.approveClose(f.adjustment());
    const credit = await f.credit();
    const p = await credit.propose(
      await f.correction([f.allocation("1200", 3850)]),
    );
    await f.vote(p);
    await f.t.run(async (ctx) => {
      const seat = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "human-owner",
      )!;
      await ctx.db.patch(seat._id, { status: "retired" });
    });
    await expect(f.vote(p, "finance")).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(0);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(2);
  });
  it("fails closed when the original or correction journal changes after its immutable hash", async () => {
    const f = await setup();
    const changed = await f.approveClose(f.adjustment());
    const credit = await f.credit();
    const correction = await f.correction([f.allocation("1200", 3850)]);
    await f.t.run((ctx) =>
      ctx.db.patch(changed.entryId as Id<"journalEntries">, {
        memo: "Mutated correction",
      }),
    );
    await expect(credit.propose(correction)).rejects.toThrow(
      /cost_journal_changed/,
    );
    await expect(f.cost()).rejects.toThrow(/cost_journal_changed/);
    expect(
      await f.t.run((ctx) => ctx.db.query("demoCredits").collect()),
    ).toHaveLength(0);
  });
});
