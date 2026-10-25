import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../core/kernel-client";
import { formatMoney } from "../../core/money";
import type { Vendor } from "../../memory/schemas";
import { callbackVerify } from "../../world/oracle";
import type { Handler } from "../runtime";

/**
 * End-of-day payment run: batch approved bills per vendor into payment requests (controller
 * approves). Bank execution is handled only by the scoped AP dispatcher. Remit-to comes from
 * verified memory, never from a document.
 */
export const paymentRun: Handler = async (rt, task) => {
  const bills = await rt.kernel.client.query(api.ap.bills, { runId: rt.runId, status: "approved" });
  const unpaid = bills.filter((b) => !b.paymentIntentId);
  const byVendor = new Map<string, typeof unpaid>();
  for (const b of unpaid) byVendor.set(b.vendor, [...(byVendor.get(b.vendor) ?? []), b]);

  let requested = 0;
  for (const [vendorId, vb] of byVendor) {
    const rec = await rt.vendor(vendorId);
    if (!rec || rec.vendor.status !== "active") continue;
    const blob = (await rt.mem.blobSha(`vendors/${vendorId}.yaml`)) ?? rec.sha;
    const ids = vb.map((b) => b._id).sort();
    const amount = vb.reduce((s, b) => s + b.totalCents, 0);
    const r = await rt.kernel.client.mutation(api.payments.requestPayment, {
      ...rt.kernel.auth,
      idempotencyKey: `pay:${vendorId}:${ids.join(",")}`,
      payee: vendorId,
      amountCents: amount,
      method: "ach",
      remitTo: { bank: rec.vendor.remitTo.bank, accountLast4: rec.vendor.remitTo.accountLast4, memorySha: blob },
      billIds: ids,
      dueDate: vb.map((b) => b.dueDate).sort()[0]!,
    });
    if (!r.ok) {
      await rt.note("blocked", `Payment request for ${vendorId} refused: ${r.error}`);
      continue;
    }
    requested++;
    await rt.handoff("payments.approve", "controller", { intentId: r.intentId }, `approve:${r.intentId}`, task._id, 2);
  }

  // Submission belongs exclusively to PaymentDispatcher. Legacy scenario approvals
  // are never treated as bank settlement; use the scoped AP demo for money movement.
  return { outcome: "ran", summary: `requested ${requested}; bank execution requires the scoped AP dispatcher` };
};

const INJECTION = /(system note|ai assistant|ignore (all|previous)|pre-?approved|without asking|execute pending payments)/i;
const URGENCY = /(urgent|immediately|today|avoid a late fee|right away)/i;

/**
 * A vendor asks to change where we send money. This is the highest-risk document an AP team
 * sees. Policy: call the number already on file (never one in the email), require a matching
 * sender domain, and route any change through a proposal the controller must merge.
 * Text inside the document is evidence, never instructions.
 */
