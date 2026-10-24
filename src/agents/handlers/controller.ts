import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../core/kernel-client";
import { formatMoney } from "../../core/money";
import { ROLE_CAPABILITIES } from "../../core/roles";
import { compileParser, type ParserRecord } from "../../integrations/parsers";
import type { Vendor } from "../../memory/schemas";
import type { Handler } from "../runtime";
import type { Exception } from "./ap";

/**
 * Resolve a held bill. Duplicates are rejected; quantity and price problems are short-paid
 * to what was received at contract price; open credits are deducted and marked applied;
 * clean over-limit bills are approved. Every resolution leaves a decision record.
 */
export const reviewHeld: Handler = async (rt, task) => {
  const billId = task.payload.billId as Id<"bills">;
  const bill = await rt.kernel.client.query(api.ap.bill, { runId: rt.runId, billId });
  if (!bill) return { outcome: "missing", summary: "bill not found" };
  if (bill.status !== "held") return { outcome: "noop", summary: `bill already ${bill.status}` };
  const ex = (task.payload.exceptions ?? []) as Exception[];
  const codes = new Set(ex.map((e) => e.code));

  if (codes.has("no_receiving_record") || codes.has("unknown_store")) {
    await rt.ask({ to: "human_cfo", severity: "decision", title: `Can't verify ${bill.vendor} ${bill.invoiceNumber}`,
      body: ex.map((e) => e.detail).join("\n"), options: [{ id: "pay", label: "Pay as billed" }, { id: "reject", label: "Reject" }], taskId: task._id,
      evidence: [{ label: "decision", ref: String(task.payload.decisionPath) }] });
    return { outcome: "asked", summary: "needs a human: no receiving record", waiting: true };
  }

  const approvedCents = Math.max(0, Math.min(bill.totalCents, Number(task.payload.recommendedCents ?? bill.totalCents)));
  const reasons = ex.filter((e) => e.code !== "needs_controller_approval").map((e) => e.detail);
  const decision = approvedCents === 0 ? "reject" : "approve";
  const d = await rt.decide({
    kind: "held_bill",
    subject: { type: "invoice", id: `${bill.vendor}/${bill.invoiceNumber}` },
    outcome: decision === "approve" ? "act" : "reject",
    confidence: 0.93,
    summary: reasons.length
      ? `${decision === "approve" ? `Approve ${formatMoney(approvedCents)} of ${formatMoney(bill.totalCents)}` : "Reject"}: ${reasons.join("; ")}`
      : `Approve ${formatMoney(bill.totalCents)} (clean match, over AP auto-approve limit)`,
    facts: ex.map((e) => ({ key: e.code, value: e.detail, source: { kind: "memory" as const, ref: String(task.payload.decisionPath) } })),
    rules: [{ path: "policies/approval-limits.yaml", key: "autoApproveCents" }],
    amountCents: approvedCents,
    task: task._id,
  });
  const vendorRec = await rt.vendor(bill.vendor);
  const res = await rt.kernel.client.mutation(api.ap.resolveHeldBill, {
    ...rt.kernel.auth,
    idempotencyKey: `resolve:${bill._id}`,
    billId: bill._id,
    decision,
    expenseAccount: vendorRec?.vendor.expenseAccount ?? "5000",
    approvedCents: decision === "approve" ? approvedCents : undefined,
    note: reasons.join("; ") || "over auto-approve limit",
    decisionPath: d.path,
    memorySha: d.memorySha,
  });
  if (!res.ok) throw new Error(`resolveHeldBill: ${res.code} ${res.error}`);

  // Mark credits applied and leave a dispute note for price/quantity problems, in vendor memory.
  if (vendorRec) {
    const v = vendorRec.vendor;
    const appliedIds = ex.filter((e) => e.code === "open_credit" && e.ref).map((e) => e.ref!);
    const disputes = ex.filter((e) => e.code === "price_over_contract" || e.code === "short_shipment");
    if (appliedIds.length || disputes.length) {
      const on = await rt.simDate();
      await rt.updateVendor(v.id, (current) => ({
        ...current,
        credits: current.credits.map((c) => (appliedIds.includes(c.id) ? { ...c, appliedTo: bill.invoiceNumber } : c)),
        notes: [...current.notes, ...disputes.map((e) => ({ on, by: rt.seat.seatId, text: `Short-paid ${bill.invoiceNumber}: ${e.detail}. Vendor notified.` }))],
      }), `Apply credits / record disputes for ${bill.invoiceNumber}`, { "Decision-Id": d.path }, `vendor-update:${bill._id}`);
    }
  }
  return { outcome: decision === "approve" ? "approved" : "rejected", summary: `${bill.vendor} ${bill.invoiceNumber}: ${formatMoney(approvedCents)}` };
};

