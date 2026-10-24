import { describe, expect, it } from "vitest";
import {
  customerTotals,
  recordCustomerDocument,
  recordDisposition,
  registerCustomer,
  resolveHeldCustomerDocument,
  voidCustomerDocument,
} from "../convex/receivables";
import { sha256Hex } from "../convex/lib/kernel";
import type { Role } from "../src/core/roles";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

const runId = "ar-run";
const TOKEN = "seat-token";

async function setup() {
  const h = kernelHarness();
  await h.ctx.db.insert("runs", { runId, label: "AR", company: "test", simDate: "2026-01-15", status: "active", createdAt: 0 });
  const seat = async (seatId: string, role: Role) =>
    h.ctx.db.insert("seats", { runId, seatId, role, name: seatId, kind: "agent", capabilities: {}, status: "active", tokenHash: await sha256Hex(TOKEN), createdAt: 0 });
  await seat("ar-1", "ar_clerk");
  await seat("controller", "controller");
  await seat("ap-1", "ap_clerk");
  for (let m = 1; m <= 12; m++) await h.ctx.db.insert("periods", { runId, period: `2025-${String(m).padStart(2, "0")}`, status: "open" });
  const doc = (id: string, kind: string) => h.ctx.db.insert("events", {
    _seedId: id, runId, type: "document.received", externalId: id, occurredOn: "2026-01-15", payload: { kind, path: `${id}.pdf` }, recordedAt: 0,
  } as never);
  for (const id of ["inv", "inv-dup", "inv-void", "inv-late", "orig", "rev", "orig-late", "cm", "lines", "other"]) await doc(id, "ar_document");
  await doc("crm", "customer_master");
  await doc("mail", "ar_email");
  const ar = { runId, seatId: "ar-1", token: TOKEN };
  const controller = { runId, seatId: "controller", token: TOKEN };
  const reg = await mutationHandler(registerCustomer)(h.ctx, { ...ar, idempotencyKey: "c1", customerId: "C001", legalName: "Aster North", aliases: ["ANA"], documentEventId: "crm" });
  expect(reg.ok).toBe(true);
  return { h, ar, controller };
}

const invoice = {
  idempotencyKey: "k-inv",
  kind: "invoice" as const,
  customerId: "C001",
  displayNumber: "INV-2025-1001",
  documentDate: "2025-03-01",
  subtotalCents: 10_000,
  discountCents: 1_000,
  taxCents: 540,
  totalCents: 9_540,
  lines: [{ description: "Audit", quantity: 2, unitCents: 5_000, amountCents: 10_000 }],
  documentEventId: "inv",
  decision: "record" as const,
  exceptions: [],
};

const record = mutationHandler(recordCustomerDocument);
const totals = async (h: ReturnType<typeof kernelHarness>) =>
  (await (customerTotals as unknown as { _handler: (ctx: unknown, a: { runId: string }) => Promise<{ validInvoiceCount: number; grossCents: number; creditCents: number; netCents: number }[]> })._handler(h.ctx, { runId }))[0]!;

describe("customer invoices", () => {
  it("records a valid invoice as receivable, revenue and sales tax", async () => {
    const { h, ar } = await setup();
    const r = await record(h.ctx, { ...ar, ...invoice });
    expect(r).toMatchObject({ ok: true });
    const [entry] = h.all("journalEntries");
    expect(entry!.lines).toEqual([
      { account: "1170", debit: 9_540, credit: 0, dims: { customer: "C001" } },
      { account: "4030", debit: 0, credit: 9_000, dims: { customer: "C001" } },
      { account: "2300", debit: 0, credit: 540, dims: { customer: "C001" } },
    ]);
    expect(h.all("dispositions")).toMatchObject([{ documentEventId: "inv", treatment: "counted" }]);
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1, grossCents: 9_540, netCents: 9_540 });
    expect(await record(h.ctx, { ...ar, ...invoice })).toMatchObject({ ok: true, replayed: true });
    expect(await record(h.ctx, { ...ar, ...invoice, totalCents: 9_541, taxCents: 541 })).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });

  it("refuses a header that doesn't add up, leaving nothing behind", async () => {
    const { h, ar } = await setup();
    expect(await record(h.ctx, { ...ar, ...invoice, totalCents: 9_999 })).toMatchObject({ ok: false, code: "invalid_document" });
    expect(h.all("customerDocuments")).toHaveLength(0);
    expect(h.all("journalEntries")).toHaveLength(0);
  });

  it("counts a number once: a second copy from another document is a duplicate", async () => {
    const { h, ar } = await setup();
    await record(h.ctx, { ...ar, ...invoice });
    expect(await record(h.ctx, { ...ar, ...invoice, idempotencyKey: "k-dup", documentEventId: "inv-dup", displayNumber: "inv 2025 1001" }))
      .toMatchObject({ ok: false, code: "duplicate_document" });
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1, grossCents: 9_540 });
  });

  it("requires customer evidence and a registered customer", async () => {
    const { h, ar } = await setup();
    expect(await record(h.ctx, { ...ar, ...invoice, documentEventId: "mail" })).toMatchObject({ ok: false, code: "wrong_document" });
    expect(await record(h.ctx, { ...ar, ...invoice, documentEventId: "nope" })).toMatchObject({ ok: false, code: "no_document" });
    expect(await record(h.ctx, { ...ar, ...invoice, customerId: "C999" })).toMatchObject({ ok: false, code: "unknown_customer" });
    expect(await record(h.ctx, { ...ar, runId, seatId: "ap-1", ...invoice })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("subtracts credit memos from net spend", async () => {
    const { h, ar } = await setup();
    await record(h.ctx, { ...ar, ...invoice });
    const cm = await record(h.ctx, { ...ar, ...invoice, idempotencyKey: "k-cm", kind: "credit_memo", displayNumber: "CM-2025-077", documentEventId: "cm",
      subtotalCents: 1_480, discountCents: 0, taxCents: 0, totalCents: 1_480, lines: [{ description: "Credit", quantity: 1, unitCents: 1_480, amountCents: 1_480 }] });
    expect(cm.ok).toBe(true);
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1, grossCents: 9_540, creditCents: 1_480, netCents: 8_060 });
    expect(h.all("journalEntries")[1]!.lines[0]).toMatchObject({ account: "1170", debit: 0, credit: 1_480 });
  });
});

