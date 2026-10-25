import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import {
  businessFixture,
  acceptance,
  binding,
  syncPrimary,
  br,
} from "./business-fixture";
import { packet, refs } from "./accounting-fixture";
import { openFakeBank } from "../../src/integrations/banking/fake";
import { ExecutePaymentEffect } from "../../src/payments/application/execute-payment-effect";
import { ReconcilePaymentEvidence } from "../../src/payments/application/reconcile-payment-evidence";
import { createConvexPaymentKernel } from "../../src/payments/adapters/convex-payment-kernel";
import { createConvexPaymentEvidence } from "../../src/payments/adapters/convex-payment-evidence";
import type { KernelTransport } from "../../src/payments/adapters/convex-transport";
import { api } from "../../convex/_generated/api";
import { appendDemoEntry } from "../../convex/lib/demoPost";
import { accountingSeat } from "../../convex/lib/demoAuth";
import type {
  Accrual,
  CloseAction,
  PeriodView,
} from "../../src/ap-system/close-contracts";
import type { SourceDocument } from "../../src/ap-system/contracts";
const closeRefs = Object.fromEntries(
  [
    "retainEvidence",
    "proposeStatement",
    "reviewStatement",
    "propose",
    "vote",
  ].map((n) => [n, makeFunctionReference<"mutation">(`apClose:${n}`)]),
);
const viewRef = makeFunctionReference<"query">("apClose:view");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup(recognize = true) {
  const f = await businessFixture();
  const recognized = recognize ? await f.recognize() : null;
  let n = 0;
  function source(text: string, kind: SourceDocument["kind"] = "other") {
    const d = structuredClone(f.input.documents[0]!);
    d.sourceId = `close-source-${++n}`;
    d.deliveryId = d.sourceId;
    d.name = `${d.sourceId}.txt`;
    d.kind = kind;
    d.mimeType = "text/plain";
    d.extractedText = text;
    d.originalBase64 = Buffer.from(text).toString("base64");
    d.byteLength = Buffer.byteLength(text);
    d.sha256 = createHash("sha256").update(text).digest("hex");
    return d;
  }
  async function retain(text: string, kind: SourceDocument["kind"] = "other") {
    const d = source(text, kind);
    return f.t.mutation(closeRefs.retainEvidence!, {
      ...f.controller,
      source: d,
    });
  }
  const proof = await retain(
    "Independently retained opening bank/ledger statement:1000=0;1010=0;1020=0;AP=0;accrued=0",
  );
  const view = (period = "2026-10") =>
    f.humans.finance!.query(viewRef, { scope: f.scope, period }) as Promise<
      PeriodView & { actions: any[]; statementRecords: any[] }
    >;
  async function propose(action: CloseAction, key = `action-${++n}`) {
    return f.t.mutation(closeRefs.propose!, {
      ...f.controller,
      input: { idempotencyKey: key, action },
    });
  }
  async function vote(
    p: { actionId: string; actionHash: string },
    name = "governor",
    key = `vote-${p.actionId}-${name}`,
  ) {
    return f.humans[name]!.mutation(closeRefs.vote!, {
      scope: f.scope,
      input: {
        ...p,
        idempotencyKey: key,
        outcome: "approved",
        reason: "Independently reviewed exact source and period evidence",
      },
    });
  }
  async function approve(action: CloseAction, key?: string) {
    const p = await propose(action, key);
    let result: any;
    for (const step of p.route) {
      const name =
        step.groupId === "govern"
          ? "governor"
          : step.groupId === "owner"
            ? "owner"
            : "finance";
      result = await vote(p, name);
    }
    return { p, result };
  }
  async function statement(closing = 7700, lines?: any[]) {
    const v = await view();
    const own = await retain(
      `Supplier statement golden-state-produce closing ${closing}`,
    );
    const proposed = await f.t.mutation(closeRefs.proposeStatement!, {
      ...f.controller,
      idempotencyKey: `statement-${++n}`,
      statement: {
        supplierId: f.supplier.supplierId,
        period: "2026-10",
        source: own,
        openingCents: 0,
        closingCents: closing,
        lines: lines ?? [
          {
            lineId: "s1",
            date: "2026-10-19",
            reference: "GS-1042",
            amountCents: 7700,
            match: { kind: "bill", id: recognized!.billId },
          },
        ],
      },
    });
    return { proposed, view: v };
  }
  async function review(
    s: Awaited<ReturnType<typeof statement>>,
    resolutions: any[] = [],
  ) {
    const v = await view();
    return f.humans.finance!.mutation(closeRefs.reviewStatement!, {
      scope: f.scope,
      input: {
        ...s.proposed,
        snapshotHash: v.reconciliationHash,
        idempotencyKey: `review-${++n}`,
        reason: "Matched each original statement line and closing balance",
        resolutions,
      },
    });
  }
  async function closeAction() {
    const v = await view();
    return {
      kind: "close" as const,
      period: v.period,
      snapshotHash: v.snapshotHash,
      opening: {
        ...v.opening,
        evidence: [proof],
        reason: "Verified opening balances against independent original",
      },
      reason: "Period close with unpaid recognized liabilities carried forward",
    };
  }
  function accrual(): Accrual {
    return {
      supplierId: f.supplier.supplierId,
      source: binding(f.input.documents[2]!),
      lineId: "receipt-line-1",
      sku: "KALE-24",
      unit: "case",
      description: "Received two kale cases, invoice still under review",
      quantity: "2",
      capacityQuantity: "2",
      unitPriceCents: 3850,
      allocations: structuredClone(f.input.candidate!.lines[0]!.allocations),
      date: "2026-10-31",
      expectedInvoiceCaseId: f.detail.caseId,
      quote: f.input.documents[2]!.extractedText,
      reason: "Received goods must remain in period-end liabilities",
    };
  }
  return {
    ...f,
    recognized,
    source,
    retain,
    proof,
    view,
    proposeClose: propose,
    voteClose: vote,
    approveClose: approve,
    statement,
    reviewStatement: review,
    closeAction,
    accrual,
  };
}
describe("B4 close and supplier statements", () => {
  it("closes reconciled unpaid AP with an independently reviewed opening and statement, preserving carryforward", async () => {
    const f = await setup();
    let v = await f.view();
    expect(v.unpaidBills[0]).toMatchObject({
      recognizedCents: 7700,
      outstandingCents: 7700,
      cashCents: 0,
    });
    expect(v.reconciliation).toMatchObject({
      apGLCents: 7700,
      apSubledgerCents: 7700,
      differenceCents: 0,
    });
    expect(v.blockers.map((b) => b.code)).toContain(
      "supplier_statement_review",
    );
    const s = await f.statement();
    await f.reviewStatement(s);
    v = await f.view();
    expect(v.ready).toBe(true);
    const action = await f.closeAction();
    const result = await f.approveClose(action);
    expect(result.result.periodStatus).toBe("closed");
    expect(await f.voteClose(result.p)).toEqual(result.result);
    expect((await f.view()).history).toHaveLength(1);
    expect(
      (await f.view()).actions.find((a) => a._id === result.p.actionId).result
        .closeSnapshot.unpaidBills[0].outstandingCents,
    ).toBe(7700);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(1);
  });
  it("rejects unmatched statement differences until evidence-backed human resolutions, and malformed arithmetic is never waived", async () => {
    const f = await setup();
    const s = await f.statement(7800, [
      {
        lineId: "s1",
        date: "2026-10-19",
        reference: "GS-1042",
        amountCents: 7800,
        match: { kind: "bill", id: f.recognized!.billId },
      },
    ]);
    await expect(f.reviewStatement(s)).rejects.toThrow(/difference_review/);
    const v = await f.view();
    const differences = v.statements.find(
      (x) => x.statementId === s.proposed.statementId,
    )!.discrepancies;
    expect(differences.map((d) => d.discrepancyId)).toEqual([
      "amount:s1",
      "closing",
    ]);
    await f.reviewStatement(
      s,
      differences.map((d) => ({
        discrepancyId: d.discrepancyId,
        classification: "supplier_error",
        reason:
          "Supplier statement contains unsupported extra100cents; original invoice and confirmation retained",
        evidence: [f.proof],
      })),
    );
    expect((await f.view()).ready).toBe(true);
    const malformed = await f.statement(7900);
    await expect(f.reviewStatement(malformed)).rejects.toThrow(
      /statement_structure/,
    );
  });
  it("does not assume zero opening balances or bypass B4 through legacy close", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    const a = await f.closeAction();
    await expect(
      f.proposeClose({ ...a, opening: { ...a.opening, apCents: 1 } }),
    ).rejects.toThrow(/opening_balance_mismatch/);
    await expect(
      f.human.mutation(api.demoEvidence.signClose, {
        scope: f.scope,
        period: "2026-10",
      }),
    ).rejects.toThrow(/requires apClose/);
    await expect(
      f.t.query(viewRef, { scope: f.scope, period: "2026-10" }),
    ).rejects.toThrow(/human/);
  });
  it("changed journals invalidate a close proposal and expose AP/GL difference", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    const p = await f.proposeClose(await f.closeAction());
    await f.t.run(async (ctx) => {
      const posted = await appendDemoEntry(ctx, {
        runId: f.scope.runId,
        seat: accountingSeat(f.scope.runId),
        date: "2026-10-31",
        memo: "adversarial unexplained AP",
        source: { kind: "test_unexplained" },
        lines: [
          { account: "5000", debit: 100, credit: 0 },
          { account: "2000", debit: 0, credit: 100 },
        ],
        idempotencyKey: "extra",
      });
      expect(posted.ok).toBe(true);
    });
    await expect(f.voteClose(p)).rejects.toThrow(/close_not_ready/);
    const v = await f.view();
    expect(v.reconciliation.differenceCents).toBe(100);
    expect(v.blockers.map((b) => b.code)).toContain("ap_gl_difference");
  });
  it("locks posting and requires an exact independently approved reopen before adjustment", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    const closed = await f.approveClose(await f.closeAction());
    const action: CloseAction = {
      kind: "adjustment",
      originalEntryId: f.recognized!.entryId,
      date: "2026-10-31",
      fromAccount: "5000",
      toAccount: "1200",
      amountCents: 7700,
      store: "sf-hayes-valley",
      evidence: [f.proof],
      reason: "Reviewed inventory classification correction",
    };
    const p = await f.proposeClose(action);
    await f.voteClose(p, "owner");
    await expect(f.voteClose(p, "finance")).rejects.toThrow(/period_closed/);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(1);
    await f.approveClose({
      kind: "reopen",
      period: "2026-10",
      closeActionId: closed.p.actionId,
      evidence: [f.proof],
      reason: "Approved correction to historical cost classification",
    });
    await f.voteClose(p, "finance");
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(2);
    expect((await f.view()).reconciliation.differenceCents).toBe(0);
    await expect(f.proposeClose({ ...action, amountCents: 1 })).rejects.toThrow(
      /exceeds_original/,
    );
  });
});
describe("B4 received but unbilled accruals", () => {
  it("recognizes accrued cost before invoice, carries it through close, and reverses exactly once atomically with later invoice", async () => {
    const f = await setup(false);
    expect((await f.view()).blockers.map((b) => b.code)).toContain(
      "received_not_invoiced",
    );
    const accrued = await f.approveClose({
      kind: "accrual",
      accrual: f.accrual(),
    });
    let v = await f.view();
    expect(v.reconciliation).toMatchObject({
      apGLCents: 0,
      accruedGLCents: 7700,
      accruedSubledgerCents: 7700,
    });
    expect(v.ready).toBe(true);
    await f.approveClose(await f.closeAction());
    await f.t.run((ctx) =>
      ctx.db.insert("periods", {
        runId: f.scope.runId,
        period: "2026-11",
        status: "open",
      }),
    );
    const next = structuredClone(f.input);
    const d = await f.get(f.detail.caseId);
    const lateAcceptance = acceptance(next);
    lateAcceptance.lines[0]!.allocations[0]!.period = "2026-11";
    await expect(f.propose(d, acceptance(next))).rejects.toThrow(
      /accrual_reversal_date|accrual_application_required/,
    );
    const proposal = await f.t.mutation(br.propose!, {
      ...f.ap,
      input: {
        caseId: d.caseId,
        expectedRevision: d.revision,
        snapshotHash: d.snapshotHash,
        idempotencyKey: "apply-accrual",
        policyVersion: f.policy.version,
        supplierRevision: 1,
        accountingDate: "2026-11-02",
        acceptance: lateAcceptance,
        accrualApplications: [
          { accrualId: accrued.result.accrualId, quantity: "2" },
        ],
      },
    });
    await f.vote(proposal);
    const approved = await f.vote(proposal, "finance");
    expect(await f.vote(proposal, "finance")).toEqual(approved);
    expect(
      await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toHaveLength(3);
    v = await f.view("2026-11");
    expect(v.reconciliation).toMatchObject({
      apGLCents: 7700,
      accruedGLCents: 0,
      accruedSubledgerCents: 0,
    });
    expect((await f.view()).reconciliation.accruedGLCents).toBe(7700);
  });
  it("prevents duplicate accrual units and bounds explicit partial reversal", async () => {
    const f = await setup(false);
    const result = await f.approveClose({
      kind: "accrual",
      accrual: f.accrual(),
    });
    await expect(
      f.proposeClose({ kind: "accrual", accrual: f.accrual() }),
    ).rejects.toThrow(/accrual_units_used/);
    const reversed = await f.approveClose({
      kind: "reverse_accrual",
      accrualId: result.result.accrualId,
      quantity: "1",
      date: "2026-10-31",
      evidence: [f.proof],
      reason: "One unit confirmed not owing",
    });
    expect(reversed.result.entryId).toBeTruthy();
    expect((await f.view()).accruals[0]).toMatchObject({
      amountCents: 7700,
      reversedCents: 3850,
      outstandingCents: 3850,
    });
    await expect(
      f.proposeClose({
        kind: "reverse_accrual",
        accrualId: result.result.accrualId,
        quantity: "2",
        date: "2026-10-31",
        evidence: [f.proof],
        reason: "excess",
      }),
    ).rejects.toThrow(/reversal_excess/);
    expect((await f.view()).blockers.map((b) => b.code)).toContain(
      "received_not_invoiced",
    );
  });
  it("tracks standalone receipt originals and restricts supported dispositions to source blockers", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    await f.retain(
      "Uninvoiced service completed October30, approval pending",
      "receipt",
    );
    const v = await f.view();
    const blocker = v.blockers.find((b) => b.code === "received_not_invoiced")!;
    expect(blocker).toBeTruthy();
    await expect(
      f.proposeClose({
        kind: "disposition",
        period: "2026-10",
        reference: "2000",
        snapshotHash: v.reconciliationHash,
        classification: "not_obligation",
        evidence: [f.proof],
        reason: "cannot waive AP difference",
      }),
    ).rejects.toThrow(/disposition_binding/);
    await f.approveClose({
      kind: "disposition",
      period: "2026-10",
      reference: blocker.reference,
      snapshotHash: v.reconciliationHash,
      classification: "future_period",
      evidence: [f.proof],
      reason:
        "Independently confirmed service belongs to next period; original evidence retained",
    });
    expect(
      (await f.view()).blockers.some((b) => b.reference === blocker.reference),
    ).toBe(false);
  });
});

