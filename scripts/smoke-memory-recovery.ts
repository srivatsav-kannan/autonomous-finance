// Synthetic local Convex/Git execution with transport failures around real writes.
// Run: npx tsx scripts/smoke-memory-recovery.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { AdminClient, api } from "../src/core/kernel-client";
import { Team } from "../src/agents/team";
import { processDocument } from "../src/agents/handlers/ap";
import { createScenario } from "../src/world/scenario";

const admin = new AdminClient();
for (const boundary of ["bill-response", "review-handoff", "decision-mirror"] as const) {
  const runId = `memory-recovery-${boundary}-${Date.now()}`;
  const sc = await createScenario(runId, { seed: 7, storeCount: 1, start: "2026-01-01", days: 2, plantErrors: false });
  const invoice = sc.events.find((e) => e.type === "document.received" && String(e.payload.subject).startsWith("Invoice INV-"))!;
  const receiving = sc.events.find((e) => e.type === "receiving.logged" && e.payload.vendor === "golden-state-produce")!;
  for (const event of boundary === "review-handoff" ? [invoice] : [receiving, invoice]) {
    assert.equal((await admin.client.mutation(api.admin.ingestEvent, { secret: admin.secret, runId, ...event })).ok, true);
  }
  const team = new Team(runId);
  await team.refreshSeats();
  const rt = team.runtimes.get("ap-clerk-1")!;
  const claim = await rt.kernel.client.mutation(api.tasks.claimTask, rt.kernel.auth);
  assert.ok(claim.ok && claim.task);
  const task = claim.task;
  const originalMutation = rt.kernel.client.mutation.bind(rt.kernel.client);
  const target = boundary === "bill-response" ? "ap:recordBill" : boundary === "review-handoff" ? "tasks:createTask" : "observe:recordCommit";
  let injected = false;
  rt.kernel.client.mutation = (async (ref: any, args: any) => {
    if (!injected && getFunctionName(ref) === target) {
      injected = true;
      if (boundary !== "review-handoff") assert.equal((await originalMutation(ref, args)).ok, true);
      throw new Error(`injected ${boundary}`);
    }
    return await originalMutation(ref, args);
  }) as typeof rt.kernel.client.mutation;
  await assert.rejects(processDocument(rt, task), new RegExp(`injected ${boundary}`));
  assert.ok(injected);
  rt.kernel.client.mutation = originalMutation;
  if (boundary === "decision-mirror") {
    // The original plan approved the bill. A new credit must not silently change
    // that plan while the retry continues to cite the old immutable decision.
    await rt.updateVendor("golden-state-produce", (v) => ({ ...v, credits: [...v.credits, { id: "LATER", amountCents: 100, issuedOn: "2026-01-03", reason: "arrived after decision" }] }), "Later synthetic credit", {}, "later-credit");
  }
  const outcome = await processDocument(rt, task);
  const bills = await admin.client.query(api.ap.bills, { runId });
  assert.equal(bills.length, 1);
  const entries = await admin.client.query(api.ledger.entries, { runId });
  if (boundary === "review-handoff") {
    assert.equal(outcome.outcome, "held");
    assert.equal(bills[0]!.status, "held");
    assert.equal(entries.length, 0);
    const reviewer = team.runtimes.get("controller")!;
    const review = await reviewer.kernel.client.mutation(api.tasks.claimTask, reviewer.kernel.auth);
    assert.ok(review.ok && review.task);
    assert.equal(review.task.payload.billId, bills[0]!._id);
    assert.equal(review.task.payload.recommendedCents, bills[0]!.totalCents);
  } else {
    assert.equal(outcome.outcome, "approved");
    assert.equal(bills[0]!.status, "approved");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source.ref, bills[0]!._id);
  }
  assert.equal((await admin.client.query(api.observe.violations, { runId })).length, 0);
  console.log(`PASS ${boundary}: retry preserves the original bill/decision and performs one effect (${runId})`);
}
