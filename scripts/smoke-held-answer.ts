// Run against a configured local backend: npx tsx scripts/smoke-held-answer.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api } from "../src/core/kernel-client";
import { Team } from "../src/agents/team";
import { createScenario } from "../src/world/scenario";

const admin = new AdminClient();
for (const optionId of ["pay", "reject"] as const) {
  const runId = `held-answer-${optionId}-${Date.now()}`;
  const scenario = await createScenario(runId, { seed: 7, storeCount: 1, start: "2026-01-01", days: 2, plantErrors: false });
  const invoice = scenario.events.find((e) => e.type === "document.received" && e.payload.kind === "invoice" && String(e.payload.subject).startsWith("Invoice INV-"))!;
  assert.ok(invoice);
  // Deliberately omit its receiving record to enter the human review branch.
  assert.equal((await admin.client.mutation(api.admin.ingestEvent, { secret: admin.secret, runId, ...invoice })).ok, true);
  const team = new Team(runId);
  await team.runUntilIdle();
  const before = await admin.client.query(api.asks.list, { runId, to: "human_cfo" });
  const ask = before.find((a) => a.status === "open" && a.options.some((o) => o.id === "pay"))!;
  assert.ok(ask?.taskId);
  const human = new SeatClient(runId, "human-cfo", scenario.tokens["human-cfo"]!);
  assert.equal((await human.client.mutation(api.asks.answerAsk, { ...human.auth, askId: ask._id, optionId, note: "Synthetic human verification" })).ok, true);
  await team.runUntilIdle();
  const bills = await admin.client.query(api.ap.bills, { runId });
  assert.equal(bills.length, 1);
  assert.equal(bills[0]!.status, optionId === "pay" ? "approved" : "rejected");
  assert.equal(Boolean(bills[0]!.entryId), optionId === "pay");
  assert.equal((await admin.client.query(api.asks.list, { runId, to: "human_cfo" })).length, before.length);
  const task = await admin.client.query(api.tasks.get, { runId, taskId: ask.taskId });
  assert.equal(task?.status, "done");
  console.log(`PASS ${optionId}: answered ask resolves bill, completes task, and does not ask again (${runId})`);
}
