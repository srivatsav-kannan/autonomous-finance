import { api } from "../../core/kernel-client";
import { formatMoney, parseMoney } from "../../core/money";
import type { Handler } from "../runtime";

/** Daily sales by channel from the POS export, with tax and gift-card movements. */
export const postDailyRevenue: Handler = async (rt, task) => {
  const e = await rt.event(task.payload.eventId);
  const s = e.payload as {
    store: string; date: string; in_store: { grossCents: number }; digital: { grossCents: number }; marketplace: Record<string, number>;
    salesTaxCents: number; giftCardsSoldCents: number; giftCardsRedeemedCents: number;
  };
  const marketplace = Object.values(s.marketplace).reduce((a, b) => a + b, 0);
  const collections = s.in_store.grossCents + s.digital.grossCents + s.salesTaxCents - s.giftCardsRedeemedCents + s.giftCardsSoldCents;
  const dims = { store: s.store };
  const lines = [
    { account: "1100", debit: collections, credit: 0, dims },
    { account: "2200", debit: s.giftCardsRedeemedCents, credit: 0, dims },
    { account: "1110", debit: marketplace, credit: 0, dims },
    { account: "4000", debit: 0, credit: s.in_store.grossCents, dims },
    { account: "4010", debit: 0, credit: s.digital.grossCents, dims },
    { account: "4020", debit: 0, credit: marketplace, dims },
    { account: "2300", debit: 0, credit: s.salesTaxCents, dims },
    { account: "2200", debit: 0, credit: s.giftCardsSoldCents, dims },
  ].filter((l) => l.debit > 0 || l.credit > 0);
  const r = await rt.kernel.client.mutation(api.ledger.postEntry, {
    ...rt.kernel.auth, idempotencyKey: `revenue:${e.externalId}`, date: s.date, memo: `Daily sales ${s.store} ${s.date}`,
    source: { kind: "revenue_daily", ref: e.externalId }, lines, taskId: task._id,
  });
  if (!r.ok) throw new Error(`revenue post: ${r.code} ${r.error}`);
  return { outcome: "posted", summary: `${s.store} ${formatMoney(s.in_store.grossCents + s.digital.grossCents + marketplace)}` };
};

/**
 * Payroll: every person on the register must be active on the HR roster as of pay date.
 * Unknown, mismatched, and inactive people are held out and escalated.
 */
export const processPayroll: Handler = async (rt, task) => {
  const e = await rt.event(task.payload.eventId);
  const reg = e.payload as { registerId: string; store: string; payDate: string; employees: { id: string; name: string; grossCents: number }[] };
  const [rosterEvents, changeEvents] = await Promise.all([
    rt.eventsOfType("hr.roster", undefined, reg.payDate),
    rt.eventsOfType("hr.roster_change", undefined, reg.payDate),
  ]);
  type RosterEmployee = { id: string; store: string; status: string; terminatedOn?: string };
  // HR rosters are full snapshots. A newer snapshot supersedes older snapshots
  // and earlier changes, so a corrected/re-hired employee can become active again.
  const roster = rosterEvents
    .map((event) => ({ event, payload: event.payload as { asOf: string; employees: RosterEmployee[] } }))
    .filter((r) => typeof r.payload.asOf === "string" && r.payload.asOf <= reg.payDate)
    .sort((a, b) => b.payload.asOf.localeCompare(a.payload.asOf) || b.event._creationTime - a.event._creationTime)[0];
  const terminations = changeEvents
    .map((event) => ({ event, payload: event.payload as { employeeId: string; change: string; effective: string } }))
    .filter(({ payload: t }) => t.change === "terminated" && t.effective <= reg.payDate && (!roster || t.effective >= roster.payload.asOf));
  const checked = reg.employees.map((emp) => {
    let reason: string | undefined;
    const matches = roster?.payload.employees.filter((person) => person.id === emp.id) ?? [];
    const person = matches[0];
    const terminated = terminations.find(({ payload: t }) => t.employeeId === emp.id);
    if (!roster) reason = `no HR roster effective by ${reg.payDate}`;
    else if (!person) reason = "not on the HR roster";
    else if (matches.length > 1) reason = "multiple HR roster records for this employee";
    else if (person.store !== reg.store) reason = `HR store ${person.store} does not match register store ${reg.store}`;
    else if (person.status !== "active") reason = `HR status is ${person.status}`;
    else if (person.terminatedOn && person.terminatedOn <= reg.payDate) reason = `terminated ${person.terminatedOn}`;
    else if (terminated) reason = `terminated ${terminated.payload.effective}`;
    return { ...emp, reason };
  });
  const held = checked.filter((emp) => emp.reason !== undefined);
  const ok = checked.filter((emp) => emp.reason === undefined);
  const gross = ok.reduce((s, x) => s + x.grossCents, 0);
  const d = await rt.decide({
    kind: "payroll", subject: { type: "payroll", id: reg.registerId }, outcome: held.length ? "hold" : "act", confidence: 0.97, task: task._id,
    amountCents: held.reduce((s, x) => s + x.grossCents, 0),
    summary: held.length
      ? `Accrued ${formatMoney(gross)} for ${ok.length} people; held ${held.map((h) => `${h.name} (${formatMoney(h.grossCents)}): ${h.reason}`).join("; ")}`
      : `Accrued ${formatMoney(gross)} for ${ok.length} people; roster matches`,
    facts: [
      { key: "register", value: reg.registerId, source: { kind: "event", ref: e.externalId } },
      ...(roster ? [{ key: "roster", value: roster.payload.asOf, source: { kind: "event" as const, ref: roster.event.externalId } }] : []),
      ...terminations.map(({ event, payload: t }) => ({ key: `terminated.${t.employeeId}`, value: t.effective, source: { kind: "event" as const, ref: event.externalId } })),
    ],
    rules: [{ path: "playbooks/payroll_accountant.yaml", key: "roster-check" }],
  });
  if (gross !== 0) {
    const r = await rt.kernel.client.mutation(api.ledger.postEntry, {
      ...rt.kernel.auth, idempotencyKey: `payroll:${reg.registerId}`, date: reg.payDate, memo: `Payroll ${reg.store} ${reg.payDate}`,
      source: { kind: "payroll", ref: reg.registerId }, taskId: task._id, decisionPath: d.path, memorySha: d.memorySha,
      lines: [
        { account: "5100", debit: gross, credit: 0, dims: { store: reg.store } },
        { account: "2100", debit: 0, credit: gross, dims: { store: reg.store } },
      ],
    });
    if (!r.ok) throw new Error(`payroll post: ${r.code} ${r.error}`);
  }
  if (held.length) {
    await rt.ask({
      to: "human_cfo", severity: "decision", title: `Payroll includes ${held.length} employee(s) with HR exceptions at ${reg.store}`,
      body: held.map((h) => `${h.name} (${h.id}): ${formatMoney(h.grossCents)}, ${h.reason}`).join("\n") + "\n\nTheir pay was held out of the run. Verify their HR record and eligibility before releasing pay, or keep blocked.",
      options: [{ id: "block", label: "Keep blocked" }, { id: "release", label: "Release after HR review" }], evidence: [{ label: "decision", ref: d.path }], taskId: task._id,
    });
  }
  return { outcome: held.length ? (ok.length ? "held_partial" : "held") : "posted", summary: `${reg.registerId}: ${formatMoney(gross)}` };
};

