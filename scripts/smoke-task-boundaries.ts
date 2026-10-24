// Live regression checks for #6–#8. Requires the local backend and admin secret.
// Run: npx tsx scripts/smoke-task-boundaries.ts [--expiry]
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";
import type { Id } from "../convex/_generated/dataModel";

const admin = new AdminClient();
const runId = `smoke-task-boundaries-${Date.now()}`;
const otherRunId = `${runId}-other`;
const seats = [
  { seatId: "pay", role: "payments" },
  { seatId: "auditor", role: "auditor" },
  { seatId: "controller", role: "controller" },
];
const tokens = Object.fromEntries(seats.map((s) => [s.seatId, newToken()]));
for (const id of [runId, otherRunId]) {
  const created = await admin.client.mutation(api.admin.createRun, {
    secret: admin.secret, runId: id, label: "Task boundary smoke", company: "test", simDate: "2026-01-02", periods: ["2026-01"],
    seats: seats.map((s) => ({ ...s, name: s.seatId, kind: "agent" as const, tokenHash: hashToken(tokens[s.seatId]!) })),
  });
  assert.equal(created.ok, true);
}
const pay = new SeatClient(runId, "pay", tokens.pay!);
const auditor = new SeatClient(runId, "auditor", tokens.auditor!);
const controller = new SeatClient(runId, "controller", tokens.controller!);
const otherPay = new SeatClient(otherRunId, "pay", tokens.pay!);
let checks = 0;
function check(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks++;
  console.log(`PASS  ${label}`);
}
async function createAndClaim(client: SeatClient, key: string) {
  const created = await admin.client.mutation(api.tasks.adminCreateTask, {
    secret: admin.secret, runId: client.runId, type: "payments.run", role: "payments", payload: {}, idempotencyKey: key,
  });
  assert.ok(created.ok);
  const claimed = await client.client.mutation(api.tasks.claimTask, client.auth);
  assert.ok(claimed.ok && claimed.task);
  return { ...client.auth, taskId: claimed.task._id, leaseGeneration: claimed.task.leaseGeneration, expiresAt: claimed.task.leaseExpiresAt! };
}
async function get(client: SeatClient, taskId: Id<"tasks">) {
  return await client.client.query(api.tasks.get, { runId: client.runId, taskId });
}

const { expiresAt: _firstExpiry, ...first } = await createAndClaim(pay, "complete");
const before = await get(pay, first.taskId);
const wrongWait = await auditor.client.mutation(api.tasks.waitTask, { ...first, ...auditor.auth, reason: "unauthorized" });
check("auditor cannot suspend payments work", !wrongWait.ok && wrongWait.code === "not_lease_owner");
assert.deepEqual(await get(pay, first.taskId), before);
check("owner heartbeat succeeds", (await pay.client.mutation(api.tasks.heartbeatTask, first)).ok);
check("owner completes task", (await pay.client.mutation(api.tasks.completeTask, { ...first, result: "success" })).ok);
const done = await get(pay, first.taskId);
const late = await pay.client.mutation(api.tasks.failTask, { ...first, error: "delayed", retryInMs: 0 });
check("late failure cannot reopen completed work", !late.ok && late.code === "not_leased");
assert.deepEqual(await get(pay, first.taskId), done);
check("completion clears lease ownership", done?.status === "done" && !done.leaseOwner && !done.leaseExpiresAt);

const { expiresAt: _retryExpiry, ...retry } = await createAndClaim(pay, "retry");
check("owner can retry work", (await pay.client.mutation(api.tasks.failTask, { ...retry, error: "retry", retryInMs: 0 })).ok);
const reclaim = await pay.client.mutation(api.tasks.claimTask, pay.auth);
assert.ok(reclaim.ok && reclaim.task);
check("same seat obtains a new generation", reclaim.task._id === retry.taskId && reclaim.task.leaseGeneration === retry.leaseGeneration + 1);
const reclaimed = await get(pay, retry.taskId);
for (const result of [
  await pay.client.mutation(api.tasks.waitTask, { ...retry, reason: "stale" }),
  await pay.client.mutation(api.tasks.failTask, { ...retry, error: "stale", retryInMs: 0 }),
  await pay.client.mutation(api.tasks.completeTask, retry),
  await pay.client.mutation(api.tasks.heartbeatTask, retry),
]) check("old generation cannot change a new lease", !result.ok && result.code === "stale_lease");
assert.deepEqual(await get(pay, retry.taskId), reclaimed);
const current = { ...retry, leaseGeneration: reclaim.task.leaseGeneration };
check("current owner can wait", (await pay.client.mutation(api.tasks.waitTask, { ...current, reason: "approval" })).ok);
const question = { to: "controller", severity: "decision" as const, title: "Resume work", body: "Synthetic smoke", evidence: [], options: [{ id: "ack", label: "Resume" }] };
const ask = await pay.client.mutation(api.asks.createAsk, { ...pay.auth, ...question, taskId: current.taskId });
assert.ok(ask.ok);
check("same-run ask can be answered", (await controller.client.mutation(api.asks.answerAsk, { ...controller.auth, askId: ask.askId, optionId: "ack" })).ok);
check("answer wakes its waiting task", (await get(pay, current.taskId))?.status === "queued");
const resumed = await pay.client.mutation(api.tasks.claimTask, pay.auth);
assert.ok(resumed.ok && resumed.task);
await pay.client.mutation(api.tasks.completeTask, { ...current, leaseGeneration: resumed.task.leaseGeneration });

const { expiresAt: _foreignExpiry, ...foreign } = await createAndClaim(otherPay, "foreign");
assert.ok((await otherPay.client.mutation(api.tasks.waitTask, { ...foreign, reason: "approval" })).ok);
const foreignBefore = await get(otherPay, foreign.taskId);
const crossRun = await pay.client.mutation(api.asks.createAsk, { ...pay.auth, ...question, taskId: foreign.taskId });
check("foreign-run task references are rejected", !crossRun.ok && crossRun.code === "invalid_task");
assert.deepEqual(await get(otherPay, foreign.taskId), foreignBefore);
check("rejected reference creates no ask", (await pay.client.query(api.asks.list, { runId, status: "open" })).length === 0);

if (process.argv.includes("--expiry")) {
  const { expiresAt, ...expired } = await createAndClaim(pay, "expired");
  console.log("Waiting for the 120-second lease to expire...");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 100)));
  const snapshot = await get(pay, expired.taskId);
  for (const result of [
    await pay.client.mutation(api.tasks.waitTask, { ...expired, reason: "too late" }),
    await pay.client.mutation(api.tasks.failTask, { ...expired, error: "too late", retryInMs: 0 }),
    await pay.client.mutation(api.tasks.completeTask, expired),
    await pay.client.mutation(api.tasks.heartbeatTask, expired),
  ]) check("expired lease cannot transition or renew", !result.ok && result.code === "lease_expired");
  assert.deepEqual(await get(pay, expired.taskId), snapshot);
  const next = await pay.client.mutation(api.tasks.claimTask, pay.auth);
  assert.ok(next.ok && next.task);
  check("same seat reclaims its expired work", next.reclaimed && next.task.leaseGeneration === expired.leaseGeneration + 1);
  const old = await pay.client.mutation(api.tasks.completeTask, expired);
  check("old expired generation stays fenced after reclaim", !old.ok && old.code === "stale_lease");
  check("reclaimed lease completes", (await pay.client.mutation(api.tasks.completeTask, { ...expired, leaseGeneration: next.task.leaseGeneration })).ok);
}
console.log(`ALL PASS (${checks} checks; run ${runId})`);
