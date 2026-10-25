import { isDeepStrictEqual } from "node:util";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { api } from "../../core/kernel-client";
import { formatMoney } from "../../core/money";
import { ROLE_CAPABILITIES, canApprovePayment } from "../../core/roles";
import { compileParser, parseWith, type ParserRecord } from "../../integrations/parsers";
import type { Vendor } from "../../memory/schemas";
import type { Handler, SeatRuntime } from "../runtime";
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

  let humanAnswer: Doc<"asks"> | undefined;
  if (codes.has("no_receiving_record") || codes.has("unknown_store")) {
    const asks = await rt.kernel.client.query(api.asks.forTask, { runId: rt.runId, taskId: task._id });
    humanAnswer = asks.find((a) => a.taskId === task._id && a.to === "human_cfo" && a.status === "answered" &&
      (a.answer?.optionId === "pay" || a.answer?.optionId === "reject") && a.options.some((o) => o.id === a.answer?.optionId));
    if (!humanAnswer) {
      await rt.ask({ to: "human_cfo", severity: "decision", title: `Can't verify ${bill.vendor} ${bill.invoiceNumber}`,
        body: ex.map((e) => e.detail).join("\n"), options: [{ id: "pay", label: "Pay as billed" }, { id: "reject", label: "Reject" }], taskId: task._id,
        evidence: [{ label: "decision", ref: String(task.payload.decisionPath) }] });
      return { outcome: "asked", summary: "needs a human: no receiving record", waiting: true };
    }
  }

  // The human chooses pay-as-billed or rejection, not the stale automated short-pay recommendation.
  const vendorRec = await rt.vendor(bill.vendor);
  const recommended = Math.max(0, Math.min(bill.totalCents, Number(task.payload.recommendedCents ?? bill.totalCents)));
  const credits = humanAnswer ? [] : ex.filter((e) => e.code === "open_credit" && e.ref);
  const withoutCredits = Math.min(bill.totalCents, recommended - credits.reduce((s, e) => s + e.deltaCents, 0));
  // A bill being rejected anyway must not consume a credit a later invoice could use.
  const claim = withoutCredits > 0 ? await claimCredits(rt, bill, credits, vendorRec !== undefined) : { unavailable: new Map(credits.map((e) => [e.ref!, "nothing left to pay on this bill"])) };
  const unavailable = credits.filter((e) => claim.unavailable.has(e.ref!));
  const approvedCents = humanAnswer
    ? humanAnswer.answer!.optionId === "pay" ? bill.totalCents : 0
    : Math.max(0, Math.min(bill.totalCents, recommended - unavailable.reduce((s, e) => s + e.deltaCents, 0)));
  const reasons = humanAnswer
    ? [`Human ${humanAnswer.answer!.by} chose ${humanAnswer.answer!.optionId}${humanAnswer.answer!.note ? `: ${humanAnswer.answer!.note}` : ""}`]
    : [
      ...ex.filter((e) => e.code !== "needs_controller_approval" && !unavailable.includes(e)).map((e) => e.detail),
      ...unavailable.map((e) => `credit ${e.ref} not deducted: ${claim.unavailable.get(e.ref!)}`),
    ];
  const decision = approvedCents === 0 ? "reject" : "approve";
  const d = await rt.decide({
    kind: "held_bill",
    subject: { type: "invoice", id: `${bill.vendor}/${bill.invoiceNumber}` },
    outcome: decision === "approve" ? "act" : "reject",
    confidence: 0.93,
    summary: reasons.length
      ? `${decision === "approve" ? `Approve ${formatMoney(approvedCents)} of ${formatMoney(bill.totalCents)}` : "Reject"}: ${reasons.join("; ")}`
      : `Approve ${formatMoney(bill.totalCents)} (clean match, over AP auto-approve limit)`,
    facts: [
      ...ex.map((e) => ({ key: e.code, value: e.detail, source: { kind: "memory" as const, ref: String(task.payload.decisionPath) } })),
      ...(humanAnswer ? [{ key: "human_answer", value: humanAnswer.answer, source: { kind: "ask" as const, ref: humanAnswer._id } }] : []),
      ...(credits.length ? [{ key: "credit_claim", value: { claimed: credits.filter((e) => !unavailable.includes(e)).map((e) => e.ref), unavailable: Object.fromEntries(claim.unavailable) },
        source: { kind: "memory" as const, ref: `vendors/${bill.vendor}.yaml` } }] : []),
    ],
    rules: [{ path: "policies/approval-limits.yaml", key: "autoApproveCents" }],
    amountCents: approvedCents,
    task: task._id,
  });
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

  // Leave a dispute note for price/quantity problems in vendor memory. Credits were claimed above.
  if (vendorRec && !humanAnswer) {
    const v = vendorRec.vendor;
    const disputes = ex.filter((e) => e.code === "price_over_contract" || e.code === "short_shipment");
    if (disputes.length) {
      const on = await rt.simDate();
      await rt.updateVendor(v.id, (current) => ({
        ...current,
        notes: [...current.notes, ...disputes.map((e) => ({ on, by: rt.seat.seatId, text: `Short-paid ${bill.invoiceNumber}: ${e.detail}. Vendor notified.` }))],
      }), `Record disputes for ${bill.invoiceNumber}`, { "Decision-Id": d.path }, `vendor-update:${bill._id}`);
    }
  }
  return { outcome: decision === "approve" ? "approved" : "rejected", summary: `${bill.vendor} ${bill.invoiceNumber}: ${formatMoney(approvedCents)}` };
};

