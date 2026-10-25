import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { api } from "../src/core/kernel-client";
import { legacyKernel } from "./helpers/legacyKernel";

const remitTo = { bank: "Test Bank", accountLast4: "1234", memorySha: "v1" };

async function fixture() {
  const k = legacyKernel();
  await k.init();
  const payments = await k.seat("payments", "payments");
  const controller = await k.seat("controller", "controller");
  const ap = await k.seat("ap-clerk-1", "ap_clerk");
  const cash = await k.seat("cash-app-1", "cash_application");
  const entries = () => k.h.all("journalEntries");
  const balance = (account: string) => k.h.all("balances").filter((b) => b.account === account).reduce((s, b) => s + b.debits - b.credits, 0);
  const reverse = (seat: typeof payments, entryId: Id<"journalEntries">, key: string) =>
    seat.client.mutation(api.ledger.reverseEntry, { ...seat.auth, idempotencyKey: key, entryId, date: "2026-01-03", reason: "correction" });
  return { k, payments, controller, ap, cash, entries, balance, reverse };
}

/** A settled vendor payment, through the real settle mutation. */
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const billId = await f.k.h.seed("bills", {
    runId: f.k.runId, vendor: "vendor-1", invoiceNumber: "1", invoiceDate: "2026-01-02", dueDate: "2026-01-30", totalCents: 1000,
    lines: [], documentEventId: "doc-1", status: "approved", exceptions: [], createdBy: "ap-clerk-1",
  });
  const intentId = await f.k.h.seed("paymentIntents", {
    runId: f.k.runId, payee: "vendor-1", amountCents: 1000, method: "ach", remitTo, billIds: [billId], dueDate: "2026-01-30",
    requestedBy: "payments", approvals: [], requiredApprovals: 1, requiresHuman: false, status: "submitted", idempotencyKey: "pay-1", createdAt: 0,
  });
  const r = await f.payments.client.mutation(api.payments.settlePayment, { ...f.payments.auth, intentId, bankRef: "ACH-1", settledOn: "2026-01-02" });
  if (!r.ok || !("entryId" in r)) throw new Error("settle failed");
  return { billId, intentId, entryId: r.entryId as Id<"journalEntries"> };
}

/** A posted entry with a given source, as older runs or other kernel flows would have written it. */
async function seeded(f: Awaited<ReturnType<typeof fixture>>, kind: string, extra: Partial<Doc<"journalEntries">> = {}) {
  return await f.k.h.seed("journalEntries", {
    runId: f.k.runId, sequence: 100 + f.entries().length, date: "2026-01-02", period: "2026-01", memo: kind, source: { kind, ref: "x" },
    lines: [{ account: "5100", debit: 500, credit: 0 }, { account: "1000", debit: 0, credit: 500 }], totalCents: 500,
    postedBy: "kernel", idempotencyKey: `seed-${kind}-${f.entries().length}`, status: "posted", prevHash: "", hash: "", postedAt: 0, ...extra,
  });
}

