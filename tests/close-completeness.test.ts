import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { recordBill, resolveHeldBill } from "../convex/ap";
import { signClose } from "../convex/ledger";
import { readCloseReadiness } from "../convex/lib/closeReadiness";
import { sha256Hex } from "../convex/lib/kernel";
import { runClose } from "../src/agents/handlers/oversight";
import type { SeatRuntime, Task } from "../src/agents/runtime";
import { kernelHarness, mutationHandler } from "./helpers/kernelHarness";

async function fixture() {
  const h = kernelHarness();
  const controller = await h.setup("controller");
  const ap = { ...controller, seatId: "ap-1" };
  const human = { ...controller, seatId: "human-1" };
  for (const [auth, role, kind] of [[ap, "ap_clerk", "agent"], [human, "human_cfo", "human"]] as const) {
    await h.seed("seats", { runId: auth.runId, seatId: auth.seatId, role, kind, name: role,
      status: "active", capabilities: {}, tokenHash: await sha256Hex(auth.token), createdAt: 0 });
  }
  let serial = 0;
  const source = async (options: { kind?: string; occurredOn?: string; runId?: string } = {}) =>
    await h.seed("events", { runId: options.runId ?? controller.runId, type: "document.received",
      externalId: `invoice-${++serial}`, occurredOn: options.occurredOn ?? "2026-01-02",
      payload: { kind: options.kind ?? "invoice", text: "Unreadable source" }, recordedAt: serial });
  const bill = async (documentEventId: string, changes: Record<string, unknown> = {}) =>
    await mutationHandler(recordBill)(h.ctx, { ...ap, idempotencyKey: `bill:${documentEventId}`,
      vendor: "vendor", invoiceNumber: documentEventId, invoiceDate: "2026-01-02", dueDate: "2026-01-30",
      lines: [{ description: "Supplies", quantity: 1, unitCents: 10000, amountCents: 10000 }], totalCents: 10000,
      documentEventId, decision: "approve", exceptions: [], expenseAccount: "5000",
      decisionPath: `decisions/${documentEventId}.yaml`, ...changes });
  const readiness = () => readCloseReadiness(h.ctx, controller.runId, "2026-01");
  const sign = (auth = controller, extra = {}) => mutationHandler(signClose)(h.ctx, { ...auth, period: "2026-01", ...extra });
  return { h, controller, ap, human, source, bill, readiness, sign };
}