describe("B4 adversarial period boundaries", () => {
  it("reclassifies only cost remaining after a linked return and holds later credit allocations changed by that correction", async () => {
    const f = await setup();
    async function credit(reference: string) {
      const next = packet(reference),
        candidate = next.candidate!;
      candidate.kind = "credit_note";
      next.documents[0]!.kind = "credit_note";
      candidate.lines[0]!.quantity.decimal = "1";
      candidate.lines[0]!.amountCents = 3850;
      candidate.lines[0]!.allocations[0]!.amountCents = 3850;
      candidate.subtotalCents = 3850;
      candidate.totalCents = 3850;
      next.documents[2] = f.source(
        `Return ${reference}: KALE-24 one case accepted by receiver October31`,
        "receipt",
      );
      next.purchasingEvidence[1]!.source = binding(next.documents[2]!);
      next.purchasingEvidence[1]!.lines[0]!.quantity.decimal = "1";
      syncPrimary(next);
      const detail = await f.reviewed(next);
      return f.t.mutation(br.propose!, {
        ...f.ap,
        input: {
          caseId: detail.caseId,
          expectedRevision: detail.revision,
          snapshotHash: detail.snapshotHash,
          idempotencyKey: `credit-${reference}`,
          policyVersion: f.policy.version,
          supplierRevision: 1,
          credit: {
            originalCaseId: f.detail.caseId,
            originalApprovalId: f.recognized!.proposal.proposalId,
            freightCents: 0,
            discountCents: 0,
            lines: [
              {
                creditLineId: "line-1",
                originalLineId: "line-1",
                basis: "quantity_return",
                quantity: "1",
                netCents: 3850,
                taxCents: 0,
                returnEvidence: [binding(next.documents[2]!)],
              },
            ],
            reason: "Documented returned unit",
          },
        },
      });
    }
    await f.vote(await credit("CLOSE-RETURN-1"));
    const action = {
      kind: "adjustment" as const,
      originalEntryId: f.recognized!.entryId,
      date: "2026-10-31",
      fromAccount: "5000",
      toAccount: "1200",
      amountCents: 7700,
      store: "sf-hayes-valley",
      evidence: [f.proof],
      reason: "Reclassify retained unreturned goods",
    };
    await expect(f.proposeClose(action)).rejects.toThrow(/exceeds_original/);
    await f.approveClose({ ...action, amountCents: 3850 });
    await expect(credit("CLOSE-RETURN-2")).rejects.toThrow(
      /credit_classification_changed/,
    );
    expect((await f.view()).reconciliation.differenceCents).toBe(0);
  });

  it("requires the actual nonzero opening cash balance from all prior periods", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      const period = await ctx.db.insert("periods", {
        runId: f.scope.runId,
        period: "2026-09",
        status: "open",
      });
      const journal = await appendDemoEntry(ctx, {
        runId: f.scope.runId,
        seat: accountingSeat(f.scope.runId),
        date: "2026-09-30",
        memo: "Opening owner funding fixture",
        source: {
          kind: "bank_match",
          ref: "synthetic-prior-opening-bank-statement",
        },
        lines: [
          { account: "1000", debit: 1000000, credit: 0 },
          { account: "3000", debit: 0, credit: 1000000 },
        ],
        idempotencyKey: "opening-funded-cash",
      });
      if (!journal.ok) throw Error(journal.error);
      await ctx.db.patch(period, { status: "closed" });
    });
    await f.reviewStatement(await f.statement());
    const action = await f.closeAction();
    expect(
      action.opening.cashBalances.find((x) => x.account === "1000")!
        .balanceCents,
    ).toBe(1000000);
    await expect(
      f.proposeClose({
        ...action,
        opening: {
          ...action.opening,
          cashBalances: action.opening.cashBalances.map((x) => ({
            ...x,
            balanceCents: 0,
          })),
        },
      }),
    ).rejects.toThrow(/opening_balance_mismatch/);
    await f.approveClose(action);
  });

  it("holds copied accrual originals despite renamed parser lines or changed SKU interpretation", async () => {
    const f = await setup(false);
    await f.approveClose({ kind: "accrual", accrual: f.accrual() });
    const original = structuredClone(f.input.documents[2]!);
    original.sourceId += "-copy";
    original.deliveryId += "-copy";
    const copied = await f.t.mutation(closeRefs.retainEvidence!, {
      ...f.controller,
      source: original,
    });
    await expect(
      f.proposeClose({
        kind: "accrual",
        accrual: { ...f.accrual(), source: copied, lineId: "renumbered" },
      }),
    ).rejects.toThrow(/accrual_units_used/);
    await expect(
      f.proposeClose({
        kind: "accrual",
        accrual: {
          ...f.accrual(),
          source: copied,
          lineId: "renumbered",
          sku: "CHARD-24",
        },
      }),
    ).rejects.toThrow(/accrual_source_conflict/);
  });
  it("applies an explicit partial accrual with the invoice and leaves only unrecognized residual units", async () => {
    const f = await setup(false),
      a = f.accrual();
    a.quantity = "1";
    a.allocations[0]!.amountCents = 3850;
    const accrued = await f.approveClose({ kind: "accrual", accrual: a });
    const input = {
      caseId: f.detail.caseId,
      expectedRevision: f.detail.revision,
      snapshotHash: f.detail.snapshotHash,
      idempotencyKey: "partial-accrual-invoice",
      policyVersion: f.policy.version,
      supplierRevision: 1,
      accountingDate: "2026-10-31",
      acceptance: acceptance(f.input, "1"),
      accrualApplications: [
        { accrualId: accrued.result.accrualId, quantity: "1" },
      ],
    };
    const proposal = await f.t.mutation(br.propose!, { ...f.ap, input });
    await f.vote(proposal);
    await f.vote(proposal, "finance");
    expect((await f.get(f.detail.caseId)).candidate!.invoiceDate).toBe(
      "2026-10-19",
    );
    const view = await f.view();
    expect(view.reconciliation).toMatchObject({
      apGLCents: 3850,
      apSubledgerCents: 3850,
      accruedGLCents: 0,
    });
    expect(view.blockers.some((b) => b.code === "received_not_invoiced")).toBe(
      true,
    );
    await f.approveClose({
      kind: "accrual",
      accrual: { ...a, expectedInvoiceCaseId: null },
    });
    expect((await f.view()).reconciliation.accruedGLCents).toBe(3850);
  });
  it("reverses every allocated accrual cent once and prevents reversal before original accounting date", async () => {
    const f = await setup(false),
      a = f.accrual();
    a.allocations = [
      { ...a.allocations[0]!, amountCents: 3851 },
      {
        ...a.allocations[0]!,
        account: "1200",
        treatment: "inventory",
        amountCents: 3849,
      },
    ];
    const accrued = await f.approveClose({ kind: "accrual", accrual: a });
    const action = {
      kind: "reverse_accrual" as const,
      accrualId: accrued.result.accrualId,
      quantity: "1",
      date: "2026-10-30",
      evidence: [f.proof],
      reason: "Reviewed reversal",
    };
    await expect(f.proposeClose(action)).rejects.toThrow(/reversal_date/);
    for (let i = 0; i < 2; i++)
      await f.approveClose({ ...action, date: "2026-10-31" });
    const applications = await f.t.run((ctx) =>
      ctx.db.query("apAccrualApplications").collect(),
    );
    expect(
      applications.map((x) =>
        x.allocations.map((a: { amountCents: number }) => a.amountCents),
      ),
    ).toEqual([
      [1926, 1924],
      [1925, 1925],
    ]);
    expect((await f.view()).reconciliation.accruedGLCents).toBe(0);
  });
  it("requires complete statement movements even when omitted bill and credit offset to zero", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      const result = await appendDemoEntry(ctx, {
        runId: f.scope.runId,
        seat: accountingSeat(f.scope.runId),
        date: "2026-10-20",
        memo: "Legacy credit fixture",
        source: { kind: "vendor_credit", ref: "LEGACY-CREDIT" },
        lines: [
          { account: "2000", debit: 7700, credit: 0 },
          { account: "5000", debit: 0, credit: 7700 },
        ],
        idempotencyKey: "legacy-credit-fixture",
      });
      if (!result.ok) throw Error(result.error);
      await ctx.db.insert("demoCredits", {
        scope: f.scope,
        vendor: f.supplier.supplierId,
        reference: "LEGACY-CREDIT",
        amountCents: 7700,
        reservedCents: 0,
        consumedCents: 0,
        evidence: "legacy retained original",
        date: "2026-10-20",
        expenseAccount: "5000",
        entryId: result.entryId,
        createdAt: Date.now(),
      });
    });
    const statement = await f.statement(0, []);
    await expect(f.reviewStatement(statement)).rejects.toThrow(
      /difference_review/,
    );
    expect(
      (await f.view()).statements
        .find((s) => s.statementId === statement.proposed.statementId)!
        .discrepancies.map((d) => d.discrepancyId.split(":")[0]),
    ).toEqual(["missing", "missing"]);
  });
  it("carries unpaid prior-period AP and blocks reopening an earlier period beneath a later close", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    const october = await f.approveClose(await f.closeAction());
    await f.t.run((ctx) =>
      ctx.db.insert("periods", {
        runId: f.scope.runId,
        period: "2026-11",
        status: "open",
      }),
    );
    vi.setSystemTime(new Date("2026-11-30T20:00:00Z"));
    const source = await f.retain(
      "November supplier statement opening7700 closing7700, no movements",
    );
    const statement = await f.t.mutation(closeRefs.proposeStatement!, {
      ...f.controller,
      idempotencyKey: "nov-statement",
      statement: {
        supplierId: f.supplier.supplierId,
        period: "2026-11",
        source,
        openingCents: 7700,
        closingCents: 7700,
        lines: [],
      },
    });
    let view = await f.view("2026-11");
    expect(view.opening.apCents).toBe(7700);
    await f.humans.finance!.mutation(closeRefs.reviewStatement!, {
      scope: f.scope,
      input: {
        ...statement,
        snapshotHash: view.reconciliationHash,
        idempotencyKey: "nov-review",
        reason: "Verified carried opening and no supplier movements",
        resolutions: [],
      },
    });
    view = await f.view("2026-11");
    await f.approveClose({
      kind: "close",
      period: view.period,
      snapshotHash: view.snapshotHash,
      opening: {
        ...view.opening,
        evidence: [f.proof],
        reason: "Reviewed prior closed GL opening",
      },
      reason: "Carry unpaid October payable",
    });
    await expect(
      f.proposeClose({
        kind: "reopen",
        period: "2026-10",
        closeActionId: october.p.actionId,
        evidence: [f.proof],
        reason: "Must reopen later period first",
      }),
    ).rejects.toThrow(/later_period_closed/);
  });
  it("keeps a late closed-period bank posting as an owned exception until approved reopen", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    const closed = await f.approveClose(await f.closeAction());
    const prepared = await f.t.mutation(
      makeFunctionReference<"mutation">("apCasePayments:request"),
      {
        scope: f.scope,
        seatId: "payments",
        token: "token-payments",
        caseId: f.detail.caseId,
        expectedRevision: f.detail.revision,
        snapshotHash: f.detail.snapshotHash,
        idempotencyKey: "late-bank",
      },
    );
    await f.human.mutation(api.demoPayments.approveAndQueue, {
      scope: f.scope,
      versionId: prepared.versionId,
      snapshotHash: prepared.snapshotHash,
    });
    const bank = openFakeBank({
      path: ":memory:",
      scope: f.scope,
      seed: "locked-close",
      startTime: new Date(Date.now()).toISOString(),
    });
    try {
      const transport = f.t as unknown as KernelTransport;
      let n = 0;
      const worker = new ExecutePaymentEffect(
        createConvexPaymentKernel(transport, f.scope, "test-dispatch"),
        bank.provider,
        "close-worker",
        {
          now: Date.now,
          newLeaseToken: () => `close-period-worker-lease-${++n}`,
          startHeartbeat: () => () => {},
        },
      );
      const reconciler = new ReconcilePaymentEvidence(
        createConvexPaymentEvidence(transport, f.scope, "test-evidence"),
        bank.provider,
        f.scope,
        Date.now,
      );
      await worker.tick();
      bank.harness.settle(bank.harness.inspect().transfers[0]!.id);
      await reconciler.tick();
      await reconciler.tick();
      let view = await f.view();
      expect(
        view.blockers.some(
          (b) => b.code === "bank_reconciliation" && b.owner === "treasury",
        ),
      ).toBe(true);
      expect(
        view.blockers.some((b) => b.code === "closed_snapshot_changed"),
      ).toBe(true);
      expect(
        (await f.t.run((ctx) => ctx.db.query("demoTransactions").collect()))[0],
      ).toMatchObject({ state: "exception" });
      expect(
        await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
      ).toHaveLength(1);
      await f.approveClose({
        kind: "reopen",
        period: "2026-10",
        closeActionId: closed.p.actionId,
        evidence: [f.proof],
        reason: "Verified late bank evidence belongs to original period",
      });
      await reconciler.tick();
      await reconciler.tick();
      view = await f.view();
      expect(view.reconciliation).toMatchObject({
        apGLCents: 0,
        apSubledgerCents: 0,
        differenceCents: 0,
      });
      expect(view.statements[0]!.status).toBe("review_required");
      expect(
        await f.t.run((ctx) => ctx.db.query("journalEntries").collect()),
      ).toHaveLength(2);
      expect(bank.harness.inspect().calls.createTransfer).toBe(1);
    } finally {
      bank.close();
    }
  });
  it("retains failed extraction as a source disposition blocker and rejects retired statement reviewers", async () => {
    const f = await setup();
    await f.reviewStatement(await f.statement());
    await f.t.run(async (ctx) => {
      const seat = (await ctx.db.query("seats").collect()).find(
        (s) => s.seatId === "human-finance",
      )!;
      await ctx.db.patch(seat._id, { status: "retired" });
    });
    const view = (await f.humans.governor!.query(viewRef, {
      scope: f.scope,
      period: "2026-10",
    })) as PeriodView;
    expect(view.statements[0]!.status).toBe("review_required");
    const failed = packet("FAILED-CLOSE-SOURCE");
    failed.candidate = null;
    failed.extraction = {
      status: "failed",
      evidence: [],
      reasons: ["Parser unavailable"],
    };
    failed.purchasingEvidence = [];
    const row = await f.t.mutation(refs.ingest, { ...f.ap, input: failed });
    const after = (await f.humans.governor!.query(viewRef, {
      scope: f.scope,
      period: "2026-10",
    })) as PeriodView;
    expect(
      after.blockers.some(
        (b) =>
          b.code === "source_disposition_required" &&
          b.reference === `case:${row.caseId}`,
      ),
    ).toBe(true);
  });
});
