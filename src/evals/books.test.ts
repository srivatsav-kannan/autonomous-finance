import { describe, expect, it } from "vitest";
import { evaluateBooks } from "./books";
import { generateWorld, type AccountingTruth } from "../world/generate";

type Input = Parameters<typeof evaluateBooks>[0];
function fixture(): Input {
  const accounting: AccountingTruth = {
    version: 1, start: "2026-01-01", end: "2026-01-02",
    netByAccount: {
      "5000": 10000, "5300": 2000, "6100": 500, "5200": 30000, "2000": -42500,
      "4000": -20000, "4010": -3000, "4020": -7000, "2300": -2000,
      "1100": 15000, "1110": 0, "1020": 15700, "5400": 300, "5410": 1000,
      "5100": 5000, "2100": -5000,
    },
    obligations: [
      { documentExternalId: "food", vendor: "food", invoiceNumber: "INV-1", amountCents: 10000, expenseAccount: "5000" },
      { documentExternalId: "utility", vendor: "utility", invoiceNumber: "INV-2", amountCents: 2000, expenseAccount: "5300" },
      { documentExternalId: "software", vendor: "software", invoiceNumber: "INV-3", amountCents: 500, expenseAccount: "6100" },
      { documentExternalId: "rent", vendor: "landlord", invoiceNumber: "INV-4", amountCents: 30000, expenseAccount: "5200" },
    ],
    duplicateDocuments: [],
  };
  const truth = generateWorld({ seed: 1, storeCount: 1, start: "2026-01-01", days: 1, plantErrors: false }).truth;
  truth.accounting = accounting;
  return {
    truth, intents: [], blockedDocuments: new Set(), outgoingPayments: [],
    documents: accounting.obligations.map((o) => ({ _id: `event-${o.documentExternalId}`, externalId: o.documentExternalId, payload: { kind: o.documentExternalId === "rent" ? "lease_invoice" : "invoice" } })),
    bills: accounting.obligations.map((o) => ({ _id: `bill-${o.documentExternalId}`, documentEventId: `event-${o.documentExternalId}`, vendor: o.vendor, invoiceNumber: o.invoiceNumber, totalCents: o.amountCents, status: "approved", entryId: `entry-${o.documentExternalId}`, exceptions: [] })),
    trialBalance: Object.entries(accounting.netByAccount).map(([code, net]) => ({ code, net })),
  };
}
function delta(input: Input, code: string, amount: number) {
  const row = input.trialBalance.find((a) => a.code === code);
  if (row) row.net += amount;
  else input.trialBalance.push({ code, net: amount });
}
function pay(input: Input) {
  input.bills[0]!.status = "paid";
  input.bills[0]!.paymentIntentId = "payment-1";
  input.intents.push({ _id: "payment-1", payee: "food", amountCents: 10000, status: "settled", bankRef: "bank-1", billIds: ["bill-food"] });
  input.outgoingPayments = [{ intentId: "payment-1", bankRef: "bank-1", payee: "food", amountCents: 10000, sentOn: "2026-01-02" }];
  delta(input, "1000", -10000); delta(input, "2000", 10000);
}

