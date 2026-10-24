import { api } from "../../core/kernel-client";
import { applyRate, formatMoney } from "../../core/money";
import type { Handler, SeatRuntime } from "../runtime";

interface BankTxn {
  account: "deposits" | "operating" | "payroll";
  txnId: string;
  date: string;
  amountCents: number;
  description: string;
  bankRef?: string;
  detail?: { store: string; salesDate: string; grossCents: number; feeCents: number; transactions: number };
}

async function post(rt: SeatRuntime, key: string, date: string, memo: string, ref: string, lines: { account: string; debit: number; credit: number; dims?: Record<string, string> }[], decisionPath?: string, memorySha?: string) {
  const r = await rt.kernel.client.mutation(api.ledger.postEntry, {
    ...rt.kernel.auth, idempotencyKey: key, date, memo, source: { kind: "bank_match", ref }, lines, decisionPath, memorySha,
  });
  if (!r.ok) throw new Error(`post ${memo}: ${r.code} ${r.error}`);
  return r;
}

/** Match one bank line to what it pays for, post it, and flag anything that doesn't reconcile. */
export const matchBankTxn: Handler = async (rt, task) => {
  const e = await rt.event(task.payload.eventId);
  const t = e.payload as BankTxn;

  // Card processor settlement: verify the fee against the contracted rate before booking it.
  if (t.account === "deposits" && t.description.startsWith("ADYEN SETTLEMENT") && t.detail) {
    const store = await rt.store(t.detail.store);
    const rateBps = store?.cardProcessor.contractedRateBps ?? 260;
    const perTxn = store?.cardProcessor.perTxnCents ?? 10;
    const expectedFee = applyRate(t.detail.grossCents, rateBps / 10_000) + t.detail.transactions * perTxn;
    const actualFee = t.detail.grossCents - t.amountCents;
    const over = actualFee - expectedFee;
    let decisionPath: string | undefined;
    let memorySha: string | undefined;
    if (over > 100) {
      const d = await rt.decide({
        kind: "card_fee", subject: { type: "deposit", id: t.txnId }, outcome: "hold", confidence: 0.96, task: task._id, amountCents: over,
        summary: `Processor fee ${formatMoney(actualFee)} exceeds contracted ${(rateBps / 100).toFixed(2)}% + ${perTxn}c (${formatMoney(expectedFee)}) by ${formatMoney(over)}`,
        facts: [{ key: "settlement", value: t.detail, source: { kind: "event", ref: e.externalId } }, { key: "contract.rateBps", value: rateBps, source: { kind: "memory", ref: `stores/${t.detail.store}.yaml` } }],
        rules: [{ path: `stores/${t.detail.store}.yaml`, key: "cardProcessor" }],
      });
      decisionPath = d.path;
      memorySha = d.memorySha;
      await rt.ask({ to: "controller", severity: "info", title: `Card fees over contract at ${t.detail.store}`, body: d.path, evidence: [{ label: "decision", ref: d.path }] });
    }
    await post(rt, `bank:${t.txnId}`, t.date, `Card settlement ${t.detail.store} ${t.detail.salesDate}`, t.txnId, [
      { account: "1020", debit: t.amountCents, credit: 0, dims: { store: t.detail.store } },
      { account: "5400", debit: actualFee, credit: 0, dims: { store: t.detail.store } },
      { account: "1100", debit: 0, credit: t.detail.grossCents, dims: { store: t.detail.store } },
    ], decisionPath, memorySha);
    return { outcome: over > 100 ? "posted_flagged" : "posted", summary: `${t.detail.store} ${formatMoney(t.amountCents)}` };
  }

  // Delivery platform payout: book it against the platform receivable using the payout report.
  if (t.account === "deposits" && / PAYOUT /.test(t.description)) {
    const reportId = t.description.split(" PAYOUT ")[1]!.trim();
    const report = (await rt.eventsOfType("payout.report")).find((r) => (r.payload as { reportId: string }).reportId === reportId);
    if (!report) return { outcome: "retry", summary: `payout report ${reportId} not in yet` };
    const lines = (report.payload as { lines: { store: string; grossCents: number; commissionCents: number; refundsCents: number; adjustmentsCents: number; netCents: number }[] }).lines;
    const gross = lines.reduce((s, l) => s + l.grossCents, 0);
    const fees = lines.reduce((s, l) => s + l.commissionCents + l.refundsCents - l.adjustmentsCents, 0);
    if (gross - fees !== t.amountCents) return { outcome: "mismatch", summary: `deposit ${t.amountCents} != report net ${gross - fees}` };
    await post(rt, `bank:${t.txnId}`, t.date, `Delivery payout ${reportId}`, t.txnId, [
      { account: "1020", debit: t.amountCents, credit: 0 },
      { account: "5410", debit: fees, credit: 0 },
      { account: "1110", debit: 0, credit: gross },
    ]);
    return { outcome: "posted", summary: `${reportId} ${formatMoney(t.amountCents)}` };
  }

  // Operating account debits: every one must be a payment we sent.
  if (t.account === "operating" && t.amountCents < 0) {
    const intents = await rt.kernel.client.query(api.payments.intents, { runId: rt.runId, status: "settled" });
    const ours = t.bankRef ? intents.find((i) => i.bankRef === t.bankRef) : undefined;
    if (ours && ours.amountCents === -t.amountCents) {
      return { outcome: "reconciled", summary: `${t.bankRef} matches payment to ${ours.payee}` };
    }
    const d = await rt.decide({
      kind: "unexplained_debit", subject: { type: "bank_txn", id: t.txnId }, outcome: "hold", confidence: 0.97, task: task._id, amountCents: -t.amountCents,
      summary: `Debit ${formatMoney(-t.amountCents)} "${t.description}" matches no payment we sent; parked in suspense and escalated`,
      facts: [{ key: "bank_txn", value: t, source: { kind: "event", ref: e.externalId } }],
      rules: [{ path: "policies/materiality.yaml", key: "bankMatchToleranceCents" }],
    });
    await post(rt, `bank:${t.txnId}`, t.date, `Unidentified debit: ${t.description}`, t.txnId, [
      { account: "6900", debit: -t.amountCents, credit: 0 },
      { account: "1000", debit: 0, credit: -t.amountCents },
    ], d.path, d.memorySha);
    await rt.ask({
      to: "human_cfo", severity: "urgent", title: `Unrecognized ${formatMoney(-t.amountCents)} debit from the operating account`,
      body: `"${t.description}" on ${t.date} doesn't match any payment, vendor or contract. It's parked in suspense. Do you recognize it?`,
      evidence: [{ label: "decision", ref: d.path }], options: [{ id: "dispute", label: "Dispute with the bank" }, { id: "known", label: "I recognize it" }], taskId: task._id,
    });
    return { outcome: "flagged", summary: t.description };
  }
  return { outcome: "ignored", summary: `${t.account} ${t.description}` };
};