/**
 * AP lists every credit that was open when it read vendor memory, so several held bills can
 * carry the same one. Claim them against the latest CAS-protected record before deducting:
 * a credit already applied to another invoice stays with it. A retry finds its own claim.
 */
async function claimCredits(rt: SeatRuntime, bill: Doc<"bills">, credits: Exception[], vendorExists: boolean) {
  const unavailable = new Map<string, string>();
  if (!credits.length) return { unavailable };
  if (!vendorExists) {
    for (const e of credits) unavailable.set(e.ref!, "vendor record not found");
    return { unavailable };
  }
  const ids = credits.map((e) => e.ref!);
  const path = `vendors/${bill.vendor}.yaml`;
  const open = (v: Vendor | undefined) => (v?.credits ?? []).some((c) => ids.includes(c.id) && !c.appliedTo);
  let latest = await rt.mem.read<Vendor>(path);
  if (open(latest)) {
    const sha = await rt.updateVendor(bill.vendor, (current) => ({
      ...current,
      credits: current.credits.map((c) => (ids.includes(c.id) && !c.appliedTo ? { ...c, appliedTo: bill.invoiceNumber } : c)),
    }), `Apply credits ${ids.join(", ")} to ${bill.invoiceNumber}`, {}, `credit-claim:${bill._id}`);
    latest = await rt.mem.read<Vendor>(path, sha);
  }
  for (const id of ids) {
    const c = latest?.credits.find((x) => x.id === id);
    if (!c) unavailable.set(id, "credit not found in vendor memory");
    else if (c.appliedTo !== bill.invoiceNumber) unavailable.set(id, c.appliedTo ? `already applied to ${c.appliedTo}` : "not claimed");
  }
  return { unavailable };
}

/**
 * Route a payment to the approvals it still needs: the controller within its limit, the CFO
 * agent as the independent agent approver, and the human CFO when policy requires a human or
 * no second agent can cover the amount. Runs again after the human answers; it never asks a
 * human who has already approved.
 */
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
  const what = `${intent.payee} ${formatMoney(intent.amountCents)}`;
  const withinMine = canApprovePayment(ROLE_CAPABILITIES.controller, intent);
  let approvals = intent.approvals;
  if (withinMine && !approvals.some((a) => a.seatId === rt.seat.seatId)) {
    const r = await rt.kernel.client.mutation(api.payments.approvePayment, { ...rt.kernel.auth, intentId });
    if (!r.ok) throw new Error(`approvePayment: ${r.code} ${r.error}`);
    if (r.status === "approved") return { outcome: "approved", summary: what };
    approvals = [...approvals, { seatId: rt.seat.seatId, at: Date.now(), kind: "agent" }];
  }

  const seats = await rt.kernel.client.query(api.seats.list, { runId: rt.runId });
  const roleOf = (seatId: string) => seats.find((s) => s.seatId === seatId)?.role;
  const cfoAvailable = !approvals.some((a) => roleOf(a.seatId) === "cfo_agent") && canApprovePayment(ROLE_CAPABILITIES.cfo_agent, intent) &&
    seats.some((s) => s.role === "cfo_agent" && s.status === "active" && s.seatId !== intent.requestedBy);
  if (cfoAvailable) await rt.handoff("payments.second_approval", "cfo_agent", { intentId }, `second:${intentId}`, task._id, 2);
  const humanApproved = approvals.some((a) => a.kind === "human");
  const agentsCover = approvals.length + (cfoAvailable ? 1 : 0) >= intent.requiredApprovals;
  if (humanApproved || (agentsCover && !intent.requiresHuman)) {
    if (agentsCover) return { outcome: "routed", summary: `${what}; ${cfoAvailable ? "remaining approval routed to the CFO agent" : "waiting on approvals"}` };
    // requestPayment refuses unsatisfiable requests; this is reachable only if staffing changed since.
    await rt.note("blocked", `Payment to ${what} cannot get ${intent.requiredApprovals} independent approvals from active seats`, { intentId });
    return { outcome: "blocked", summary: "no remaining approver" };
  }
  await rt.ask({
    to: "human_cfo",
    severity: "decision",
    title: `Approve ${formatMoney(intent.amountCents)} to ${vendorRec?.vendor.legalName ?? intent.payee}`,
    body: `${intent.billIds.length} approved bill(s), remit to ${intent.remitTo.bank} ****${intent.remitTo.accountLast4} (verified ${vendorRec?.vendor.remitTo.verifiedOn}). ` +
      `Controller ${withinMine ? "approved" : "is over its limit"}${cfoAvailable ? "; the CFO agent is the other approver" : ""}. ` +
      (intent.requiresHuman ? "Policy requires a human at this amount." : "No second agent can approve this amount, so a human must."),
    effect: { kind: "payment", paymentIntentId: intentId },
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
      const rec = await rt.mem.read<unknown>(p, head);
      if (!rec) {
        problems.push(`${p}: unreadable`);
        continue;
      }
      // compileParser validates the spec (schema and regex safety) and refuses legacy code.
      // Every stored test must then parse, pass the schema and arithmetic checks, and match.
      try {
        const parser = compileParser(rec);
        const { id, tests } = rec as ParserRecord;
        if (p !== `integrations/parsers/${id}.yaml`) problems.push(`${p}: record id ${id} does not match its path`);
        if (!tests.length) problems.push(`${p}: no tests`);
        for (const [i, t] of tests.entries()) {
          const got = parseWith([parser], t.input);
          if (!got.ok) problems.push(`${p}: test ${i + 1}: ${got.reason}`);
          else if (!isDeepStrictEqual(got.invoice, t.expected)) problems.push(`${p}: test ${i + 1} output differs from expected`);
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
