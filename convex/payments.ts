import { assertLegacyRun } from "./lib/demoAuth";
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
const remitTo = v.object({ bank: v.string(), accountLast4: v.string(), memorySha: v.string() });

/**
 * Payment lifecycle: pending_approval -> approved -> submitted -> settled (or voided).
 * Segregation of duties is enforced here: requester != approver, approval limits per seat,
 * a second approver above the dual threshold, a human above the human threshold, and the
 * remit-to is re-checked at execution so a bank-detail change after approval can't slip through.
 */
export const requestPayment = mutation({
  args: {
    ...seatArgs,
    idempotencyKey: v.string(),
    payee: v.string(),
    amountCents: v.number(),
    method: v.string(),
    remitTo,
    billIds: v.array(v.id("bills")),
    dueDate: v.string(),
  },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const op = "payments.requestPayment";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.paymentsRequest) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `${auth.seat.role} may not request payments`));
    }
    const { token: _t, ...payload } = args;
    const idem = await checkIdempotency(ctx, args.runId, args.idempotencyKey, op, payload);
    if ("conflict" in idem) return await recordViolation(ctx, args.runId, args.seatId, op, idem.conflict);
    if (idem.hit) return { ...(idem.result as { ok: true; intentId: Id<"paymentIntents">; requiredApprovals: number; requiresHuman: boolean }), replayed: true };

    if (new Set(args.billIds).size !== args.billIds.length) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("invalid_payment", "each bill may appear only once in a payment"));
    }

    let total = 0;
    for (const id of args.billIds) {
      const bill = await ctx.db.get(id);
      if (!bill || bill.runId !== args.runId) return fail("not_found", `bill ${id} not found`);
      if (bill.vendor !== args.payee) return fail("invalid_payment", `bill ${bill.invoiceNumber} is for ${bill.vendor}, not ${args.payee}`);
      if (bill.status !== "approved") return fail("invalid_payment", `bill ${bill.invoiceNumber} is ${bill.status}`);
      if (bill.paymentIntentId) {
        const other = await ctx.db.get(bill.paymentIntentId);
        if (other && other.status !== "voided") {
          return await recordViolation(ctx, args.runId, args.seatId, op,
            fail("double_payment", `bill ${bill.invoiceNumber} is already in payment ${other._id} (${other.status})`));
        }
      }
      total += bill.totalCents;
    }
    if (total !== args.amountCents) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("invalid_payment", `amount ${args.amountCents} != bills total ${total}`));
    }
    const run = await getRun(ctx, args.runId);
    if (!run) return fail("not_found", "run not found");
    const policy = runPolicy(run);
    const requiresHuman = args.amountCents >= policy.humanApprovalCents;
    const requiredApprovals = args.amountCents >= policy.dualApprovalCents ? 2 : 1;

    const intentId = await ctx.db.insert("paymentIntents", {
      runId: args.runId,
      payee: args.payee,
      amountCents: args.amountCents,
      method: args.method,
      remitTo: args.remitTo,
      billIds: args.billIds,
      dueDate: args.dueDate,
      requestedBy: args.seatId,
      approvals: [],
      requiredApprovals,
      requiresHuman,
      status: "pending_approval",
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    for (const id of args.billIds) await ctx.db.patch(id, { paymentIntentId: intentId });
    await logActivity(ctx, args.runId, args.seatId, "requested",
      `Requested ${(args.amountCents / 100).toFixed(2)} to ${args.payee} (${requiredApprovals} approval${requiredApprovals > 1 ? "s" : ""}${requiresHuman ? ", human required" : ""})`,
      { intentId });
    const result = { ok: true as const, intentId, requiredApprovals, requiresHuman };
    await storeIdempotency(ctx, args.runId, args.idempotencyKey, op, idem.payloadHash, result);
    return result;
  },
});

export const approvePayment = mutation({
  args: { ...seatArgs, intentId: v.id("paymentIntents") },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const op = "payments.approvePayment";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.runId !== args.runId) return fail("not_found", "payment not found");
    if (intent.status !== "pending_approval") return fail("bad_state", `payment is ${intent.status}`);
    if (intent.requestedBy === args.seatId) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("sod", "the requester of a payment cannot approve it"));
    }
    if (intent.approvals.some((a) => a.seatId === args.seatId)) return fail("already_approved", "this seat already approved");
    if (auth.seat.caps.paymentsApproveLimit < intent.amountCents) {
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("over_limit", `${auth.seat.role} may approve up to ${auth.seat.caps.paymentsApproveLimit} cents`));
    }
    const approvals = [...intent.approvals, { seatId: args.seatId, at: Date.now(), kind: auth.seat.kind }];
    const humanOk = !intent.requiresHuman || approvals.some((a) => a.kind === "human");
    const status = approvals.length >= intent.requiredApprovals && humanOk ? "approved" : "pending_approval";
    await ctx.db.patch(intent._id, { approvals, status });
    await logActivity(ctx, args.runId, args.seatId, "approved",
      `Approved payment to ${intent.payee} ${(intent.amountCents / 100).toFixed(2)} (${approvals.length}/${intent.requiredApprovals}${intent.requiresHuman && !humanOk ? ", waiting for a human" : ""})`,
      { intentId: intent._id });
    return { ok: true as const, status };
  },
});

