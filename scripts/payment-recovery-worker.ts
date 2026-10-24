/** Fault controls live in this test process only, never in the payment APIs. */
import "../src/core/env";
import fs from "node:fs";
import { getFunctionName } from "convex/server";
import { Team } from "../src/agents/team";

process.env.AGENT_LLM = "off";
const [runId, mode, markerPath] = process.argv.slice(2);
if (!runId || !mode || !markerPath) throw new Error("usage: payment-recovery-worker <runId> <mode> <markerPath>");
const team = new Team(runId);
await team.refreshSeats();
const payments = team.runtimes.get("payments");
if (!payments) throw new Error("payments seat missing");
let sendCalls = 0;
let injected = false;
const send = team.bank.send.bind(team.bank);
team.bank.send = (payment) => {
  sendCalls++;
  if (mode === "before-send" || mode === "permanent-bank-recover") {
    injected = true;
    throw new Error("test-only failure before bank acceptance");
  }
  const receipt = send(payment);
  if (mode === "lost-response" || mode === "changed-remit") {
    injected = true;
    throw new Error("test-only lost response after bank acceptance");
  }
  if (mode === "kill-after-send") {
    fs.writeFileSync(markerPath, JSON.stringify({ mode, injected: true, sendCalls, bankAccepted: true }));
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL unexpectedly returned");
  }
  return receipt;
};
if (mode === "settle-failure") {
  const mutate = payments.kernel.client.mutation.bind(payments.kernel.client);
  payments.kernel.client.mutation = (async (fn, args) => {
    if (getFunctionName(fn) === "payments:settlePayment") {
      injected = true;
      throw new Error("test-only local failure before settlement mutation");
    }
    return await mutate(fn, args);
  }) as typeof payments.kernel.client.mutation;
}
if (mode === "recover" || mode === "permanent-bank-recover") {
  // This must remain ordinary startup. No test-created recovery task or DB patch.
  await team.runUntilIdle();
} else {
  if (!(await team.step(payments))) throw new Error("expected a payment execution task");
}
fs.writeFileSync(markerPath, JSON.stringify({ mode, injected, sendCalls, processId: process.pid }));