/** Approve a payment within the controller's limit; above it (or human-required), ask the human CFO. */
export const approvePayment: Handler = async (rt, task) => {
  const intentId = task.payload.intentId as Id<"paymentIntents">;
  const intent = await rt.kernel.client.query(api.payments.intent, { runId: rt.runId, intentId });
  if (!intent) return { outcome: "missing" };
  if (intent.status !== "pending_approval") return { outcome: "noop", summary: intent.status };
  const vendorRec = await rt.vendor(intent.payee);
  const remitOk = vendorRec && vendorRec.vendor.remitTo.accountLast4 === intent.remitTo.accountLast4 && vendorRec.vendor.status === "active";
  if (!remitOk) {
    await rt.kernel.client.mutation(api.payments.voidPayment, { ...rt.kernel.auth, intentId, reason: "remit-to on the request does not match verified vendor record" });
    return { outcome: "voided", summary: "remit-to mismatch" };
  }
  const alreadyMine = intent.approvals.some((a) => a.seatId === rt.seat.seatId);
  if (!alreadyMine && intent.amountCents <= ROLE_CAPABILITIES.controller.paymentsApproveLimit) {
    const r = await rt.kernel.client.mutation(api.payments.approvePayment, { ...rt.kernel.auth, intentId });
    if (!r.ok) throw new Error(`approvePayment: ${r.code} ${r.error}`);
    if (r.status === "approved") return { outcome: "approved", summary: `${intent.payee} ${formatMoney(intent.amountCents)}` };
    if (!intent.requiresHuman) {
      // Dual approval below the human threshold: the CFO agent is the second, independent approver.
      await rt.handoff("payments.second_approval", "cfo_agent", { intentId }, `second:${intentId}`, task._id, 2);
      return { outcome: "approved_first", summary: `${intent.payee} ${formatMoney(intent.amountCents)}; second approval routed to CFO agent` };
    }
  }
  await rt.ask({
    to: "human_cfo",
    severity: "decision",
    title: `Approve ${formatMoney(intent.amountCents)} to ${vendorRec?.vendor.legalName ?? intent.payee}`,
    body: `${intent.billIds.length} approved bill(s), remit to ${intent.remitTo.bank} ****${intent.remitTo.accountLast4} (verified ${vendorRec?.vendor.remitTo.verifiedOn}). Controller ${alreadyMine || intent.amountCents <= ROLE_CAPABILITIES.controller.paymentsApproveLimit ? "approved" : "is over its limit"}; policy requires a human at this amount.`,
    options: [{ id: "approve", label: "Approve payment" }, { id: "reject", label: "Reject" }],
    paymentIntentId: intentId,
    taskId: task._id,
  });
  return { outcome: "asked", summary: "human approval required", waiting: true };
};

/** Review a proposal branch: remit-to changes need a confirmed callback; parsers must pass their tests. */
export const reviewProposal: Handler = async (rt, task) => {
  const id = String(task.payload.proposalId);
  const { paths, head } = await rt.mem.proposalPaths(id);
  const problems: string[] = [];
  for (const p of paths) {
    if (p.startsWith("vendors/")) {
      const proposed = await rt.mem.read<Vendor>(p, head);
      if (!proposed || proposed.remitTo.method !== "callback_known_number") problems.push(`${p}: remit-to not verified by callback to the number on file`);
    } else if (p.startsWith("integrations/parsers/")) {
      const rec = await rt.mem.read<ParserRecord>(p, head);
      if (!rec) {
        problems.push(`${p}: unreadable`);
        continue;
      }
      try {
        const parser = compileParser(rec);
        for (const [i, t] of rec.tests.entries()) {
          const got = parser.parse(t.input);
          if (JSON.stringify(got) !== JSON.stringify(t.expected)) problems.push(`${p}: test ${i + 1} output differs from expected`);
        }
      } catch (e) {
        problems.push(`${p}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      }
    } else {
      problems.push(`${p}: controller does not review this kind of change`);
    }
  }
  const d = await rt.decide({
    kind: "proposal_review",
    subject: { type: "proposal", id },
    outcome: problems.length ? "reject" : "act",
    confidence: problems.length ? 0.95 : 0.9,
    summary: problems.length ? `Rejected: ${problems.join("; ")}` : `Merged ${paths.join(", ")}`,
    facts: paths.map((p) => ({ key: "path", value: p, source: { kind: "memory" as const, ref: `proposal/${id}`, sha: head } })),
    rules: [{ path: "policies/payments.yaml", key: "remitChangeRequires" }],
    task: task._id,
  });
  if (problems.length) {
    await rt.mem.rejectProposal(id);
    return { outcome: "rejected", summary: problems.join("; ") };
  }
  const merged = await rt.mem.merge({ id, approver: rt.author, caps: ROLE_CAPABILITIES.controller, note: `reviewed (${d.path})` });
  await rt.kernel.client.mutation(api.observe.recordCommit, {
    ...rt.kernel.auth, sha: merged.sha, branch: "main", message: `Merge proposal ${id}`, paths, trailers: { "Approved-By": rt.seat.seatId, "Proposal-Id": id },
  });
  return { outcome: "merged", summary: paths.join(", ") };
};
