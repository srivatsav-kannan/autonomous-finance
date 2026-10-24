import { describe, expect, it } from "vitest";
import { postEntry } from "../convex/ledger";
import { recordBill } from "../convex/ap";
import { kernelHarness } from "./helpers/kernelHarness";

const max = Number.MAX_SAFE_INTEGER;
const entry = {
  idempotencyKey: "entry-1", date: "2026-01-02", memo: "arithmetic regression", source: { kind: "bill" },
  lines: [{ account: "5000", debit: max, credit: 0 }, { account: "2000", debit: 0, credit: max }],
};

describe("safe aggregate cents", () => {
  it.each([1, 2])("rejects overflow even when floating debit and credit sums compare equal (%i)", async (extraCredit) => {
    const h = kernelHarness();
    const auth = await h.setup();
    const result = await postEntry._handler(h.ctx, {
      ...auth, ...entry,
      lines: [...entry.lines, { account: "5000", debit: 2, credit: 0 }, { account: "2000", debit: 0, credit: extraCredit }],
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_entry" });
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(h.all("balances")).toHaveLength(0);
    expect(h.all("ledgerHeads")).toHaveLength(0);
    expect(h.all("idempotency")).toHaveLength(0);
    expect(h.all("violations")).toHaveLength(1);
  });

  it("accepts exactly MAX_SAFE_INTEGER with exact repeated-account accumulation", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    const result = await postEntry._handler(h.ctx, {
      ...auth, ...entry,
      lines: [
        { account: "5000", debit: max - 2, credit: 0 }, { account: "5000", debit: 2, credit: 0 },
        { account: "2000", debit: 0, credit: max - 3 }, { account: "2000", debit: 0, credit: 3 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(h.all("journalEntries")[0]!.totalCents).toBe(max);
    expect(h.all("balances")).toMatchObject([{ account: "5000", debits: max, credits: 0 }, { account: "2000", debits: 0, credits: max }]);
  });

  it.each(["hold", "reject"] as const)("rejects unsafe %s bill totals before inserting AP rows", async (decision) => {
    const h = kernelHarness();
    const auth = await h.setup();
    const result = await recordBill._handler(h.ctx, {
      ...auth, idempotencyKey: "huge-bill", vendor: "produce", invoiceNumber: "INV-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
      lines: [max, 2].map((amountCents) => ({ description: "item", quantity: 1, unitCents: amountCents, amountCents })),
      totalCents: max + 2, documentEventId: "document-1", decision, exceptions: [], expenseAccount: "5000",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_bill" });
    expect(h.all("bills")).toHaveLength(0);
  });

  it("rejects bill sums that overflow before later negative lines cancel them", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    const result = await recordBill._handler(h.ctx, {
      ...auth, idempotencyKey: "cancelled-overflow", vendor: "produce", invoiceNumber: "INV-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
      lines: [max, 2, -max].map((amountCents) => ({ description: "item", quantity: 1, unitCents: amountCents, amountCents })),
      totalCents: 1, documentEventId: "document-1", decision: "hold", exceptions: [], expenseAccount: "5000",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_bill" });
    expect(h.all("bills")).toHaveLength(0);
  });
});

describe("persisted balances", () => {
  it("rejects a later posting that would overflow without advancing the journal or balances", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    expect((await postEntry._handler(h.ctx, { ...auth, ...entry })).ok).toBe(true);
    const before = { entries: h.all("journalEntries"), heads: h.all("ledgerHeads"), balances: h.all("balances"), idem: h.all("idempotency") };
    const result = await postEntry._handler(h.ctx, { ...auth, ...entry, idempotencyKey: "entry-2", lines: [
      { account: "5000", debit: 1, credit: 0 }, { account: "2000", debit: 0, credit: 1 },
    ] });
    expect(result).toMatchObject({ ok: false, code: "invalid_entry" });
    expect(h.all("journalEntries")).toEqual(before.entries);
    expect(h.all("ledgerHeads")).toEqual(before.heads);
    expect(h.all("balances")).toEqual(before.balances);
    expect(h.all("idempotency")).toEqual(before.idem);
    expect(h.all("violations")).toHaveLength(1);
  });

  it("preflights repeated lines and every account before writing even a valid first account", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    await h.seed("balances", { runId: auth.runId, account: "2000", period: "2026-01", debits: 0, credits: max - 2 });
    const balances = h.all("balances");
    const result = await postEntry._handler(h.ctx, { ...auth, ...entry, lines: [
      { account: "5000", debit: 3, credit: 0 },
      { account: "2000", debit: 0, credit: 1 }, { account: "2000", debit: 0, credit: 2 },
    ] });
    expect(result).toMatchObject({ ok: false, code: "invalid_entry" });
    expect(h.all("balances")).toEqual(balances);
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(h.all("ledgerHeads")).toHaveLength(0);
  });

  it("removes a provisional approved bill when its accrual would overflow", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    expect((await postEntry._handler(h.ctx, { ...auth, ...entry })).ok).toBe(true);
    const result = await recordBill._handler(h.ctx, {
      ...auth, idempotencyKey: "bill-after-max", vendor: "produce", invoiceNumber: "INV-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
      lines: [{ description: "item", quantity: 1, unitCents: 1, amountCents: 1 }],
      totalCents: 1, documentEventId: "document-1", decision: "approve", exceptions: [], expenseAccount: "5000",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_entry" });
    expect(h.all("bills")).toHaveLength(0);
    expect(h.all("journalEntries")).toHaveLength(1);
    expect(h.all("violations")).toHaveLength(1);
  });
});
