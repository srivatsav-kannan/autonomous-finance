import { api } from "../../core/kernel-client";
import { formatMoney } from "../../core/money";
import type { Handler } from "../runtime";

/** The CFO agent's end-of-day note to the human: numbers, what happened, what needs them. */
export const dailyDigest: Handler = async (rt, task) => {
  const date = String(task.payload.occurredOn ?? (await rt.simDate()));
  const o = await rt.kernel.client.query(api.observe.overview, { runId: rt.runId });
  const open = await rt.kernel.client.query(api.asks.list, { runId: rt.runId, status: "open", to: "human_cfo" });
  const held = await rt.kernel.client.query(api.ap.bills, { runId: rt.runId, status: "held" });
  const body = [
    `Cash ${formatMoney(o.cashCents)} · AP ${formatMoney(o.apCents)} · revenue to date ${formatMoney(o.revenueCents)} · gift card liability ${formatMoney(o.giftCardLiabilityCents)}`,
    `${o.entries} ledger entries · ${o.agentTurns} agent turns (${o.llmTurns} used Claude, ${formatMoney(Math.round(o.costMicros / 10_000))}) · ${o.blockedAttempts} blocked attempts`,
    `${held.length} bill(s) held for review · ${open.length} decision(s) waiting on you`,
  ].join("\n");
  await rt.ask({ to: "human_cfo", severity: "info", title: `Daily digest ${date}`, body, options: [{ id: "ack", label: "Got it" }] });
  return { outcome: "sent", summary: body.split("\n")[0] };
};

/**
 * Close checklist. The controller signs only when the ledger chain verifies, suspense is empty
 * and received invoices have kernel dispositions; the human CFO co-signs (two-key close).
 */
export const runClose: Handler = async (rt, task) => {
  const period = String(task.payload.period ?? (await rt.simDate()).slice(0, 7));
  const chain = await rt.kernel.client.query(api.ledger.verifyChain, { runId: rt.runId });
  const tb = await rt.kernel.client.query(api.ledger.trialBalance, { runId: rt.runId, period });
  const suspense = tb.find((a) => a.code === "6900")?.net ?? 0;
  const sources = await rt.kernel.client.query(api.ledger.closeReadiness, { runId: rt.runId, period });
  const net = tb.reduce((s, a) => s + a.net, 0);
  const checks = [
    { ok: chain.ok, text: chain.ok ? `ledger hash chain verifies (${chain.entries} entries)` : `ledger chain broken at #${"brokenAt" in chain ? chain.brokenAt : "?"}` },
    { ok: net === 0, text: `trial balance nets to ${formatMoney(net)}` },
    { ok: suspense === 0, text: suspense === 0 ? "suspense is empty" : `${formatMoney(suspense)} in suspense` },
    { ok: sources.ready, text: sources.ready ? `all ${sources.sourceInvoiceCount} received invoice(s) have resolved dispositions and accruals`
      : `${sources.blockerCount} source/bill blocker(s): ${sources.blockers.map((b) => b.reason).join("; ")}` },
  ];
  const tag = `close-${period}-${Date.now()}`;
  const checklistReady = checks.every((c) => c.ok);
  // The tag must contain the reviewed decision, rather than being created before it.
  // Snapshot identity also gives a retry after changed sources a distinct review.
  let d = await rt.decide({
    kind: "close", subject: { type: "period", id: `${period}@${sources.snapshotHash}` },
    outcome: checklistReady ? "act" : "hold", confidence: 0.95, task: task._id,
    summary: `${checklistReady ? "Ready for kernel close validation" : "Not ready to close"} ${period}: ${checks.map((c) => c.text).join("; ")}`,
    facts: [
      ...checks.map((c, i) => ({ key: `check.${i}`, value: c.text, source: { kind: "ledger" as const, ref: period } })),
      { key: "close.snapshot", value: sources.snapshotHash, source: { kind: "ledger", ref: period } },
    ], rules: [],
  });
  if (checks.every((c) => c.ok)) {
    await rt.mem.tag(tag, `Close review candidate for ${period}`, rt.author);
    const signed = await rt.kernel.client.mutation(api.ledger.signClose, {
      ...rt.kernel.auth, period, memoryTag: tag, expectedSnapshotHash: sources.snapshotHash,
    });
    if (!signed.ok) {
      checks.push({ ok: false, text: `Kernel refused close signature: ${signed.error}` });
      d = await rt.decide({
        kind: "close_refused", subject: { type: "period", id: `${period}@${sources.snapshotHash}` },
        outcome: "hold", confidence: 1, task: task._id,
        summary: `Not ready to close ${period}: ${signed.error}`,
        facts: [{ key: "kernel.refusal", value: signed, source: { kind: "ledger", ref: period } }], rules: [],
      });
    }
  }
  const ready = checks.every((c) => c.ok);
  await rt.handoff("audit.review", "auditor", { period, closeDecision: d.path }, `audit:${period}:${tag}`, task._id, 5);
  await rt.ask({
    to: "human_cfo", severity: "decision", title: ready ? `Co-sign the ${period} close` : `${period} isn't ready to close`,
    body: checks.map((c) => `${c.ok ? "OK" : "OPEN"}  ${c.text}`).join("\n"),
    options: ready ? [{ id: "sign", label: "Co-sign close" }, { id: "hold", label: "Hold" }] : [{ id: "ack", label: "Acknowledge" }],
    evidence: [{ label: "decision", ref: d.path }], taskId: task._id,
  });
  return { outcome: ready ? "signed" : "not_ready", summary: checks.filter((c) => !c.ok).map((c) => c.text).join("; ") || "clean" };
};

/** Independent review: verify the chain, list blocked attempts, sample low-confidence decisions. */
export const auditReview: Handler = async (rt, task) => {
  const chain = await rt.kernel.client.query(api.ledger.verifyChain, { runId: rt.runId });
  const violations = await rt.kernel.client.query(api.observe.violations, { runId: rt.runId });
  const log = await rt.mem.log({ limit: 400 });
  const lowConfidence = log.filter((c) => c.trailers.Confidence && Number(c.trailers.Confidence) < 0.92).slice(0, 5);
  const byOp = new Map<string, number>();
  for (const v of violations) byOp.set(v.operation, (byOp.get(v.operation) ?? 0) + 1);
  const body = [
    chain.ok ? `Ledger hash chain verified: ${chain.entries} entries, head ${"head" in chain ? String(chain.head).slice(0, 12) : ""}` : "LEDGER CHAIN BROKEN",
    `${violations.length} blocked attempts: ${[...byOp].map(([op, n]) => `${op} x${n}`).join(", ") || "none"}`,
    `Sampled ${lowConfidence.length} lowest-confidence decisions: ${lowConfidence.map((c) => c.subject).join(" | ") || "none"}`,
  ].join("\n");
  await rt.decide({ kind: "audit", subject: { type: "period", id: String(task.payload.period) }, outcome: chain.ok ? "act" : "hold", confidence: 0.95, task: task._id,
    summary: body.split("\n")[0]!, facts: [{ key: "violations", value: violations.length, source: { kind: "ledger", ref: "violations" } }], rules: [] });
  await rt.ask({ to: "human_cfo", severity: "info", title: `Internal audit report ${task.payload.period}`, body, options: [{ id: "ack", label: "Received" }] });
  return { outcome: "reported", summary: body.split("\n")[0] };
};
