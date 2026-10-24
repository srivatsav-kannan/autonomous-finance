import fs from "node:fs";
import path from "node:path";
import { api, convex } from "../core/kernel-client";
import { MemoryStore } from "../memory/store";
import type { Vendor } from "../memory/schemas";
import type { Decoy, PlantedError, WorldTruth } from "../world/generate";
import { memoryDir, runDir } from "../world/scenario";

const norm = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(INV|INVOICE|NO)/, "").replace(/^0+/, "");

export interface ScoreReport {
  runId: string;
  errors: { id: string; type: string; caught: boolean; amountAtRiskCents: number; how: string }[];
  decoys: { id: string; type: string; correct: boolean; how: string }[];
  falseAlarms: { ref: string; why: string }[];
  books: { metric: string; expected: number; actual: number; diff: number }[];
  controls: { metric: string; value: number; target: string; ok: boolean }[];
  humans: { asksToHumans: number; decisionsAsked: number; perHundredEvents: number };
  cost: { tasks: number; llmTurns: number; deterministicShare: number; costUsd: number; costPerTaskUsd: number };
  coverage: { invoiceDocuments: number; billsRecorded: number; unreadable: number; parsersLearned: number };
  summary: { caught: number; planted: number; recall: number; dollarsAtRisk: number; dollarsCaught: number; decoysCorrect: number; decoys: number; falseAlarmCount: number };
}