/** Rent statements: base rent per lease, CAM capped per lease; overages are short-paid and disputed. */
export const processLeaseInvoice: Handler = async (rt, task) => {
  const e = await rt.event(task.payload.eventId);
  const text = String((e.payload as { text: string }).text);
  const storeId = /\(([a-z0-9-]+)\)/.exec(text)?.[1] ?? "";
  const inv = /Rent Statement (\S+)/.exec(text)?.[1] ?? e.externalId;
  const base = parseMoney(/Base rent: (\$[\d,]+\.\d{2})/.exec(text)?.[1] ?? "0");
  const cam = parseMoney(/\(CAM\): (\$[\d,]+\.\d{2})/.exec(text)?.[1] ?? "0");
  const date = /Statement date: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? (await rt.simDate());
  const due = /Due: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? date;
  const store = await rt.store(storeId);
  if (!store) throw new Error(`lease invoice for unknown store ${storeId}`);
  const exceptions: { code: string; detail: string; deltaCents: number }[] = [];
  if (base !== store.lease.baseRentCents) exceptions.push({ code: "rent_mismatch", detail: `base rent ${formatMoney(base)} vs lease ${formatMoney(store.lease.baseRentCents)}`, deltaCents: store.lease.baseRentCents - base });
  if (cam > store.lease.camCapCents) exceptions.push({ code: "cam_over_cap", detail: `CAM ${formatMoney(cam)} exceeds lease cap ${formatMoney(store.lease.camCapCents)}`, deltaCents: store.lease.camCapCents - cam });
  const total = base + cam;
  const recommended = total + exceptions.reduce((s, x) => s + x.deltaCents, 0);
  const d = await rt.decide({
    kind: "lease_invoice", subject: { type: "lease", id: inv }, outcome: exceptions.length ? "hold" : "act", confidence: 0.97, task: task._id, amountCents: total,
    summary: exceptions.length ? `Short-pay to ${formatMoney(recommended)}: ${exceptions.map((x) => x.detail).join("; ")}` : `Rent ${formatMoney(total)} matches the lease`,
    facts: [{ key: "statement", value: { base, cam }, source: { kind: "event", ref: e.externalId } }, { key: "lease", value: store.lease, source: { kind: "memory", ref: `stores/${storeId}.yaml` } }],
    rules: [{ path: `stores/${storeId}.yaml`, key: "lease.camCapCents" }],
  });
  const r = await rt.kernel.client.mutation(api.ap.recordBill, {
    ...rt.kernel.auth, idempotencyKey: `bill:${e.externalId}`, vendor: store.lease.landlord, invoiceNumber: inv, invoiceDate: date, dueDate: due, store: storeId,
    lines: [
      { description: "Base rent", quantity: 1, unitCents: base, amountCents: base },
      { description: "CAM", quantity: 1, unitCents: cam, amountCents: cam },
    ],
    totalCents: total, documentEventId: String(task.payload.eventId), decision: "hold",
    exceptions: exceptions.length ? exceptions.map((x) => `${x.code}: ${x.detail}`) : ["needs_controller_approval: rent over AP auto-approve limit"],
    expenseAccount: "5200", decisionPath: d.path, memorySha: d.memorySha, taskId: task._id,
  });
  if (!r.ok) throw new Error(`lease bill: ${r.code} ${r.error}`);
  await rt.handoff("ap.review_held", "controller", {
    billId: r.billId, recommendedCents: recommended, decisionPath: d.path,
    exceptions: exceptions.length ? exceptions : [{ code: "needs_controller_approval", detail: "rent over AP auto-approve limit", deltaCents: 0 }],
  }, `review:${r.billId}`, task._id, 2);
  return { outcome: exceptions.length ? "held" : "queued_for_approval", summary: `${inv} ${formatMoney(total)}` };
};