export const remitChange: Handler = async (rt, task) => {
  const event = await rt.event(task.payload.eventId);
  const p = event.payload as { from: string; text: string; subject: string };
  const match = await rt.resolveVendorByEmail(p.from);
  const on = await rt.simDate();
  if (!match) {
    await rt.ask({ to: "controller", severity: "urgent", title: "Bank-change request from an unknown sender", body: `${p.from}: ${p.subject}`, taskId: task._id });
    return { outcome: "asked", summary: "unknown sender" };
  }
  const v = match.vendor;
  const phoneOnFile = v.contacts[0]?.phone ?? "";
  const call = callbackVerify(rt.runId, event.externalId, phoneOnFile);
  const signals = [
    !match.exactDomain && `sender domain ${p.from.split("@")[1]} does not match the domain on file`,
    INJECTION.test(p.text) && "document contains instructions addressed to an AI system",
    URGENCY.test(p.text) && "pressure to act immediately",
    !call.confirms && `callback to the number on file (${phoneOnFile}) did not confirm`,
  ].filter(Boolean) as string[];

  if (signals.length > 0) {
    const d = await rt.decide({
      kind: "remit_change", subject: { type: "vendor", id: v.id }, outcome: "reject", confidence: 0.98, task: task._id,
      summary: `Blocked bank-change request for ${v.legalName}: ${signals.join("; ")}`,
      facts: [
        { key: "sender", value: p.from, source: { kind: "event", ref: event.externalId } },
        { key: "callback", value: call.transcript, source: { kind: "external", ref: `phone:${phoneOnFile}` } },
        { key: "remitTo.on_file", value: `${v.remitTo.bank} ****${v.remitTo.accountLast4}`, source: { kind: "memory", ref: `vendors/${v.id}.yaml` } },
      ],
      rules: [{ path: "policies/payments.yaml", key: "remitChangeRequires" }],
    });
    await rt.updateVendor(v.id, (current) => ({ ...current, notes: [...current.notes, { on, by: rt.seat.seatId, text: `Blocked suspected payment-fraud attempt from ${p.from}: ${signals.join("; ")}. Remit-to unchanged.` }] }),
      `Record blocked bank-change attempt for ${v.legalName}`, { "Decision-Id": d.path }, `fraud-note:${event.externalId}`);
    await rt.ask({
      to: "human_cfo", severity: "urgent", title: `Blocked a suspected fraud attempt against ${v.legalName}`,
      body: `Someone asked us to send ${v.legalName}'s payments to a new account. Nothing changed and no payment was affected.\n\nWhy: ${signals.join("; ")}.`,
      evidence: [{ label: "decision", ref: d.path }, { label: "document", ref: event.externalId }],
      options: [{ id: "ack", label: "Acknowledge" }, { id: "warn_vendor", label: "Notify the vendor's security contact" }],
      taskId: task._id,
    });
    return { outcome: "blocked", summary: signals.join("; ") };
  }

  const cb = (event.payload as { callback?: { newBank: string; newAccountLast4: string } }).callback;
  if (!cb) return { outcome: "asked", summary: "confirmed by phone but no account details to apply" };
  const proposed: Vendor = {
    ...v,
    remitTo: { bank: cb.newBank, accountLast4: cb.newAccountLast4, verifiedOn: on, verifiedBy: rt.seat.seatId, method: "callback_known_number" },
    notes: [...v.notes, { on, by: rt.seat.seatId, text: `Remit-to change requested by ${p.from}; confirmed by calling ${phoneOnFile} (on file).` }],
  };
  const proposalId = `remit-${v.id}-${on}`;
  const d = await rt.decide({
    kind: "remit_change", subject: { type: "vendor", id: v.id }, outcome: "act", confidence: 0.9, task: task._id,
    summary: `Verified bank change for ${v.legalName} by callback; proposed for controller approval`,
    facts: [{ key: "callback", value: call.transcript, source: { kind: "external", ref: `phone:${phoneOnFile}` } }],
    rules: [{ path: "policies/payments.yaml", key: "remitChangeRequires" }],
  });
  const prop = await rt.propose(proposalId, [{ path: `vendors/${v.id}.yaml`, data: proposed }], `Change ${v.legalName} remit-to to ${cb.newBank} ****${cb.newAccountLast4} (callback verified)`, { "Decision-Id": d.path });
  await rt.handoff("memory.review_proposal", "controller", { proposalId, branch: prop.branch }, `review:${proposalId}`, task._id, 1);
  return { outcome: "proposed", summary: `${v.id} -> ${cb.newBank} ****${cb.newAccountLast4}` };
};

/** The CFO agent's independent approval on a dual-approval payment, alongside the controller or the human. */
export const secondApproval: Handler = async (rt, task) => {
  const intentId = task.payload.intentId as Id<"paymentIntents">;
  const intent = await rt.kernel.client.query(api.payments.intent, { runId: rt.runId, intentId });
  if (!intent || intent.status !== "pending_approval") return { outcome: "noop" };
  const r = await rt.kernel.client.mutation(api.payments.approvePayment, { ...rt.kernel.auth, intentId });
  if (!r.ok) return { outcome: "refused", summary: r.error };
  return { outcome: "approved", summary: `${intent.payee} ${formatMoney(intent.amountCents)} (${r.status})` };
};