/** Check a payout report against our own POS: platform gross must match, adjustments must be explained. */
export const reconcilePayout: Handler = async (rt, task) => {
  const e = await rt.event(task.payload.eventId);
  const r = e.payload as { platform: string; reportId: string; periodStart: string; periodEnd: string; lines: { store: string; grossCents: number; adjustmentsCents: number }[]; notes: { store: string; adjustmentCents: number; reason: string }[] };
  const tol = (await rt.mem.read<{ payoutToleranceCents: number }>("policies/materiality.yaml"))?.payoutToleranceCents ?? 500;
  const sales = await rt.eventsOfType("sales.daily", r.periodStart, r.periodEnd);
  const problems: string[] = [];
  let atRisk = 0;
  for (const l of r.lines) {
    const pos = sales.filter((s) => (s.payload as { store: string }).store === l.store).reduce((sum, s) => sum + (((s.payload as { marketplace: Record<string, number> }).marketplace)[r.platform] ?? 0), 0);
    if (Math.abs(pos - l.grossCents) > tol) {
      problems.push(`${l.store}: platform gross ${formatMoney(l.grossCents)} vs POS ${formatMoney(pos)}`);
      atRisk += Math.abs(pos - l.grossCents);
    }
    const explained = r.notes.filter((n) => n.store === l.store).reduce((s, n) => s + n.adjustmentCents, 0);
    if (l.adjustmentsCents !== explained && Math.abs(l.adjustmentsCents - explained) > tol) {
      problems.push(`${l.store}: unexplained adjustment ${formatMoney(l.adjustmentsCents - explained)}`);
      atRisk += Math.abs(l.adjustmentsCents - explained);
    }
  }
  const d = await rt.decide({
    kind: "payout_reconciliation", subject: { type: "payout", id: r.reportId }, outcome: problems.length ? "hold" : "act", confidence: 0.95, task: task._id, amountCents: atRisk,
    summary: problems.length ? `Dispute ${r.platform} ${r.reportId}: ${problems.join("; ")}` : `${r.reportId} reconciles to POS`,
    facts: [{ key: "report", value: r.reportId, source: { kind: "event", ref: e.externalId } }],
    rules: [{ path: "policies/materiality.yaml", key: "payoutToleranceCents" }],
  });
  if (problems.length) {
    await rt.ask({ to: "controller", severity: "info", title: `Opened dispute with ${r.platform} for ${formatMoney(atRisk)}`, body: problems.join("\n"), evidence: [{ label: "decision", ref: d.path }] });
  }
  return { outcome: problems.length ? "disputed" : "reconciled", summary: r.reportId };
};