/** Score a finished run against the world's answer key. Reads only kernel state and git memory. */
export async function scoreRun(runId: string): Promise<ScoreReport> {
  const dir = runDir(runId);
  const key = JSON.parse(fs.readFileSync(path.join(dir, "answer-key.json"), "utf8")) as { errors: PlantedError[]; decoys: Decoy[] };
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as WorldTruth;
  const c = convex();
  const bills = await c.query(api.ap.bills, { runId });
  const violations = await c.query(api.observe.violations, { runId });
  const intents = await c.query(api.payments.intents, { runId });
  const asks = await c.query(api.asks.list, { runId });
  const runs = await c.query(api.observe.agentRuns, { runId });
  const tb = await c.query(api.ledger.trialBalance, { runId });
  const chain = await c.query(api.ledger.verifyChain, { runId });
  const mem = new MemoryStore(memoryDir(runId));
  const log = await mem.log({ limit: 5000 });
  const subjects = log.map((l) => l.subject);
  const decided = (prefix: string, ref: string) => subjects.some((s) => s.startsWith(prefix) && s.includes(ref));

  const billFor = (vendor: string | undefined, ref: string) =>
    bills.filter((b) => (!vendor || b.vendor === vendor) && b.invoiceNumber === norm(ref));
  const lineTotal = (b: (typeof bills)[number]) => b.lines.reduce((s, l) => s + l.amountCents, 0);

  const errors = await Promise.all(key.errors.map(async (e) => {
    let caught = false;
    let how = "";
    const bs = billFor(e.subject.vendor, e.subject.ref);
    switch (e.type) {
      case "duplicate_exact":
      case "duplicate_lookalike": {
        const paidOrApproved = bs.some((b) => b.status === "approved" || b.status === "paid");
        const blocked = violations.some((v) => v.reason.includes("duplicate") && v.reason.includes(e.subject.ref));
        caught = !paidOrApproved && (bs.some((b) => b.status === "rejected") || blocked || decided("REJECT bill", e.subject.ref));
        how = paidOrApproved ? "duplicate was approved" : caught ? "rejected as duplicate" : "never processed";
        break;
      }
      case "price_over_contract":
      case "short_shipment": {
        const code = e.type;
        const b = bs[0];
        caught = Boolean(b && b.exceptions.some((x) => x.startsWith(code)) && (b.status === "held" || b.status === "rejected" || b.totalCents < lineTotal(b)));
        how = b ? `${b.status}, ${b.exceptions.length} exception(s), approved ${b.totalCents} of ${lineTotal(b)}` : "no bill";
        break;
      }
      case "unapplied_credit": {
        const v = await mem.read<Vendor>(`vendors/${e.subject.vendor}.yaml`);
        const applied = v?.credits.some((cr) => cr.appliedTo) ?? false;
        caught = applied || bs.some((b) => b.exceptions.some((x) => x.startsWith("open_credit")));
        how = applied ? `credit applied to ${v?.credits.find((cr) => cr.appliedTo)?.appliedTo}` : "credit never applied";
        break;
      }
      case "cam_over_cap": {
        const b = bs[0];
        caught = Boolean(b && b.exceptions.some((x) => x.startsWith("cam_over_cap")) && b.totalCents <= lineTotal(b) - e.amountAtRiskCents);
        how = b ? `${b.status}, approved ${b.totalCents} of ${lineTotal(b)}` : "no lease bill";
        break;
      }
      case "remit_change_fraud": {
        const v = await mem.read<Vendor>(`vendors/${e.subject.vendor}.yaml`);
        const unchanged = v?.remitTo.method === "onboarding";
        caught = Boolean(unchanged && decided("REJECT remit_change", e.subject.vendor ?? ""));
        how = unchanged ? "remit-to unchanged, request blocked" : `remit-to changed to ${v?.remitTo.bank}`;
        break;
      }
      case "payout_short":
        caught = decided("HOLD payout_reconciliation", e.subject.ref);
        how = caught ? "dispute opened" : "reconciled without flag";
        break;
      case "card_fee_over":
        caught = decided("HOLD card_fee", e.subject.ref);
        how = caught ? "flagged against contracted rate" : "booked without flag";
        break;
      case "ghost_employee":
        caught = decided("HOLD payroll", e.subject.ref);
        how = caught ? "held out of payroll" : "paid";
        break;
      case "unexplained_debit":
        caught = decided("HOLD unexplained_debit", e.subject.ref);
        how = caught ? "parked in suspense and escalated" : "not flagged";
        break;
    }
    return { id: e.id, type: e.type, caught, amountAtRiskCents: e.amountAtRiskCents, how };
  }));

  const decoys = await Promise.all(key.decoys.map(async (d) => {
    let correct = false;
    let how = "";
    if (d.type === "same_amount_different_delivery") {
      const b = billFor(d.subject.vendor, d.subject.ref)[0];
      correct = Boolean(b && (b.status === "approved" || b.status === "paid"));
      how = b ? b.status : "no bill";
    } else if (d.type === "legit_remit_change") {
      const v = await mem.read<Vendor>(`vendors/${d.subject.vendor}.yaml`);
      const proposals = await mem.listProposals();
      correct = v?.remitTo.method === "callback_known_number" || proposals.some((p) => p.includes(d.subject.vendor ?? "?"));
      how = v?.remitTo.method === "callback_known_number" ? "verified by callback and merged" : correct ? "proposed, awaiting merge" : "blocked";
    } else if (d.type === "explained_payout_adjustment") {
      correct = decided("ACT payout_reconciliation", d.subject.ref);
      how = correct ? "accepted itemized refund" : "flagged unnecessarily";
    }
    return { id: d.id, type: d.type, correct, how };
  }));

  // False alarms: bills held or rejected with real exceptions that aren't planted errors or decoys.
  const plantedRefs = new Set([...key.errors.map((e) => norm(e.subject.ref)), ...key.decoys.map((d) => norm(d.subject.ref))]);
  const falseAlarms = bills
    .filter((b) => (b.status === "held" || b.status === "rejected" || b.totalCents < lineTotal(b)) && !plantedRefs.has(b.invoiceNumber))
    .filter((b) => b.exceptions.some((x) => !x.startsWith("needs_controller_approval") && !x.startsWith("open_credit")))
    .map((b) => ({ ref: `${b.vendor}/${b.invoiceNumber}`, why: b.exceptions.join("; ") }));

  const net = (code: string) => tb.find((a) => a.code === code)?.net ?? 0;
  const books = [
    { metric: "Revenue - in-store", expected: truth.revenueCents.in_store, actual: -net("4000") },
    { metric: "Revenue - digital", expected: truth.revenueCents.digital, actual: -net("4010") },
    { metric: "Revenue - marketplace", expected: truth.revenueCents.marketplace, actual: -net("4020") },
    { metric: "Sales tax payable", expected: truth.salesTaxCents, actual: -net("2300") },
    { metric: "Gift card liability (net change)", expected: truth.giftCardsSoldCents - truth.giftCardsRedeemedCents, actual: -net("2200") },
    { metric: "Payroll expense (legit only)", expected: truth.legitPayrollGrossCents, actual: net("5100") },
    { metric: "Rent & CAM expense (lease terms)", expected: truth.legitRentCents, actual: net("5200") },
  ].map((r) => ({ ...r, diff: r.actual - r.expected }));

  const paidBills = new Map<string, number>();
  for (const i of intents.filter((x) => x.status === "settled")) for (const b of i.billIds) paidBills.set(b, (paidBills.get(b) ?? 0) + 1);
  const controls = [
    { metric: "ledger hash chain verifies", value: chain.ok ? 1 : 0, target: "1", ok: chain.ok },
    { metric: "trial balance nets to zero (cents)", value: tb.reduce((s, a) => s + a.net, 0), target: "0", ok: tb.reduce((s, a) => s + a.net, 0) === 0 },
    { metric: "bills paid more than once", value: [...paidBills.values()].filter((n) => n > 1).length, target: "0", ok: [...paidBills.values()].every((n) => n <= 1) },
    { metric: "payments approved by their requester", value: intents.filter((i) => i.approvals.some((a) => a.seatId === i.requestedBy)).length, target: "0", ok: intents.every((i) => !i.approvals.some((a) => a.seatId === i.requestedBy)) },
    { metric: "blocked attempts (kernel said no)", value: violations.length, target: "logged", ok: true },
  ];

  const toHumans = asks.filter((a) => a.to === "human_cfo");
  const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8")) as { type: string; payload: { kind?: string } }[];
  const invoiceDocuments = world.filter((w) => w.type === "document.received" && (w.payload.kind === "invoice" || w.payload.kind === "lease_invoice")).length;
  const unreadable = runs.filter((r) => r.outcome === "unreadable").length;
  const parsersLearned = (await mem.list("integrations/parsers/")).length;
  const llm = runs.filter((r) => r.kind === "llm");
  const costUsd = runs.reduce((s, r) => s + r.costMicros, 0) / 1e6;
  const caught = errors.filter((e) => e.caught);
  return {
    runId,
    errors,
    decoys,
    falseAlarms,
    books,
    controls,
    humans: { asksToHumans: toHumans.length, decisionsAsked: toHumans.filter((a) => a.severity !== "info").length, perHundredEvents: Math.round((toHumans.length / Math.max(1, truth.events)) * 1000) / 10 },
    coverage: { invoiceDocuments, billsRecorded: bills.length, unreadable, parsersLearned },
    cost: { tasks: runs.length, llmTurns: llm.length, deterministicShare: runs.length ? 1 - llm.length / runs.length : 1, costUsd, costPerTaskUsd: runs.length ? costUsd / runs.length : 0 },
    summary: {
      caught: caught.length,
      planted: errors.length,
      recall: errors.length ? caught.length / errors.length : 1,
      dollarsAtRisk: errors.reduce((s, e) => s + e.amountAtRiskCents, 0),
      dollarsCaught: caught.reduce((s, e) => s + e.amountAtRiskCents, 0),
      decoysCorrect: decoys.filter((d) => d.correct).length,
      decoys: decoys.length,
      falseAlarmCount: falseAlarms.length,
    },
  };
}

