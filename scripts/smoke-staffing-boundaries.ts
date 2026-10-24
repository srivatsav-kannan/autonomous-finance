// Live regression checks for #9. Requires the local backend and admin secret.
// Run: npx tsx scripts/smoke-staffing-boundaries.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";

const admin = new AdminClient();
const runId = `smoke-staffing-${Date.now()}`;
const agentToken = newToken();
const humanToken = newToken();
const created = await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret, runId, label: "Staffing boundary smoke", company: "test", simDate: "2026-01-02", periods: ["2026-01"],
  seats: [
    { seatId: "cfo-agent", role: "cfo_agent", name: "CFO Agent", kind: "agent", tokenHash: hashToken(agentToken) },
    { seatId: "human-cfo", role: "human_cfo", name: "Human CFO", kind: "human", tokenHash: hashToken(humanToken) },
  ],
});
assert.ok(created.ok);
const agent = new SeatClient(runId, "cfo-agent", agentToken);
const human = new SeatClient(runId, "human-cfo", humanToken);
let checks = 0;
function check(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks++;
  console.log(`PASS  ${label}`);
}
for (const role of ["controller", "payments", "auditor", "ap_clerk"]) {
  const newSeatId = `human-${role}`;
  const spawn = await human.client.mutation(api.seats.spawnSeat, {
    ...human.auth, newSeatId, role, name: role, tokenHash: hashToken(newToken()), reason: "human appointment",
  });
  assert.ok(spawn.ok);
  const before = await human.client.query(api.seats.list, { runId });
  const denied = await agent.client.mutation(api.seats.retireSeat, { ...agent.auth, targetSeatId: newSeatId, reason: "agent downsize" });
  check(`CFO agent cannot retire human-appointed ${role}`, !denied.ok && denied.code === "forbidden");
  assert.deepEqual(await human.client.query(api.seats.list, { runId }), before);
  check(`human can retire ${role}`, (await human.client.mutation(api.seats.retireSeat, { ...human.auth, targetSeatId: newSeatId, reason: "human authorized" })).ok);
}
for (const role of ["ap_clerk", "cash_application", "revenue_accountant", "fpa"]) {
  const newSeatId = `agent-${role}`;
  const spawn = await agent.client.mutation(api.seats.spawnSeat, {
    ...agent.auth, newSeatId, role, name: role, tokenHash: hashToken(newToken()), reason: "queue backlog",
  });
  assert.ok(spawn.ok);
  check(`agent can retire its own ${role}`, (await agent.client.mutation(api.seats.retireSeat, { ...agent.auth, targetSeatId: newSeatId, reason: "queue drained" })).ok);
}
console.log(`ALL PASS (${checks} checks; run ${runId})`);
