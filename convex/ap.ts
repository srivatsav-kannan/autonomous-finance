import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  authSeat,
  checkIdempotency,
  fail,
  getRun,
  logActivity,
  recordViolation,
  runPolicy,
  storeIdempotency,
} from "./lib/kernel";
import { appendEntry } from "./lib/post";

const seatArgs = { runId: v.string(), seatId: v.string(), token: v.string() };

const billLine = v.object({
  sku: v.optional(v.string()),
  description: v.string(),
  quantity: v.number(),
  unitCents: v.number(),
  amountCents: v.number(),
});

/** "INV-000123", "inv 123" and "123" are the same invoice for duplicate detection. */
export function normalizeInvoiceNumber(n: string): string {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(INVOICE|INV|NO)/, "").replace(/^0+/, "");
}

/**
 * Record a vendor bill and the clerk's decision. The kernel enforces:
 *  - arithmetic (line math and totals), so a model can't round its way to a wrong number
 *  - a hard duplicate guard per vendor + normalized invoice number
 *  - auto-approval only below policy and only with zero exceptions; everything else is held
 *  - approval posts the accrual (Dr expense / Cr AP) in the same transaction
 */
export const recordBill = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    vendor: v.string(),
    invoiceNumber: v.string(),
    invoiceDate: v.string(),
    dueDate: v.string(),
    store: v.optional(v.string()),
    deliveryId: v.optional(v.string()),
    lines: v.array(billLine),
    totalCents: v.number(),
    documentEventId: v.string(),
    decision: v.union(v.literal("approve"), v.literal("hold"), v.literal("reject")),
    exceptions: v.array(v.string()),
    expenseAccount: v.string(),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "ap.recordBill";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.billsRecord) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("forbidden", `${auth.seat.role} may not record vendor bills`));
    }
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; billId: Id<"bills">; entryId: Id<"journalEntries"> | null }), replayed: true };

    if (!Number.isSafeInteger(args.totalCents)) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("invalid_bill", "total must be safe integer cents"));
    }
    let lineTotal = 0;
    for (const [i, l] of args.lines.entries()) {
      if (![l.unitCents, l.amountCents].every(Number.isSafeInteger)) {
        return await recordViolation(ctx, args.runId, args.seatId, op, fail("invalid_bill", `line ${i}: cents must be integers`));
      }
      if (Math.round(l.quantity * l.unitCents) !== l.amountCents) {
        return await recordViolation(ctx, args.runId, args.seatId, op,
          fail("invalid_bill", `line ${i}: ${l.quantity} x ${l.unitCents} != ${l.amountCents}`));
      }
      lineTotal += l.amountCents;
      if (!Number.isSafeInteger(lineTotal)) {
        return await recordViolation(ctx, args.runId, args.seatId, op, fail("invalid_bill", "line sum must be safe integer cents"));
      }
    }
    if (lineTotal !== args.totalCents) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("invalid_bill", `lines sum to ${lineTotal} but total is ${args.totalCents}`));
    }

    const norm = normalizeInvoiceNumber(args.invoiceNumber);
    const prior = await ctx.db
      .query("bills")
      .withIndex("by_run_vendor_invoice", (q) => q.eq("runId", args.runId).eq("vendor", args.vendor).eq("invoiceNumber", norm))
      .collect();
    const live = prior.find((b) => b.status !== "rejected");
    if (live && args.decision !== "reject") {
      const source = (await ctx.db.query("events")
        .withIndex("by_run_type", (q) => q.eq("runId", args.runId).eq("type", "document.received"))
        .collect()).find((e) => e._id === args.documentEventId &&
          (e.payload?.kind === "invoice" || e.payload?.kind === "lease_invoice"));
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("duplicate_invoice", `${args.vendor} invoice ${args.invoiceNumber} duplicates a bill already recorded (${live.status})`),
        source ? { sourceDocumentId: source._id, relatedBillId: live._id } : undefined);
    }

    const run = await getRun(ctx, args.runId);
    if (!run) return fail("not_found", "run not found");
    const policy = runPolicy(run);
    if (args.decision === "approve") {
      if (args.exceptions.length > 0) {
        return await recordViolation(ctx, args.runId, args.seatId, op,
          fail("policy", "a bill with open exceptions cannot be approved; hold it"));
      }
      const limit = auth.seat.role === "controller" ? Number.MAX_SAFE_INTEGER : policy.autoApproveCents;
      if (args.totalCents > limit) {
        return await recordViolation(ctx, args.runId, args.seatId, op,
          fail("over_limit", `${auth.seat.role} may auto-approve up to ${limit} cents; hold for the controller`));
      }
    }

    const billId = await ctx.db.insert("bills", {
      runId: args.runId,
      vendor: args.vendor,
      invoiceNumber: norm,
      invoiceDate: args.invoiceDate,
      dueDate: args.dueDate,
      store: args.store,
      deliveryId: args.deliveryId,
      totalCents: args.totalCents,
      lines: args.lines,
      documentEventId: args.documentEventId,
      status: args.decision === "approve" ? "approved" : args.decision === "hold" ? "held" : "rejected",
      decisionPath: args.decisionPath,
      exceptions: args.exceptions,
      createdBy: args.seatId,
    });

    let entryId = undefined;
    if (args.decision === "approve") {
      const posted = await appendEntry(ctx, {
        runId: args.runId,
        seat: auth.seat,
        date: args.invoiceDate,
        memo: `${args.vendor} invoice ${args.invoiceNumber}`,
        source: { kind: "bill", ref: billId },
        lines: [
          { account: args.expenseAccount, debit: args.totalCents, credit: 0, dims: { vendor: args.vendor, store: args.store } },
          { account: "2000", debit: 0, credit: args.totalCents, dims: { vendor: args.vendor, store: args.store } },
        ],
        idempotencyKey: `${args.idempotencyKey}:accrual`,
        taskId: args.taskId,
        decisionPath: args.decisionPath,
        memorySha: args.memorySha,
      });
      if (!posted.ok) {
        // A returned failure commits the transaction so the violation survives.
        // Remove the provisional bill as well: it must never outlive a failed accrual.
        await ctx.db.delete(billId);
        return await recordViolation(ctx, args.runId, args.seatId, op, posted);
      }
      entryId = posted.entryId;
      await ctx.db.patch(billId, { entryId });
    } else {
      await logActivity(ctx, args.runId, args.seatId, args.decision === "hold" ? "held" : "rejected",
        `${args.decision === "hold" ? "Held" : "Rejected"} ${args.vendor} ${args.invoiceNumber}: ${args.exceptions.join("; ")}`,
        { billId, decisionPath: args.decisionPath });
    }
    const result = { ok: true as const, billId, entryId: entryId ?? null };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