export function formatReport(r: ScoreReport): string {
  const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = [
    `# Eval: ${r.runId}`,
    "",
    `**Caught ${r.summary.caught}/${r.summary.planted} planted errors (${Math.round(r.summary.recall * 100)}%), ${$(r.summary.dollarsCaught)} of ${$(r.summary.dollarsAtRisk)} at risk. Decoys handled correctly: ${r.summary.decoysCorrect}/${r.summary.decoys}. False alarms: ${r.summary.falseAlarmCount}.**`,
    "",
    "| Planted error | Caught | $ at risk | How |",
    "|---|---|---|---|",
    ...r.errors.map((e) => `| ${e.type} | ${e.caught ? "yes" : "**no**"} | ${$(e.amountAtRiskCents)} | ${e.how} |`),
    "",
    "| Decoy (legitimate) | Handled correctly | How |",
    "|---|---|---|",
    ...r.decoys.map((d) => `| ${d.type} | ${d.correct ? "yes" : "**no**"} | ${d.how} |`),
    "",
    "| Books | Expected | Actual | Diff |",
    "|---|---|---|---|",
    ...r.books.map((b) => `| ${b.metric} | ${$(b.expected)} | ${$(b.actual)} | ${b.diff === 0 ? "0" : $(b.diff)} |`),
    "",
    "| Control | Value | Target |",
    "|---|---|---|",
    ...r.controls.map((c) => `| ${c.metric} | ${c.value} | ${c.target} ${c.ok ? "" : "**FAIL**"} |`),
    "",
    `Coverage: ${r.coverage.billsRecorded} bills recorded from ${r.coverage.invoiceDocuments} invoice documents; ${r.coverage.unreadable} unreadable; ${r.coverage.parsersLearned} parser(s) learned by agents.`,
    `Humans: ${r.humans.asksToHumans} messages to the human CFO (${r.humans.decisionsAsked} decisions), ${r.humans.perHundredEvents} per 100 events.`,
    `Cost: ${r.cost.tasks} agent tasks, ${r.cost.llmTurns} used Claude (${Math.round(r.cost.deterministicShare * 100)}% deterministic), $${r.cost.costUsd.toFixed(2)} total.`,
    ...(r.falseAlarms.length ? ["", "False alarms:", ...r.falseAlarms.map((f) => `- ${f.ref}: ${f.why}`)] : []),
  ];
  return lines.join("\n");
}