export const executePayment = mutation({
  args: { ...seatArgs, intentId: v.id("paymentIntents"), currentRemitTo: remitTo },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const op = "payments.executePayment";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    if (!auth.seat.caps.paymentsExecute) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `${auth.seat.role} may not execute payments`));
    }
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.runId !== args.runId) return fail("not_found", "payment not found");
    if (intent.status === "submitted" || intent.status === "settled") return { ok: true as const, status: intent.status, replayed: true };
    if (intent.status !== "approved") {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("not_approved", `payment is ${intent.status}`));
    }
    if (intent.remitTo.bank !== args.currentRemitTo.bank || intent.remitTo.accountLast4 !== args.currentRemitTo.accountLast4) {
      await ctx.db.patch(intent._id, { status: "voided", voidReason: "remit-to changed after approval" });
      for (const id of intent.billIds) await ctx.db.patch(id, { paymentIntentId: undefined });
      return await recordViolation(ctx, args.runId, args.seatId, op,
        fail("remit_changed", `remit-to changed since approval (memory ${intent.remitTo.memorySha} -> ${args.currentRemitTo.memorySha}); payment voided, re-approval required`));
    }
    await ctx.db.patch(intent._id, { status: "submitted" });
    await logActivity(ctx, args.runId, args.seatId, "submitted", `Submitted ${(intent.amountCents / 100).toFixed(2)} to ${intent.payee} via ${intent.method}`, { intentId: intent._id });
    return { ok: true as const, status: "submitted" };
  },
});

/** Bank confirmed the payment: relieve AP and cash in one transaction. Idempotent per intent. */
export const settlePayment = mutation({
  args: { ...seatArgs, intentId: v.id("paymentIntents"), bankRef: v.string(), settledOn: v.string() },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const op = "payments.settlePayment";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.runId !== args.runId) return fail("not_found", "payment not found");
    if (intent.status === "settled") return { ok: true as const, replayed: true };
    if (intent.status !== "submitted") return fail("bad_state", `payment is ${intent.status}`);
    const posted = await appendEntry(ctx, {
      runId: args.runId,
      seat: auth.seat,
      date: args.settledOn,
      memo: `Payment to ${intent.payee} (${args.bankRef})`,
      source: { kind: "payment_settlement", ref: intent._id },
      lines: [
        { account: "2000", debit: intent.amountCents, credit: 0, dims: { vendor: intent.payee } },
        { account: "1000", debit: 0, credit: intent.amountCents, dims: { vendor: intent.payee } },
      ],
      idempotencyKey: `settle:${intent._id}`,
    });
    if (!posted.ok) return await recordViolation(ctx, args.runId, args.seatId, op, posted);
    await ctx.db.patch(intent._id, { status: "settled", bankRef: args.bankRef });
    for (const id of intent.billIds) await ctx.db.patch(id, { status: "paid" });
    return { ok: true as const, entryId: posted.entryId };
  },
});

export const voidPayment = mutation({
  args: { ...seatArgs, intentId: v.id("paymentIntents"), reason: v.string() },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const op = "payments.voidPayment";
    const auth = await authSeat(ctx, args.runId, args.seatId, args.token);
    if (!auth.ok) return await recordViolation(ctx, args.runId, args.seatId, op, auth);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.runId !== args.runId) return fail("not_found", "payment not found");
    if (intent.status === "submitted" || intent.status === "settled") return fail("bad_state", `cannot void a ${intent.status} payment`);
    if (!(auth.seat.caps.paymentsApproveLimit > 0 || auth.seat.caps.paymentsRequest)) {
      return await recordViolation(ctx, args.runId, args.seatId, op, fail("forbidden", `${auth.seat.role} may not void payments`));
    }
    if (intent.status === "voided") return { ok: true as const, replayed: true };
    await ctx.db.patch(intent._id, { status: "voided", voidReason: args.reason });
    for (const id of intent.billIds) {
      const bill = await ctx.db.get(id);
      if (bill?.paymentIntentId === intent._id) await ctx.db.patch(id, { paymentIntentId: undefined });
    }
    await logActivity(ctx, args.runId, args.seatId, "voided", `Voided payment to ${intent.payee}: ${args.reason}`, { intentId: intent._id });
    return { ok: true as const };
  },
});

export const intents = query({
  args: { runId: v.string(), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const rows = await ctx.db
      .query("paymentIntents")
      .withIndex("by_run_status", (q) => q.eq("runId", args.runId))
      .collect();
    return args.status ? rows.filter((r) => r.status === args.status) : rows;
  },
});

export const intent = query({
  args: { runId: v.string(), intentId: v.id("paymentIntents") },
  handler: async (ctx, args) => {
    await assertLegacyRun(ctx, args.runId);
    const i = await ctx.db.get(args.intentId);
    return i && i.runId === args.runId ? i : null;
  },
});