describe("received invoice completeness at the kernel close boundary", () => {
  it.each(["queued", "leased", "waiting", "failed", "done"] as const)("blocks a source with a %s task but no bill", async (status) => {
    const f = await fixture(); const eventId = await f.source();
    await f.h.seed("tasks", { runId: f.controller.runId, type: "ap.process_document", role: "ap_clerk", status,
      priority: 1, payload: { eventId }, idempotencyKey: "task", createdBy: "world", attempts: 1,
      result: { outcome: "unreadable" }, createdAt: 0, updatedAt: 0 });
    expect(await f.readiness()).toMatchObject({ ready: false, sourceInvoiceCount: 1,
      blockers: [{ kind: "unprocessed_invoice", documentEventId: eventId }] });
    expect(await f.sign()).toMatchObject({ ok: false, code: "close_blocked" });
    expect(await f.sign(f.human)).toMatchObject({ ok: false, code: "close_blocked" });
    expect(f.h.all("periods")[0]).toMatchObject({ status: "open", closedBy: [] });
    expect(f.h.all("activity").some((a) => a.kind === "signed" || a.kind === "closed")).toBe(false);
  });

  it("counts prior unresolved and lease invoices, ignoring future, other-run and non-invoice sources", async () => {
    const f = await fixture();
    await f.source({ occurredOn: "2025-12-31" });
    await f.source({ kind: "lease_invoice" });
    await f.source({ occurredOn: "2026-02-01" });
    await f.source({ runId: "other-run" });
    await f.source({ kind: "remit_change_request" });
    expect(await f.readiness()).toMatchObject({ ready: false, sourceInvoiceCount: 2, blockerCount: 2 });
  });

  it("unblocks after an actual accrual and still requires both controller and human", async () => {
    const f = await fixture(); const eventId = await f.source();
    expect(await f.sign(f.human)).toMatchObject({ ok: false });
    expect(await f.bill(eventId)).toMatchObject({ ok: true });
    expect(await f.readiness()).toMatchObject({ ready: true, blockerCount: 0 });
    expect(await f.sign()).toMatchObject({ ok: true, status: "open", signedBy: [f.controller.seatId] });
    expect(await f.sign()).toMatchObject({ ok: true, status: "open" });
    expect(await f.sign(f.human)).toMatchObject({ ok: true, status: "closed", signedBy: [f.controller.seatId, f.human.seatId] });
  });

  it("unblocks documented rejection and held-bill resolution", async () => {
    const f = await fixture(); const rejected = await f.source(); const held = await f.source();
    expect(await f.bill(rejected, { decision: "reject", exceptions: ["duplicate_delivery: source rejected"] })).toMatchObject({ ok: true });
    const result = await f.bill(held, { decision: "hold", exceptions: ["needs_controller_approval"] });
    if (!result.ok) throw new Error(result.error);
    expect(await f.readiness()).toMatchObject({ ready: false, blockerCount: 1, blockers: [{ kind: "held_bill" }] });
    expect(await mutationHandler(resolveHeldBill)(f.h.ctx, { ...f.controller, idempotencyKey: "resolve",
      billId: result.billId, decision: "reject", expenseAccount: "5000", note: "Verified invalid supplier demand",
      decisionPath: "decisions/rejected.yaml" })).toMatchObject({ ok: true });
    expect(await f.readiness()).toMatchObject({ ready: true, sourceInvoiceCount: 2 });
  });

  it("accepts exact source-linked kernel duplicate rejection without another bill", async () => {
    const f = await fixture(); const original = await f.source(); const duplicate = await f.source();
    const recorded = await f.bill(original, { invoiceNumber: "INV-42" });
    if (!recorded.ok) throw new Error(recorded.error);
    expect(await f.bill(duplicate, { invoiceNumber: "INVOICE-0042" })).toMatchObject({ ok: false, code: "duplicate_invoice" });
    expect(f.h.all("bills")).toHaveLength(1);
    expect(f.h.all("violations")).toMatchObject([{ sourceDocumentId: duplicate, relatedBillId: recorded.billId }]);
    expect(await f.readiness()).toMatchObject({ ready: true, sourceInvoiceCount: 2 });
  });

  it("does not trust telemetry, unrelated violations or a cross-run duplicate target", async () => {
    const f = await fixture(); const doc = await f.source(); const other = await f.source();
    const record = await f.bill(other);
    if (!record.ok) throw new Error(record.error);
    await f.h.ctx.db.patch(record.billId, { runId: "other-run" });
    await f.h.ctx.db.patch(other, { runId: "other-run" });
    await f.h.seed("violations", { runId: f.controller.runId, seatId: f.ap.seatId, operation: "ap.recordBill",
      reason: "duplicate_invoice: alleged duplicate", sourceDocumentId: doc, relatedBillId: record.billId, at: 0 });
    await f.h.seed("activity", { runId: f.controller.runId, seatId: f.ap.seatId, kind: "duplicate_invoice",
      text: "kernel blocked duplicate", refs: { documentEventId: doc, relatedBillId: record.billId }, at: 0 });
    expect(await f.readiness()).toMatchObject({ ready: false, blockers: [{ kind: "unprocessed_invoice" }] });
  });

  it.each(["missing", "other-run", "not-invoice"])("does not record duplicate clearance for a %s source", async (kind) => {
    const f = await fixture(); const original = await f.source();
    await f.bill(original, { invoiceNumber: "42" });
    const source = kind === "missing" ? "missing-document" : await f.source(kind === "other-run" ? { runId: "other-run" } : { kind: "email" });
    expect(await f.bill(source, { invoiceNumber: "42" })).toMatchObject({ ok: false, code: "duplicate_invoice" });
    expect(f.h.all("violations")[0]?.sourceDocumentId).toBeUndefined();
    expect(f.h.all("violations")[0]?.relatedBillId).toBeUndefined();
  });

  it("keeps an old unstructured duplicate failure blocked until a retry links it", async () => {
    const f = await fixture(); const original = await f.source(); const duplicate = await f.source();
    await f.bill(original, { invoiceNumber: "42" });
    await f.h.seed("violations", { runId: f.controller.runId, seatId: f.ap.seatId, operation: "ap.recordBill",
      reason: "duplicate_invoice: 42 duplicates a bill already recorded", at: 0 });
    expect(await f.readiness()).toMatchObject({ ready: false, blockerCount: 1 });
    await f.bill(duplicate, { invoiceNumber: "42" });
    expect(await f.readiness()).toMatchObject({ ready: true });
  });

  it("blocks multiple live bills linked to the same source", async () => {
    const f = await fixture(); const source = await f.source();
    await f.bill(source, { invoiceNumber: "one" });
    // The kernel refuses a second bill from one document; the close still catches it if data ever has one.
    expect(await f.bill(source, { idempotencyKey: "another-bill", invoiceNumber: "two" })).toMatchObject({ ok: false, code: "document_already_billed" });
    const other = await f.source();
    const second = await f.bill(other, { idempotencyKey: "another-bill-2", invoiceNumber: "two" });
    if (!second.ok) throw new Error(second.error);
    await f.h.ctx.db.patch(second.billId, { documentEventId: source });
    await f.h.ctx.db.patch(other, { runId: "other-run" });
    expect(await f.readiness()).toMatchObject({ ready: false, blockers: [{ kind: "multiple_bills", documentEventId: source }] });
  });

  it.each(["missing", "reversed", "wrong-run", "wrong-amount"])("blocks %s accrual even when bill status is approved", async (damage) => {
    const f = await fixture(); const eventId = await f.source(); const result = await f.bill(eventId);
    if (!result.ok || !result.entryId) throw new Error("bill not recorded");
    if (damage === "missing") await f.h.ctx.db.patch(result.billId, { entryId: undefined });
    if (damage === "reversed") await f.h.ctx.db.patch(result.entryId, { status: "reversed" });
    if (damage === "wrong-run") await f.h.ctx.db.patch(result.entryId, { runId: "other-run" });
    if (damage === "wrong-amount") await f.h.ctx.db.patch(result.billId, { totalCents: 5000 });
    expect(await f.readiness()).toMatchObject({ ready: false, blockers: [{ kind: "missing_accrual" }] });
    expect(await f.sign(f.human)).toMatchObject({ ok: false, code: "close_blocked" });
  });

  it("keeps a duplicate blocked while its original is held", async () => {
    const f = await fixture(); const original = await f.source(); const duplicate = await f.source();
    await f.bill(original, { invoiceNumber: "42", decision: "hold" });
    await f.bill(duplicate, { invoiceNumber: "42" });
    expect(await f.readiness()).toMatchObject({ ready: false, blockerCount: 1, blockers: [{ kind: "held_bill" }] });
  });

  it("rejects a source arrival between checklist query and signature", async () => {
    const f = await fixture(); const before = await f.readiness();
    await f.sign();
    const late = await f.source(); await f.bill(late, { decision: "reject" });
    expect(await f.sign(f.human, { expectedSnapshotHash: before.snapshotHash })).toMatchObject({ ok: false, code: "close_changed" });
    expect(f.h.all("periods")[0]?.closedBy).toEqual([]);
  });

  it.each([false, true])("invalidates an old signature when a new source resolves (human first: %s)", async (humanFirst) => {
    const f = await fixture(); const first = humanFirst ? f.human : f.controller; const second = humanFirst ? f.controller : f.human;
    await f.sign(first);
    const late = await f.source(); await f.bill(late, { decision: "reject" });
    expect(await f.sign(second)).toMatchObject({ ok: true, status: "open", signedBy: [second.seatId] });
    expect(await f.sign(first)).toMatchObject({ ok: true, status: "closed", signedBy: [second.seatId, first.seatId] });
  });

  it("keeps a signature when only a later period is posted to", async () => {
    const f = await fixture();
    await f.sign();
    await f.h.seed("periods", { runId: f.controller.runId, period: "2026-02", status: "open" });
    const later = await f.source({ occurredOn: "2026-02-03" });
    expect(await f.bill(later, { invoiceDate: "2026-02-03" })).toMatchObject({ ok: true, entryId: expect.any(String) });
    expect(await f.sign(f.human)).toMatchObject({ ok: true, status: "closed", signedBy: [f.controller.seatId, f.human.seatId] });
  });

  it("does not reuse historical signatures without a snapshot", async () => {
    const f = await fixture();
    await f.h.ctx.db.patch(f.h.all("periods")[0]!._id, { closedBy: [f.controller.seatId], memoryTag: "stale" });
    expect(await f.sign(f.human)).toMatchObject({ status: "open", signedBy: [f.human.seatId] });
    expect(f.h.all("periods")[0]?.memoryTag).toBeUndefined();
  });

  it("does not block January on a future held bill", async () => {
    const f = await fixture(); const future = await f.source({ occurredOn: "2026-02-02" });
    await f.bill(future, { invoiceDate: "2026-02-02", decision: "hold" });
    expect(await f.readiness()).toMatchObject({ ready: true, sourceInvoiceCount: 0 });
  });

  it("bounds returned examples without hiding the total blocker count", async () => {
    const f = await fixture(); for (let i = 0; i < 30; i++) await f.source();
    const result = await f.readiness();
    expect(result.blockerCount).toBe(30); expect(result.blockers).toHaveLength(25);
  });
});

