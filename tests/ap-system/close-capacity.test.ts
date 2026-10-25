import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { businessFixture, acceptance, binding, br } from "./business-fixture";
import type {
  CloseAction,
  Accrual,
  PeriodView,
} from "../../src/ap-system/close-contracts";
import type { SourceDocument } from "../../src/ap-system/contracts";
const refs = Object.fromEntries(
  [
    "retainEvidence",
    "proposeStatement",
    "reviewStatement",
    "propose",
    "vote",
  ].map((n) => [n, makeFunctionReference<"mutation">(`apClose:${n}`)]),
);
const viewRef = makeFunctionReference<"query">("apClose:view"),
  exportRef = makeFunctionReference<"query">("apClose:accountingExport");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function setup(recognize = true) {
  const f = await businessFixture(),
    recognized = recognize ? await f.recognize() : null;
  let n = 0;
  async function retain(text: string, kind: SourceDocument["kind"] = "other") {
    const source = structuredClone(f.input.documents[0]!);
    Object.assign(source, {
      sourceId: `v5-close-${++n}`,
      deliveryId: `v5-delivery-${n}`,
      name: `v5-${n}.txt`,
      kind,
      mimeType: "text/plain",
      extractedText: text,
      originalBase64: Buffer.from(text).toString("base64"),
      byteLength: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    return f.t.mutation(refs.retainEvidence!, { ...f.controller, source });
  }
  const proof = await retain(
    "V5 independent synthetic opening: cash accounts 1000,1010,1020 zero; AP and accrued zero",
  );
  const view = () =>
    f.humans.finance!.query(viewRef, {
      scope: f.scope,
      period: "2026-10",
    }) as Promise<PeriodView>;
  const propose = (action: CloseAction) =>
    f.t.mutation(refs.propose!, {
      ...f.controller,
      input: { action, idempotencyKey: `v5-propose-${++n}` },
    });
  const vote = (p: any, name: string) =>
    f.humans[name]!.mutation(refs.vote!, {
      scope: f.scope,
      input: {
        actionId: p.actionId,
        actionHash: p.actionHash,
        idempotencyKey: `v5-vote-${p.actionId}-${name}`,
        outcome: "approved",
        reason: "Independent exact synthetic source and amount review",
      },
    });
  async function approve(action: CloseAction) {
    const p = await propose(action);
    let result: any;
    for (const s of p.route)
      result = await vote(
        p,
        s.groupId === "govern"
          ? "governor"
          : s.groupId === "owner"
            ? "owner"
            : "finance",
      );
    return { p, result };
  }
  async function reviewStatement() {
    const source = await retain(
      "V5 supplier statement: original GS-1042 outstanding 7700 cents",
    );
    const p = await f.t.mutation(refs.proposeStatement!, {
      ...f.controller,
      idempotencyKey: `v5-statement-${++n}`,
      statement: {
        supplierId: f.supplier.supplierId,
        period: "2026-10",
        source,
        openingCents: 0,
        closingCents: 7700,
        lines: [
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
    await f.humans.finance!.mutation(refs.reviewStatement!, {
      scope: f.scope,
      input: {
        ...p,
        snapshotHash: (await view()).reconciliationHash,
        idempotencyKey: `v5-statement-review-${++n}`,
        reason: "All original statement movements agree",
        resolutions: [],
      },
    });
  }
  async function close() {
    const v = await view();
    return approve({
      kind: "close",
      period: v.period,
      snapshotHash: v.snapshotHash,
      opening: {
        ...v.opening,
        evidence: [proof],
        reason: "Compared retained bank and ledger opening",
      },
      reason: "Close only fully accounted source evidence",
    });
  }
  const accrual = (): Accrual => ({
    supplierId: f.supplier.supplierId,
    source: binding(f.input.documents[2]!),
    lineId: "receipt-line-1",
    sku: "KALE-24",
    unit: "case",
    description: "Two cases received",
    quantity: "2",
    capacityQuantity: "2",
    unitPriceCents: 3850,
    allocations: structuredClone(f.input.candidate!.lines[0]!.allocations),
    date: "2026-10-31",
    expectedInvoiceCaseId: f.detail.caseId,
    quote: f.input.documents[2]!.extractedText,
    reason: "Retain exact received obligation",
  });
  const exported = (input: any) =>
    f.humans.finance!.query(exportRef, { scope: f.scope, input });
  return {
    ...f,
    recognized,
    proof,
    retain,
    view,
    proposeClose: propose,
    voteClose: vote,
    approveClose: approve,
    reviewStatement,
    close,
    accrual,
    exported,
  };
}
describe("Standalone receipt close capacity regression", () => {
  it.each(["partial", "fully_reversed"] as const)(
    "does not close a standalone two-unit receipt after %s accrual without accounting for remaining units",
    async (mode) => {
      const f = await setup();
      const quote =
        "V5 standalone receipt: supplier Golden State delivered 2 KALE-24 case at 3850 cents each on October 30; neither unit invoiced";
      const source = await f.retain(quote, "receipt");
      const accrual = {
        ...f.accrual(),
        source,
        lineId: "standalone-line",
        expectedInvoiceCaseId: null,
        quote,
        quantity: mode === "partial" ? "1" : "2",
      };
      accrual.allocations[0]!.amountCents = mode === "partial" ? 3850 : 7700;
      const a = await f.approveClose({ kind: "accrual", accrual });
      if (mode === "fully_reversed")
        await f.approveClose({
          kind: "reverse_accrual",
          accrualId: a.result.accrualId,
          quantity: "2",
          date: "2026-10-31",
          evidence: [source],
          reason:
            "Explicit reversal does not itself declare original received units a non-obligation",
        });
      await f.reviewStatement();
      // Attempt the actual close, not merely an asserted UI blocker.
      await expect(f.close()).rejects.toThrow(
        /close_not_ready|received_not_invoiced/,
      );
      expect((await f.view()).status).toBe("open");
    },
  );
  it("permits full outstanding coverage and preserves unpaid bill carryforward", async () => {
    const f = await setup();
    const quote = "Standalone two-unit receipt fully accrued for 7700 cents";
    const source = await f.retain(quote, "receipt");
    await f.approveClose({
      kind: "accrual",
      accrual: {
        ...f.accrual(),
        source,
        lineId: "standalone-line",
        expectedInvoiceCaseId: null,
        quote,
      },
    });
    await f.reviewStatement();
    await f.close();
    const view = await f.view();
    expect(view.status).toBe("closed");
    expect(view.unpaidBills).toEqual([
      expect.objectContaining({ outstandingCents: 7700 }),
    ]);
    expect(view.reconciliation).toMatchObject({
      apGLCents: 7700,
      apSubledgerCents: 7700,
      accruedGLCents: 7700,
      accruedSubledgerCents: 7700,
    });
  });
});
