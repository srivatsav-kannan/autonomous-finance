import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Accrual } from "../../src/ap-system/close-contracts";
import { acceptance, cr, syncPrimary } from "./business-fixture";
import {
  originalLines,
  physicalFixture,
  physicalPacket,
} from "./physical-accrual-fixture";

type Fixture = Awaited<ReturnType<typeof physicalFixture>>;
const coverageCodes = new Set([
  "received_source_conflict", "received_not_invoiced",
  "received_overrecognized", "source_line_identity",
]);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function mappedNovemberReceipt() {
  const input = physicalPacket("november-invoice");
  input.candidate!.invoiceDate = "2026-11-02";
  syncPrimary(input);
  const f = await physicalFixture(input);
  const mapping = await f.mapping();
  await f.approveMapping(mapping);
  return { f, reviewId: mapping.reviewId };
}
function accrual(f: Fixture, reviewId: string, id: "north" | "south", quantity?: string): Accrual {
  const capacity = id === "north" ? "0.5" : "1.5";
  return {
    supplierId: f.supplier.supplierId,
    source: f.input.purchasingEvidence[1]!.source,
    lineId: f.input.purchasingEvidence[1]!.lines.find(l => l.lineId.endsWith(id))!.lineId,
    sku: "KALE-24", unit: "case", description: `Original ${id} receipt`,
    quantity: quantity ?? capacity, capacityQuantity: capacity, unitPriceCents: 3850,
    allocations: acceptance(f.input, quantity ?? capacity).lines[0]!.allocations,
    date: "2026-10-31", expectedInvoiceCaseId: f.detail.caseId,
    quote: originalLines[id === "north" ? 0 : 1]!,
    reason: "Retain the exact physical capacity before the later invoice",
    identity: { reviewId, physicalLineId: id },
  };
}
async function closeOctober(f: Fixture) {
  const proof = await f.retain("Independent original opening: cash1000=0 cash1010=0 cash1020=0 AP=0 accrued=0");
  const v = await f.view();
  return f.approveClose({
    kind: "close", period: "2026-10", snapshotHash: v.snapshotHash,
    opening: { ...v.opening, evidence: [proof], reason: "Opening compared with original evidence" },
    reason: "Reviewed October reconciliation and complete received capacity",
  });
}

describe("V9 physical accrual boundaries", () => {
  it("rejects another valid supplier without creating an accrual or journal", async () => {
    const { f, reviewId } = await mappedNovemberReceipt();
    const contact = await f.humans.verifier!.mutation(cr.registerTrustedContact!, {
      scope: f.scope, idempotencyKey: "other-contact", supplierId: "other-supplier",
      phone: "+14155550777", evidence: f.proof, mode: "simulated",
    });
    await f.onboard({ ...f.supplier, supplierId: "other-supplier", legalName: "Other Supplier", contactId: contact.contactId }, "other-supplier");
    const before = await f.snapshot();
    await expect(f.approveClose({ kind: "accrual", accrual: {
      ...accrual(f, reviewId, "north"), supplierId: "other-supplier", expectedInvoiceCaseId: null,
    } })).rejects.toThrow(/physical_accrual_supplier/);
    expect(await f.snapshot()).toEqual(before);
  });

  it("closes October with both physical lines accrued and keeps exact cents", async () => {
    const { f, reviewId } = await mappedNovemberReceipt();
    await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "north") });
    await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "south") });
    const view = await f.view();
    expect(view.blockers.filter(b => coverageCodes.has(b.code))).toEqual([]);
    expect(view.reconciliation).toMatchObject({ apGLCents: 0, apSubledgerCents: 0, accruedGLCents: 7700, accruedSubledgerCents: 7700 });
    const state = await f.snapshot();
    expect(state.bills).toHaveLength(0);
    expect(state.accruals.map(a => a.amountCents).sort((a, b) => a - b)).toEqual([1925, 5775]);
    const net = (account: string) => state.journals.flatMap(j => j.lines).filter(l => l.account === account).reduce((n, l) => n + l.debit - l.credit, 0);
    expect(net("5000")).toBe(7700);
    expect(net("2010")).toBe(-7700);
    expect(net("2000")).toBe(0);
    await closeOctober(f);
    expect((await f.view()).status).toBe("closed");
  });

  it.each(["missing", "partial", "reversed"] as const)("keeps an out-of-period %s sibling blocked", async (condition) => {
    const { f, reviewId } = await mappedNovemberReceipt();
    await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "north") });
    if (condition !== "missing") {
      const south = await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "south", condition === "partial" ? "0.5" : "1.5") });
      if (condition === "reversed") await f.approveClose({ kind: "reverse_accrual", accrualId: south.result.accrualId, quantity: "1.5", date: "2026-10-31", evidence: [f.input.purchasingEvidence[1]!.source], reason: "Reversed estimate leaves the original receipt unresolved" });
    }
    const blockers = (await f.view()).blockers.filter(b => coverageCodes.has(b.code));
    expect(blockers).toEqual([expect.objectContaining({ code: "received_not_invoiced", reference: expect.stringContaining('"south"') })]);
    await expect(closeOctober(f)).rejects.toThrow(/close_not_ready/);
  });

  it("holds a historical wrong-supplier accrual rather than treating it as physical coverage", async () => {
    const { f, reviewId } = await mappedNovemberReceipt();
    const north = await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "north") });
    await f.approveClose({ kind: "accrual", accrual: accrual(f, reviewId, "south") });
    await f.t.run(async ctx => {
      const row = (await ctx.db.query("apAccruals").collect()).find(a => a._id === north.result.accrualId)!;
      await ctx.db.patch(row._id, { supplierId: "other-supplier", payload: { ...row.payload, supplierId: "other-supplier" } });
    });
    expect((await f.view()).blockers).toContainEqual(expect.objectContaining({ code: "received_source_conflict" }));
    await expect(closeOctober(f)).rejects.toThrow(/close_not_ready/);
  });
});
