/** Live Convex regressions. Run with tsx, or via the opt-in Vitest test. */
import "../src/core/env";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AdminClient, SeatClient, api } from "../src/core/kernel-client";
import { ROLE_CAPABILITIES } from "../src/core/roles";
import { Team } from "../src/agents/team";
import { renderInvoice } from "../src/world/documents";
import { createScenario, runDir } from "../src/world/scenario";
import { emitDay } from "../src/world/emitter";
import type { Vendor, Store } from "../src/memory/schemas";

export const RECOVERY_CASES = ["before-send", "lost-response", "settle-failure", "kill-after-send", "success-replay", "changed-remit", "changed-remit-before-send", "permanent-bank-failure", "closed-period"] as const;
export type RecoveryCase = typeof RECOVERY_CASES[number];
const ORIGINAL_DATE = "2026-01-10";
const RESTART_DATE = "2026-01-11";
const AMOUNT = 5000;

async function worker(runId: string, mode: string, label: string) {
  const markerPath = path.resolve(runDir(runId), `${label}.json`);
  const workerPath = fileURLToPath(new URL("./payment-recovery-worker.ts", import.meta.url));
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, runId, mode, markerPath], {
      cwd: process.cwd(), env: { ...process.env, AGENT_LLM: "off" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`worker timed out: ${label}`)); }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  if (mode === "kill-after-send") assert.equal(exited.signal, "SIGKILL", exited.output);
  else assert.equal(exited.code, 0, exited.output);
  assert(fs.existsSync(markerPath), `worker did not reach expected boundary: ${label}`);
  return { ...exited, ...JSON.parse(fs.readFileSync(markerPath, "utf8")) } as {
    code: number | null; signal: string | null; output: string; mode: string; injected: boolean; sendCalls: number; processId?: number; bankAccepted?: boolean;
  };
}

async function readback(admin: AdminClient, runId: string) {
  const [intents, bills, entries, chain, trialBalance, agentRuns, queueStats, violations] = await Promise.all([
    admin.client.query(api.payments.intents, { runId }), admin.client.query(api.ap.bills, { runId }),
    admin.client.query(api.ledger.entries, { runId, limit: 100 }), admin.client.query(api.ledger.verifyChain, { runId }),
    admin.client.query(api.ledger.trialBalance, { runId }), admin.client.query(api.observe.agentRuns, { runId }),
    admin.client.query(api.tasks.queueStats, { runId }), admin.client.query(api.observe.violations, { runId }),
  ]);
  return { intents, bills, entries, chain, trialBalance, agentRuns, queueStats, violations, bank: new Team(runId).bank.all() };
}