describe("voids and revisions", () => {
  it("a copy marked void reverses the recorded invoice and blocks the number", async () => {
    const { h, ar } = await setup();
    await record(h.ctx, { ...ar, ...invoice });
    const v = await mutationHandler(voidCustomerDocument)(h.ctx, { ...ar, idempotencyKey: "k-void", customerId: "C001", displayNumber: "INV-2025-1001", documentDate: "2025-03-05",
      subtotalCents: 10_000, discountCents: 1_000, taxCents: 540, totalCents: 9_540, documentEventId: "inv-void", reason: "document marked VOID" });
    expect(v).toMatchObject({ ok: true, reversed: 1 });
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 0, grossCents: 0 });
    expect(h.all("journalEntries").map((e) => e.status)).toEqual(["reversed", "posted"]);
    expect(await record(h.ctx, { ...ar, ...invoice, idempotencyKey: "k-late", documentEventId: "inv-late" })).toMatchObject({ ok: false, code: "number_voided" });
  });

  it("an email cannot void revenue", async () => {
    const { h, ar } = await setup();
    await record(h.ctx, { ...ar, ...invoice });
    expect(await mutationHandler(voidCustomerDocument)(h.ctx, { ...ar, idempotencyKey: "k-void", customerId: "C001", displayNumber: "INV-2025-1001", documentDate: "2025-03-05",
      subtotalCents: 10_000, discountCents: 1_000, taxCents: 540, totalCents: 9_540, documentEventId: "mail", reason: "customer email" })).toMatchObject({ ok: false, code: "wrong_document" });
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1 });
  });

  it("a revision replaces its original whichever arrives first", async () => {
    const { h, ar } = await setup();
    const original = { ...invoice, idempotencyKey: "k-orig", displayNumber: "INV-2025-2101", documentEventId: "orig" };
    await record(h.ctx, { ...ar, ...original });
    const rev = await record(h.ctx, { ...ar, ...invoice, idempotencyKey: "k-rev", displayNumber: "INV-2025-2101-R1", revisionOf: "INV-2025-2101", documentEventId: "rev",
      subtotalCents: 12_000, discountCents: 0, taxCents: 0, totalCents: 12_000, lines: [{ description: "Audit", quantity: 2, unitCents: 6_000, amountCents: 12_000 }] });
    expect(rev.ok).toBe(true);
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1, grossCents: 12_000 });
    expect(h.all("dispositions").find((d) => d.documentEventId === "orig")).toMatchObject({ category: "superseded_original", treatment: "excluded_from_spend" });
    expect(await record(h.ctx, { ...ar, ...original, idempotencyKey: "k-orig-late", documentEventId: "orig-late" })).toMatchObject({ ok: false, code: "number_superseded" });
  });
});

describe("held documents", () => {
  const bad = { ...invoice, idempotencyKey: "k-lines", documentEventId: "lines", lines: [{ description: "Audit", quantity: 3, unitCents: 5_000, amountCents: 10_000 }] };

  it("line arithmetic errors can't be counted without the controller", async () => {
    const { h, ar, controller } = await setup();
    expect(await record(h.ctx, { ...ar, ...bad })).toMatchObject({ ok: false, code: "policy" });
    const held = await record(h.ctx, { ...ar, ...bad, idempotencyKey: "k-lines-2", decision: "hold", exceptions: ["line_math: line 1"] });
    if (!held.ok) throw new Error(held.error);
    expect(h.all("journalEntries")).toHaveLength(0);
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 0 });
    expect(await mutationHandler(resolveHeldCustomerDocument)(h.ctx, { ...ar, idempotencyKey: "r0", documentId: held.documentId, decision: "approve", note: "x" }))
      .toMatchObject({ ok: false, code: "forbidden" });
    const ok = await mutationHandler(resolveHeldCustomerDocument)(h.ctx, { ...controller, idempotencyKey: "r1", documentId: held.documentId, decision: "approve", note: "billed total stands" });
    expect(ok.ok).toBe(true);
    expect(await totals(h)).toMatchObject({ validInvoiceCount: 1, grossCents: 9_540 });
    expect(h.all("dispositions").find((d) => d.documentEventId === "lines")).toMatchObject({ treatment: "counted_with_flag" });
  });

  it("a recorded document can't be excluded by a label", async () => {
    const { h, ar } = await setup();
    await record(h.ctx, { ...ar, ...invoice });
    expect(await mutationHandler(recordDisposition)(h.ctx, { ...ar, idempotencyKey: "d1", documentEventId: "inv", category: "duplicate_scan", treatment: "excluded_from_spend", reason: "x" }))
      .toMatchObject({ ok: false, code: "document_is_recorded" });
    expect(await mutationHandler(recordDisposition)(h.ctx, { ...ar, idempotencyKey: "d2", documentEventId: "other", category: "statement_summary", treatment: "excluded_from_spend", reason: "statement" }))
      .toMatchObject({ ok: true });
  });
});