/** Controller (or a human) resolves a held bill. Approval posts the accrual. */
export const resolveHeldBill = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    billId: v.id("bills"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    expenseAccount: v.string(),
    approvedCents: v.optional(v.number()), // short-pay: approve less than invoiced
    note: v.string(),
    decisionPath: v.optional(v.string()),
    memorySha: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const op = "ap.resolveHeldBill";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (auth.seat.role !== "controller") {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", "only the controller resolves held bills"));
    }
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; entryId: Id<"journalEntries"> | null }), replayed: true };

    const bill = await ctx.db.get(args.billId);
    if (!bill || bill.runId !== args.runId) return fail("not_found", "bill not found");
    if (bill.status !== "held") return fail("bad_state", `bill is ${bill.status}, not held`);
    if (bill.createdBy === args.seatId) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("sod", "the seat that recorded a bill cannot resolve it"));
    }
    let entryId = null;
    if (args.decision === "approve") {
      const amount = args.approvedCents ?? bill.totalCents;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > bill.totalCents) {
        return fail("invalid_amount", "approved amount must be positive and at most the invoice total");
      }
      const posted = await appendEntry(ctx, {
        runId: args.runId,
        seat: auth.seat,
        date: bill.invoiceDate,
        memo: `${bill.vendor} invoice ${bill.invoiceNumber} (approved by controller${amount < bill.totalCents ? `, short-paid ${(bill.totalCents - amount) / 100}` : ""})`,
        source: { kind: "bill", ref: bill._id },
        lines: [
          { account: args.expenseAccount, debit: amount, credit: 0, dims: { vendor: bill.vendor, store: bill.store } },
          { account: "2000", debit: 0, credit: amount, dims: { vendor: bill.vendor, store: bill.store } },
        ],
        idempotencyKey: `${args.idempotencyKey}:accrual`,
        decisionPath: args.decisionPath,
        memorySha: args.memorySha,
      });
      if (!posted.ok) return await recordViolation(ctx, args.runId, args.seatId, op, posted);
      entryId = posted.entryId;
      await ctx.db.patch(bill._id, { status: "approved", entryId, totalCents: amount, decisionPath: args.decisionPath ?? bill.decisionPath });
    } else {
      await ctx.db.patch(bill._id, { status: "rejected", decisionPath: args.decisionPath ?? bill.decisionPath });
    }
    await logActivity(ctx, args.runId, args.seatId, args.decision === "approve" ? "approved" : "rejected",
      `${args.decision === "approve" ? "Approved" : "Rejected"} held ${bill.vendor} ${bill.invoiceNumber}: ${args.note}`, { billId: bill._id });
    const result = { ok: true as const, entryId };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

export const bills = query({
  args: { runId: v.string(), status: v.optional(v.string()), vendor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("bills")
      .withIndex("by_run_vendor_invoice", (q) => (args.vendor ? q.eq("runId", args.runId).eq("vendor", args.vendor) : q.eq("runId", args.runId)))
      .collect();
    if (args.status) rows = rows.filter((b) => b.status === args.status);
    return rows;
  },
});

export const bill = query({
  args: { runId: v.string(), billId: v.id("bills") },
  handler: async (ctx, args) => {
    const b = await ctx.db.get(args.billId);
    return b && b.runId === args.runId ? b : null;
  },
});