export async function runPaymentRecoveryCase(kind: RecoveryCase) {
  process.env.AGENT_LLM = "off";
  const url = new URL(process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "these integration fixtures require a local Convex backend");
  const admin = new AdminClient();
  const runId = `payment-recovery-${kind}-${randomUUID()}`;
  const scenario = await createScenario(runId, { seed: 87, storeCount: 1, start: ORIGINAL_DATE, days: 1, plantErrors: false }, `Payment recovery regression: ${kind}`);
  const team = new Team(runId);
  await team.refreshSeats();
  const ap = team.runtimes.get("ap-clerk-1")!;
  const controller = team.runtimes.get("controller")!;
  const payments = team.runtimes.get("payments")!;
  const vendor = (await team.mem.read<Vendor>("vendors/golden-state-produce.yaml"))!;
  const store = (await team.mem.read<Store>((await team.mem.list("stores/"))[0]!))!;
  const ingested = await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "document.received", externalId: "recovery-invoice", occurredOn: ORIGINAL_DATE,
    payload: { kind: "invoice", from: vendor.contacts[0]!.email, text: renderInvoice({
      vendorName: vendor.legalName, vendorEmail: vendor.contacts[0]!.email, invoiceNumber: "RECOVERY-001",
      invoiceDate: ORIGINAL_DATE, dueDate: "2026-02-09", storeId: store.id, storeName: store.name,
      lines: [{ sku: "FIXTURE", description: "Recovery fixture", quantity: 1, unitCents: AMOUNT, amountCents: AMOUNT }],
      totalCents: AMOUNT, remitBank: vendor.remitTo.bank, remitLast4: vendor.remitTo.accountLast4, termsNetDays: 30,
    }, "keyvalue") },
  });
  assert(ingested.ok);
  assert(await team.step(ap));
  await controller.handoff("payments.run", "payments", { occurredOn: ORIGINAL_DATE }, "request-payment");
  assert(await team.step(payments));
  assert(await team.step(controller));
  const before = await readback(admin, runId);
  assert.equal(before.intents.length, 1);
  const original = before.intents[0]!;
  assert.equal(original.status, "approved");
  await controller.handoff("payments.run", "payments", { occurredOn: ORIGINAL_DATE }, "execute-payment");

  const firstMode = kind === "permanent-bank-failure" || kind === "changed-remit-before-send" ? "before-send" : kind === "closed-period" ? "settle-failure" : kind;
  const first = await worker(runId, firstMode, "first-worker");
  const boundary = await readback(admin, runId);
  assert.equal(first.sendCalls, 1);
  assert.equal(boundary.intents[0]!._id, original._id);
  assert.equal(boundary.intents[0]!.status, kind === "success-replay" ? "settled" : "submitted");
  assert.equal(boundary.bank.length, firstMode === "before-send" ? 0 : 1);
  assert.equal(boundary.intents[0]!.submittedOn, ORIGINAL_DATE);
  assert.equal(boundary.entries.filter((entry) => entry.source.kind === "payment_settlement").length, kind === "success-replay" ? 1 : 0);
  if (kind !== "success-replay") assert(first.injected, "fault boundary was not reached");

  const settlementGuards: Record<string, unknown> = {};
  if (kind === "settle-failure") {
    const forbidden = await ap.kernel.client.mutation(api.payments.settlePayment, {
      ...ap.kernel.auth, intentId: original._id, bankRef: boundary.bank[0]!.bankRef, settledOn: ORIGINAL_DATE,
    });
    assert(!forbidden.ok && forbidden.code === "forbidden", "AP role must not settle a submitted payment");
    const afterForbidden = await readback(admin, runId);
    assert.deepEqual(afterForbidden.intents, boundary.intents);
    assert.deepEqual(afterForbidden.entries, boundary.entries);
    settlementGuards.forbiddenWhileSubmitted = forbidden;
  }

  if (kind === "changed-remit" || kind === "changed-remit-before-send") {
    // A real controlled memory proposal/merge, after submission and before recovery.
    const proposalId = `recovery-remit-${randomUUID()}`;
    await payments.propose(proposalId, [{ path: `vendors/${vendor.id}.yaml`, data: {
      ...vendor, remitTo: { ...vendor.remitTo, bank: "New Verified Bank", accountLast4: "9999", verifiedOn: RESTART_DATE, verifiedBy: "payments", method: "callback_known_number" },
    } }], "Fixture: legitimate vendor remit change after original payment submission");
    await team.mem.merge({ id: proposalId, approver: controller.author, caps: ROLE_CAPABILITIES.controller, note: "Fixture: independently approved callback verification" });
    assert.equal((await team.mem.read<Vendor>(`vendors/${vendor.id}.yaml`))!.remitTo.accountLast4, "9999");
  }
  const advanced = await admin.client.mutation(api.admin.setSimDate, { secret: admin.secret, runId, simDate: RESTART_DATE });
  assert(advanced.ok);
  if (kind === "permanent-bank-failure" || kind === "closed-period") {
    if (kind === "closed-period") {
      const human = new SeatClient(runId, "human-cfo", scenario.tokens["human-cfo"]!);
      assert((await controller.kernel.client.mutation(api.ledger.signClose, { ...controller.kernel.auth, period: "2026-01" })).ok);
      const closed = await human.client.mutation(api.ledger.signClose, { ...human.auth, period: "2026-01" });
      assert(closed.ok && closed.status === "closed");
    }
    const restarted = await worker(runId, kind === "permanent-bank-failure" ? "permanent-bank-recover" : "recover", "blocked-worker");
    const final = await readback(admin, runId);
    const taskIds = [...new Set(final.agentRuns.filter((run) => run.seatId === "payments").flatMap((run) => run.taskId ? [run.taskId] : []))];
    const tasks = await Promise.all(taskIds.map((taskId) => admin.client.query(api.tasks.get, { runId, taskId })));
    const failed = tasks.filter((task) => task?.status === "failed");
    assert(failed.length > 0, "persistent failure must remain visibly failed, not healthy");
    assert(failed.every((task) => task!.attempts === 4), "persistent failure must exhaust exactly the configured 4 attempts");
    assert.equal(final.queueStats.payments?.queued ?? 0, 0);
    assert.equal(await admin.client.query(api.tasks.nextPaymentRetry, { runId }), null);
    assert.equal(final.intents.length, 1);
    assert.equal(final.intents[0]!._id, original._id);
    assert.equal(final.intents[0]!.status, "submitted");
    assert.equal(final.intents[0]!.submittedOn, ORIGINAL_DATE);
    assert.equal(final.intents[0]!.amountCents, AMOUNT);
    assert.deepEqual(final.intents[0]!.remitTo, original.remitTo);
    assert.equal(final.bills[0]!.status, "approved");
    assert.equal(final.entries.length, 1);
    assert.equal(final.entries.filter((entry) => entry.source.kind === "payment_settlement").length, 0);
    assert(final.chain.ok);
    assert.equal(final.trialBalance.reduce((sum, balance) => sum + balance.net, 0), 0);
    if (kind === "closed-period") {
      assert.equal(restarted.sendCalls, 0);
      assert.deepEqual(final.bank, boundary.bank);
      assert.equal(final.bank[0]!.sentOn, ORIGINAL_DATE);
      assert(final.violations.some((violation) => violation.reason.startsWith("period_closed:")));
      assert(failed.every((task) => task!.error?.includes("period_closed")));
    } else {
      assert.equal(final.bank.length, 0);
      assert(restarted.sendCalls > 0 && restarted.sendCalls <= 8, "bank retry count must be bounded");
      assert(failed.every((task) => task!.error?.includes("before bank acceptance")));
    }
    const summary = { bankTransfers: final.bank.length, settlementEntries: 0, ledgerEntries: 1, firstSendCalls: first.sendCalls, restartSendCalls: restarted.sendCalls, intentStatus: final.intents[0]!.status, failedTasks: failed.length, failedTaskAttempts: failed.map((task) => task!.attempts), originalDate: ORIGINAL_DATE, restartDate: RESTART_DATE, chainVerified: final.chain.ok };
    const report = { kind, runId, backend: url.origin, checkedAt: new Date().toISOString(), summary, first, boundary, restarted, final, tasks };
    fs.writeFileSync(path.join(runDir(runId), "recovery-report.json"), JSON.stringify(report, null, 2));
    console.log(`PASS ${kind}: ${JSON.stringify(summary)} (run ${runId})`);
    return report;
  }
  const restarted = await worker(runId, "recover", "restarted-worker");
  const recovered = await readback(admin, runId);
  assert.equal(restarted.sendCalls, firstMode === "before-send" ? 1 : 0, "restart must query the bank receipt before any send");
  assert.equal(recovered.intents.length, 1);
  const intent = recovered.intents[0]!;
  assert.equal(intent._id, original._id);
  assert.equal(intent.status, "settled");
  assert.equal(intent.submittedOn, ORIGINAL_DATE);
  assert.deepEqual(intent.remitTo, original.remitTo);
  assert.equal(intent.amountCents, original.amountCents);
  assert.equal(recovered.bills[0]!.status, "paid");
  assert.equal(recovered.bank.length, 1);
  const receipt = recovered.bank[0]!;
  assert.deepEqual({ intentId: receipt.intentId, payee: receipt.payee, amountCents: receipt.amountCents, bank: receipt.bank, accountLast4: receipt.accountLast4, sentOn: receipt.sentOn }, {
    intentId: original._id, payee: original.payee, amountCents: AMOUNT, bank: original.remitTo.bank, accountLast4: original.remitTo.accountLast4, sentOn: ORIGINAL_DATE,
  });
  assert.equal(intent.bankRef, receipt.bankRef);
  const settlements = recovered.entries.filter((entry) => entry.source.kind === "payment_settlement");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]!.source.ref, original._id);
  assert.equal(settlements[0]!.date, ORIGINAL_DATE, "restart date must not replace the bank acceptance date");
  assert.equal(settlements[0]!.lines.find((line) => line.account === "2000")!.debit, AMOUNT);
  assert.equal(settlements[0]!.lines.find((line) => line.account === "1000")!.credit, AMOUNT);
  assert.equal(recovered.entries.length, 2);
  assert(recovered.chain.ok);
  assert.equal(recovered.trialBalance.reduce((sum, balance) => sum + balance.net, 0), 0);

  if (kind === "success-replay") {
    const forbidden = await ap.kernel.client.mutation(api.payments.settlePayment, {
      ...ap.kernel.auth, intentId: original._id, bankRef: receipt.bankRef, settledOn: ORIGINAL_DATE,
    });
    assert(!forbidden.ok && forbidden.code === "forbidden", "settlement replay must not bypass role checks");
    const identical = await payments.kernel.client.mutation(api.payments.settlePayment, {
      ...payments.kernel.auth, intentId: original._id, bankRef: receipt.bankRef, settledOn: ORIGINAL_DATE,
    });
    assert(identical.ok && "replayed" in identical && identical.replayed);
    const conflictingBankRef = await payments.kernel.client.mutation(api.payments.settlePayment, {
      ...payments.kernel.auth, intentId: original._id, bankRef: `${receipt.bankRef}-different`, settledOn: ORIGINAL_DATE,
    });
    assert(!conflictingBankRef.ok && conflictingBankRef.code === "settlement_conflict");
    const conflictingDate = await payments.kernel.client.mutation(api.payments.settlePayment, {
      ...payments.kernel.auth, intentId: original._id, bankRef: receipt.bankRef, settledOn: RESTART_DATE,
    });
    assert(!conflictingDate.ok && conflictingDate.code === "settlement_conflict");
    const afterGuardChecks = await readback(admin, runId);
    assert.deepEqual(afterGuardChecks.intents, recovered.intents);
    assert.deepEqual(afterGuardChecks.entries, recovered.entries);
    assert.deepEqual(afterGuardChecks.bank, recovered.bank);
    Object.assign(settlementGuards, { forbiddenWhileSettled: forbidden, identical, conflictingBankRef, conflictingDate });
  }

  // Another full process restart must not send or post again.
  const replay = await worker(runId, "recover", "replay-worker");
  assert.equal(replay.sendCalls, 0);
  const afterReplay = await readback(admin, runId);
  assert.deepEqual(afterReplay.bank, recovered.bank);
  assert.equal(afterReplay.entries.length, 2);
  assert.deepEqual(afterReplay.intents, recovered.intents);
  // Prove the original date still produces the expected next-day bank feed.
  const feed = await emitDay(scenario, RESTART_DATE, admin);
  assert.equal(feed.ingested, 1);
  await worker(runId, "recover", "bank-feed-worker");
  const final = await readback(admin, runId);
  assert(final.agentRuns.some((run) => run.outcome === "reconciled"));
  assert.equal(final.entries.length, 2);
  assert(final.chain.ok);
  const report = {
    kind, runId, backend: url.origin, checkedAt: new Date().toISOString(),
    summary: { bankTransfers: final.bank.length, settlementEntries: settlements.length, ledgerEntries: final.entries.length, firstSendCalls: first.sendCalls, restartSendCalls: restarted.sendCalls, replaySendCalls: replay.sendCalls, intentStatus: final.intents[0]!.status, originalDate: ORIGINAL_DATE, restartDate: RESTART_DATE, bankDate: receipt.sentOn, settlementDate: settlements[0]!.date, chainVerified: final.chain.ok, nextDayFeedReconciled: true, settlementGuardChecks: Object.keys(settlementGuards).length },
    first, boundary, restarted, recovered, replay, feed, final, settlementGuards,
  };
  fs.writeFileSync(path.join(runDir(runId), "recovery-report.json"), JSON.stringify(report, null, 2));
  console.log(`PASS ${kind}: ${JSON.stringify(report.summary)} (run ${runId})`);
  return report;
}

export async function runPaymentRecoverySuite() {
  const reports = [];
  for (const kind of RECOVERY_CASES) reports.push(await runPaymentRecoveryCase(kind));
  const reportPath = process.env.PAYMENT_RECOVERY_REPORT ?? path.join("var", "payment-recovery-results.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), reports }, null, 2));
  console.log(`All ${reports.length} payment recovery scenarios passed. Evidence: ${reportPath}`);
  return reports;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await runPaymentRecoverySuite();
}