describe("controller close reporting", () => {
  async function runtime(f: Awaited<ReturnType<typeof fixture>>, changeBeforeSign?: () => Promise<void>) {
    const decide = vi.fn(async (input: Record<string, unknown>) => ({ path: `decisions/${String(input.kind)}.yaml` }));
    const ask = vi.fn(async (_input: Record<string, unknown>) => undefined); const tag = vi.fn(); const signCall = vi.fn();
    const rt = { runId: f.controller.runId, author: { seatId: f.controller.seatId, name: "Controller" },
      mem: { tag }, decide, ask, handoff: vi.fn(),
      kernel: { auth: f.controller, client: {
        query: async (ref: Parameters<typeof getFunctionName>[0]) => {
          const name = getFunctionName(ref);
          if (name === "ledger:verifyChain") return { ok: true, entries: 0 };
          if (name === "ledger:trialBalance") return [];
          if (name === "ledger:closeReadiness") return await f.readiness();
          throw new Error(name);
        },
        mutation: async (_ref: unknown, args: Record<string, unknown>) => {
          signCall(); if (changeBeforeSign) await changeBeforeSign();
          return await f.sign(f.controller, args);
        },
      } },
    } as unknown as SeatRuntime;
    return { rt, decide, ask, tag, signCall, task: { _id: "tasks:close", payload: { period: "2026-01" } } as Task };
  }

  it("reports OPEN source blockers and never asks for co-signing unreadable invoices", async () => {
    const f = await fixture(); await f.source(); const r = await runtime(f);
    expect(await runClose(r.rt, r.task)).toMatchObject({ outcome: "not_ready" });
    expect(r.signCall).not.toHaveBeenCalled(); expect(r.tag).not.toHaveBeenCalled();
    expect(r.ask).toHaveBeenCalledWith(expect.objectContaining({ title: "2026-01 isn't ready to close", options: [{ id: "ack", label: "Acknowledge" }] }));
    expect(r.decide).toHaveBeenCalledWith(expect.objectContaining({ outcome: "hold" }));
  });

  it("reports a kernel race refusal as not_ready rather than signed/clean", async () => {
    const f = await fixture(); const r = await runtime(f, async () => { await f.source(); });
    expect(await runClose(r.rt, r.task)).toMatchObject({ outcome: "not_ready", summary: expect.stringContaining("Kernel refused") });
    expect(r.decide).toHaveBeenCalledWith(expect.objectContaining({ outcome: "hold" }));
    expect(r.ask.mock.calls[0]?.[0].options).toEqual([{ id: "ack", label: "Acknowledge" }]);
    expect(r.ask.mock.calls[0]?.[0].evidence).toEqual([{ label: "decision", ref: "decisions/close_refused.yaml" }]);
  });

  it("requests a co-signature only after the kernel accepted the reviewed snapshot", async () => {
    const f = await fixture(); const eventId = await f.source(); await f.bill(eventId); const r = await runtime(f);
    expect(await runClose(r.rt, r.task)).toMatchObject({ outcome: "signed", summary: "clean" });
    expect(r.ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Co-sign the 2026-01 close" }));
    expect(f.h.all("periods")[0]?.closedBy).toEqual([f.controller.seatId]);
    expect(r.decide.mock.invocationCallOrder[0]).toBeLessThan(r.tag.mock.invocationCallOrder[0]!);
    expect(r.tag.mock.invocationCallOrder[0]).toBeLessThan(r.signCall.mock.invocationCallOrder[0]!);
  });
});