describe("ledger.reverseEntry on kernel-created entries", () => {
  it("refuses a payments seat reversing a payment settlement (audit P1-3 reproduction)", async () => {
    const f = await fixture();
    const s = await settled(f);
    const cashBefore = f.balance("1000");
    const r = await f.reverse(f.payments, s.entryId, "rev-settle");
    expect(r).toMatchObject({ ok: false, code: "kernel_entry" });
    expect(f.balance("1000")).toBe(cashBefore);
    expect(f.entries()).toHaveLength(1);
    expect(f.entries()[0]!.status).toBe("posted");
    expect(await f.k.h.ctx.db.get(s.intentId)).toMatchObject({ status: "settled" });
    expect(await f.k.h.ctx.db.get(s.billId)).toMatchObject({ status: "paid" });
    expect(f.k.h.all("violations")).toContainEqual(expect.objectContaining({ seatId: "payments", operation: "ledger.reverseEntry" }));
  });

  it("refuses the controller too: settlements are corrected by a dedicated flow, not a mirror entry", async () => {
    const f = await fixture();
    const s = await settled(f);
    expect(await f.reverse(f.controller, s.entryId, "rev-settle-ctl")).toMatchObject({ ok: false, code: "kernel_entry" });
  });

  it("refuses reversing a bill accrual, which would leave the bill approved with no liability", async () => {
    const f = await fixture();
    await f.k.h.document(f.k.runId);
    const bill = await f.ap.client.mutation(api.ap.recordBill, {
      ...f.ap.auth, idempotencyKey: "bill-1", vendor: "produce", invoiceNumber: "INV-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
      lines: [{ description: "item", quantity: 1, unitCents: 700, amountCents: 700 }], totalCents: 700, documentEventId: "document-1",
      decision: "approve", exceptions: [], expenseAccount: "5000",
    });
    expect(bill.ok).toBe(true);
    const accrual = f.entries().find((e) => e.source.kind === "bill")!;
    expect(await f.reverse(f.ap, accrual._id, "rev-bill")).toMatchObject({ ok: false, code: "kernel_entry" });
    expect(await f.reverse(f.controller, accrual._id, "rev-bill-ctl")).toMatchObject({ ok: false, code: "kernel_entry" });
  });

  it("refuses reversing payroll funding", async () => {
    const f = await fixture();
    const id = await seeded(f, "payroll_funding");
    expect(await f.reverse(f.controller, id, "rev-payroll")).toMatchObject({ ok: false, code: "kernel_entry" });
  });

  it("refuses reversing a reversal of a kernel-created entry", async () => {
    const f = await fixture();
    const root = await seeded(f, "payment_settlement", { status: "reversed" });
    const rev = await seeded(f, "reversal", { reversalOf: root, lines: [{ account: "1000", debit: 500, credit: 0 }, { account: "5100", debit: 0, credit: 500 }] });
    await f.k.h.ctx.db.patch(root, { reversedBy: rev });
    expect(await f.reverse(f.controller, rev, "rev-rev")).toMatchObject({ ok: false, code: "kernel_entry" });
  });

  it("refuses reversing a cash entry that is not a bank match", async () => {
    const f = await fixture();
    const id = await seeded(f, "adjustment");
    expect(await f.reverse(f.controller, id, "rev-cash-adj")).toMatchObject({ ok: false, code: "no_bank_evidence" });
  });

  it("still reverses a non-cash adjustment", async () => {
    const f = await fixture();
    const posted = await f.controller.client.mutation(api.ledger.postEntry, {
      ...f.controller.auth, idempotencyKey: "adj-1", date: "2026-01-02", memo: "accrual", source: { kind: "adjustment" },
      lines: [{ account: "5000", debit: 300, credit: 0 }, { account: "2000", debit: 0, credit: 300 }],
    });
    if (!posted.ok) throw new Error("post failed");
    expect(await f.reverse(f.controller, posted.entryId, "rev-adj")).toMatchObject({ ok: true });
  });
});

describe("ledger.reverseEntry on bank matches (#5)", () => {
  async function bankFixture() {
    const f = await fixture();
    await f.k.h.seed("events", {
      runId: f.k.runId, type: "bank.transaction", externalId: "bank-1", occurredOn: "2026-01-02",
      payload: { account: "deposits", txnId: "bank-1", amountCents: 1_234_00 }, recordedAt: 0,
    });
    const lines = [{ account: "1020", debit: 1_234_00, credit: 0 }, { account: "1100", debit: 0, credit: 1_234_00 }];
    const book = async (key: string) => {
      const r = await f.cash.client.mutation(api.ledger.postEntry, { ...f.cash.auth, idempotencyKey: key, date: "2026-01-02", memo: "match", source: { kind: "bank_match", ref: "bank-1" }, lines });
      return r;
    };
    return { ...f, book };
  }
  const id = (r: unknown) => (r as { entryId: Id<"journalEntries"> }).entryId;

  it("corrects a bank match by reversal, then lets the released transaction be booked again", async () => {
    const f = await bankFixture();
    const first = await f.book("b1");
    expect(first.ok).toBe(true);
    expect(await f.reverse(f.controller, id(first), "r1")).toMatchObject({ ok: true });
    expect(f.balance("1020")).toBe(0);
    expect((await f.book("b2")).ok).toBe(true);
  });

  it("allows reversing that reversal while the bank transaction is still free", async () => {
    const f = await bankFixture();
    const first = await f.book("b1");
    const rev = await f.reverse(f.controller, id(first), "r1");
    expect(await f.reverse(f.controller, id(rev), "r2")).toMatchObject({ ok: true });
    expect(f.balance("1020")).toBe(1_234_00);
    expect((await f.book("b3")).ok).toBe(false);
  });

  it("keeps the control-tests reversal chain working: book, reverse, rebook, reverse, reverse again", async () => {
    const f = await bankFixture();
    const first = await f.book("c17a");
    expect(await f.reverse(f.controller, id(first), "c17d")).toMatchObject({ ok: true });
    const rebook = await f.book("c17f");
    const rev1 = await f.reverse(f.controller, id(rebook), "c17g");
    expect(await f.reverse(f.controller, id(rev1), "c17h")).toMatchObject({ ok: true });
    expect((await f.book("c17i")).ok).toBe(false);
  });

  it("refuses reversing a reversal when the bank transaction was booked again meanwhile", async () => {
    const f = await bankFixture();
    const first = await f.book("b1");
    const rev = await f.reverse(f.controller, id(first), "r1");
    expect((await f.book("b2")).ok).toBe(true);
    expect(await f.reverse(f.controller, id(rev), "r2")).toMatchObject({ ok: false, code: "already_matched" });
    expect(f.balance("1020")).toBe(1_234_00);
  });
});