describe("complete book correctness", () => {
  it("passes fully accrued unpaid obligations and legitimate timing receivables", () => {
    const result = evaluateBooks(fixture());
    expect(result.booksStatus).toEqual({ status: "passed", reasons: [] });
    expect(result.books.find((b) => b.metric.startsWith("1100"))).toMatchObject({ expected: 15000, actual: 15000 });
    expect(result.books.find((b) => b.metric.startsWith("2000"))).toMatchObject({ expected: 42500 });
  });
  it("reconciles a paid bill to its bank receipt, cash and AP", () => {
    const input = fixture(); pay(input);
    expect(evaluateBooks(input).booksStatus.status).toBe("passed");
  });
  it("fails a missing utility invoice even when the ledger balances and old seven metrics match", () => {
    const input = fixture();
    input.bills.splice(1, 1);
    delta(input, "5300", -2000); delta(input, "2000", 2000);
    expect(input.trialBalance.reduce((sum, a) => sum + a.net, 0)).toBe(0);
    const result = evaluateBooks(input);
    expect(result.booksStatus.status).toBe("failed");
    expect(result.unresolvedDocuments).toContain("utility");
    expect(result.books.find((b) => b.metric.startsWith("5300"))).toMatchObject({ expected: 2000, actual: 0, diff: -2000 });
  });
  it("fails a two-cent residual marketplace receivable with an offsetting expense", () => {
    const input = fixture(); delta(input, "1110", -2); delta(input, "5410", 2);
    const result = evaluateBooks(input);
    expect(result.booksStatus.status).toBe("failed");
    expect(result.books.find((b) => b.metric.startsWith("1110"))?.diff).toBe(-2);
  });
  it("fails cash and AP omitted after the bank paid even if the intent says settled", () => {
    const input = fixture(); pay(input);
    delta(input, "1000", 10000); delta(input, "2000", -10000);
    const result = evaluateBooks(input);
    expect(result.booksStatus.status).toBe("failed");
    expect(result.books.find((b) => b.metric.startsWith("1000"))?.diff).toBe(10000);
  });
  it("refuses a self-reported settlement without a bank receipt", () => {
    const input = fixture(); pay(input); input.outgoingPayments = [];
    expect(evaluateBooks(input).booksStatus.reasons).toContain("Settled payment payment-1 has no simulator bank receipt.");
  });
  it("checks receipt identity and allocations, not merely aggregate matching dollars", () => {
    const input = fixture(); pay(input); input.intents[0]!.billIds = ["bill-utility"];
    expect(evaluateBooks(input).booksStatus.reasons).toContain("Bank transfer bank-1 does not match its paid bill allocations.");
  });
  it("does not waive a legitimate obligation when its bill was rejected", () => {
    const input = fixture(); input.bills[0]!.status = "rejected";
    expect(evaluateBooks(input).booksStatus.status).toBe("failed");
    expect(evaluateBooks(input).unresolvedDocuments).toContain("food");
  });
  it.each([false, true])("accepts a duplicate rejected with a bill or a source-specific kernel block (%s)", (kernelBlock) => {
    const input = fixture();
    input.truth.accounting!.duplicateDocuments.push({ documentExternalId: "duplicate", originalDocumentExternalId: "food" });
    input.documents.push({ _id: "duplicate-event", externalId: "duplicate", payload: { kind: "invoice" } });
    if (kernelBlock) input.blockedDocuments = new Set(["duplicate-event"]);
    else input.bills.push({ ...input.bills[0]!, _id: "duplicate-bill", documentEventId: "duplicate-event", status: "rejected", entryId: undefined, exceptions: ["duplicate_invoice: original is food"] });
    expect(evaluateBooks(input).booksStatus.status).toBe("passed");
    input.blockedDocuments = new Set();
    input.bills = input.bills.filter((b) => b._id !== "duplicate-bill");
    expect(evaluateBooks(input).booksStatus.status).toBe("incomplete");
  });
  it("requires an accrual entry reference even when aggregate balances match", () => {
    const input = fixture(); delete input.bills[0]!.entryId;
    expect(evaluateBooks(input).booksStatus.status).toBe("incomplete");
  });
  it("reports old truth, bad receipts and unsupported invoices as incomplete", () => {
    const old = fixture(); delete old.truth.accounting;
    expect(evaluateBooks(old).booksStatus.status).toBe("incomplete");
    const corrupt = fixture(); corrupt.outgoingPayments = { error: "lost file" };
    expect(evaluateBooks(corrupt).booksStatus.status).toBe("incomplete");
    const extra = fixture(); extra.documents.push({ _id: "extra", externalId: "extra", payload: { kind: "invoice" } });
    expect(evaluateBooks(extra).booksStatus.status).toBe("incomplete");
  });
  it("checks unused and unknown accounts as well as the expected active accounts", () => {
    const input = fixture(); delta(input, "1300", 300); delta(input, "9999", -300);
    expect(evaluateBooks(input).booksStatus.status).toBe("failed");
  });
});

describe("generated independent accounting oracle", () => {
  it.each([1, 7, 42])("captures every clean invoice and all bank deposits for seed %i", (seed) => {
    const world = generateWorld({ seed, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: false });
    const oracle = world.truth.accounting!;
    const invoiceDocs = world.events.filter((e) => e.payload.kind === "invoice" || e.payload.kind === "lease_invoice");
    expect(oracle.obligations.map((o) => o.documentExternalId).sort()).toEqual(invoiceDocs.map((e) => e.externalId).sort());
    expect(oracle.netByAccount["2000"]).toBe(-oracle.obligations.reduce((sum, o) => sum + o.amountCents, 0));
    expect(oracle.netByAccount["1020"]).toBe(world.events.filter((e) => e.type === "bank.transaction" && e.payload.account === "deposits").reduce((sum, e) => sum + Number(e.payload.amountCents), 0));
    expect(oracle.netByAccount["1110"]).toBe(0);
    expect(Object.values(oracle.netByAccount).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(oracle.obligations.filter((o) => o.expenseAccount === "5300").length).toBeGreaterThan(0);
    expect(oracle.obligations.filter((o) => o.expenseAccount === "6100").length).toBeGreaterThan(0);
  });
  it("keeps final-day card receivables and a partial marketplace week outstanding", () => {
    const world = generateWorld({ seed: 1, storeCount: 1, start: "2026-01-01", days: 2, plantErrors: false });
    const oracle = world.truth.accounting!;
    const lastSales = world.events.find((e) => e.type === "sales.daily" && e.occurredOn === "2026-01-02")!.payload as any;
    expect(oracle.netByAccount["1100"]).toBe(lastSales.in_store.grossCents + lastSales.digital.grossCents + lastSales.salesTaxCents + lastSales.giftCardsSoldCents - lastSales.giftCardsRedeemedCents);
    expect(oracle.netByAccount["1110"]).toBe(world.truth.revenueCents.marketplace);
  });
  it("does not count duplicate invoices and keeps an unexplained payout shortfall receivable", () => {
    const world = generateWorld({ seed: 7, storeCount: 3, start: "2026-01-01", days: 14, plantErrors: true });
    const oracle = world.truth.accounting!;
    expect(oracle.duplicateDocuments).toHaveLength(world.answerKey.errors.filter((e) => e.type.startsWith("duplicate_")).length);
    expect(oracle.duplicateDocuments.length).toBeGreaterThan(0);
    expect(oracle.duplicateDocuments.every((d) => !oracle.obligations.some((o) => o.documentExternalId === d.documentExternalId))).toBe(true);
    expect(oracle.netByAccount["1110"]).toBe(18750);
    expect(Object.values(oracle.netByAccount).reduce((sum, n) => sum + n, 0)).toBe(0);
    for (const error of world.answerKey.errors.filter((e) => e.type === "price_over_contract" || e.type === "short_shipment")) {
      const o = oracle.obligations.find((o) => o.vendor === error.subject.vendor && o.invoiceNumber === error.subject.ref)!;
      expect(o).toBeDefined();
    }
  });
});
