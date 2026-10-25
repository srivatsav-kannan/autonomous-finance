import { describe, expect, it } from "vitest";
import { recordBill } from "../convex/ap";
import { ROLE_CAPABILITIES, type Role } from "../src/core/roles";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

const invoice = {
  idempotencyKey: "bill-1",
  vendor: "produce",
  invoiceNumber: "INV-0042",
  invoiceDate: "2026-01-02",
  dueDate: "2026-01-16",
  lines: [{ description: "Kale", quantity: 1, unitCents: 10000, amountCents: 10000 }],
  totalCents: 10000,
  documentEventId: "document-1",
  decision: "approve" as const,
  exceptions: [],
  expenseAccount: "5000",
};

describe("bill creation is atomic with its accrual", () => {
  it.each([
    ["unknown account", { expenseAccount: "9999" }, "invalid_entry"],
    ["forbidden account", { expenseAccount: "5100" }, "invalid_entry"],
    ["cash account", { expenseAccount: "1000" }, "invalid_entry"],
    ["unopened period", { invoiceDate: "2026-02-02" }, "period_not_open"],
    ["bad date", { invoiceDate: "yesterday" }, "invalid_entry"],
  ])("leaves no bill after %s and allows a corrected retry", async (_label, changes, code) => {
    const h = kernelHarness();
    const auth = await h.setup();
    await h.document(auth.runId);
    const denied = await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice, ...changes });
    expect(denied).toMatchObject({ ok: false, code });
    expect(h.all("bills")).toHaveLength(0);
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(h.all("balances")).toHaveLength(0);
    expect(h.all("ledgerHeads")).toHaveLength(0);
    expect(h.all("idempotency")).toHaveLength(0);
    expect(h.all("violations")).toHaveLength(1);
    expect(h.all("activity").map((a) => a.kind)).toEqual(["blocked"]);

    const corrected = await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.error);
    expect(h.all("bills")).toMatchObject([{ _id: corrected.billId, status: "approved", entryId: corrected.entryId }]);
    expect(h.all("journalEntries")).toMatchObject([{ _id: corrected.entryId, source: { kind: "bill", ref: corrected.billId } }]);
    expect(await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice })).toMatchObject({ ...corrected, replayed: true });
    expect(h.all("bills")).toHaveLength(1);
    expect(h.all("journalEntries")).toHaveLength(1);
  });

  it("leaves no bill when a period has closed", async () => {
    const h = kernelHarness();
    const auth = await h.setup();
    await h.document(auth.runId);
    await h.ctx.db.patch(h.all("periods")[0]!._id, { status: "closed" });
    expect(await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice })).toMatchObject({ ok: false, code: "period_closed" });
    expect(h.all("bills")).toHaveLength(0);
    expect(h.all("violations")).toHaveLength(1);
  });
});

describe("bill writing authority", () => {
  const permitted: Role[] = ["ap_clerk", "controller", "lease_accountant"];
  const denied = (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((role) => !permitted.includes(role));
  it.each(denied)("denies all decisions for %s before AP state changes", async (role) => {
    const h = kernelHarness();
    const auth = await h.setup(role);
    await h.document(auth.runId);
    for (const decision of ["approve", "hold", "reject"] as const) {
      expect(await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice, decision })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(h.all("bills")).toHaveLength(0);
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(h.all("idempotency")).toHaveLength(0);
    expect(h.all("violations")).toHaveLength(3);
  });

  it.each(permitted)("preserves held/rejected bill creation for %s", async (role) => {
    const h = kernelHarness();
    const auth = await h.setup(role);
    await h.document(auth.runId);
    for (const decision of ["hold", "reject"] as const) {
      expect(await mutationHandler(recordBill)(h.ctx, { ...auth, ...invoice, idempotencyKey: decision, invoiceNumber: decision, decision, expenseAccount: "5200" })).toMatchObject({ ok: true, entryId: null });
    }
    expect(h.all("bills").map((b) => b.status)).toEqual(["held", "rejected"]);
    expect(h.all("journalEntries")).toHaveLength(0);
  });
});
