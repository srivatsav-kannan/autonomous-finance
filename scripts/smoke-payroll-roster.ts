// Uses synthetic HR/register events against a configured local backend; no LLM needed.
// Run: npx tsx scripts/smoke-payroll-roster.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, api } from "../src/core/kernel-client";
import { createScenario } from "../src/world/scenario";
import { Team } from "../src/agents/team";

const admin = new AdminClient();
const runId = `smoke-payroll-roster-${Date.now()}`;
await createScenario(runId, { seed: 7, storeCount: 1, start: "2026-01-01", days: 1, plantErrors: false });
async function ingest(type: string, externalId: string, payload: unknown) {
  const result = await admin.client.mutation(api.admin.ingestEvent, { secret: admin.secret, runId, type, externalId, occurredOn: "2026-01-14", payload });
  assert.equal(result.ok, true);
}
await ingest("hr.roster", "synthetic-roster", { asOf: "2026-01-01", employees: [
  { id: "eligible", name: "Eligible Employee", store: "sf-hayes-valley", status: "active" },
  { id: "other-store", name: "Other Store", store: "other-store", status: "active" },
  { id: "inactive", name: "Inactive Employee", store: "sf-hayes-valley", status: "inactive" },
  { id: "terminated", name: "Terminated Today", store: "sf-hayes-valley", status: "active" },
] });
await ingest("hr.roster_change", "synthetic-termination", { employeeId: "terminated", change: "terminated", effective: "2026-01-14" });
const register = { store: "sf-hayes-valley", payDate: "2026-01-14", period: "2026-01-01..2026-01-14" };
await ingest("payroll.register", "unknown-only", { ...register, registerId: "unknown-only", employees: [{ id: "unknown", name: "Unknown Person", grossCents: 123456 }], grossCents: 123456 });
const team = new Team(runId);
await team.runUntilIdle();
assert.deepEqual(await admin.client.query(api.ledger.entries, { runId }), []);
const heldAsks = await admin.client.query(api.asks.list, { runId });
assert.equal(heldAsks.length, 1);
assert.match(heldAsks[0]!.body, /not on the HR roster/);
assert.equal((await admin.client.query(api.observe.violations, { runId })).length, 0);
console.log("PASS unknown employee is held and escalated without a zero accrual");

await ingest("payroll.register", "mixed-register", { ...register, registerId: "mixed-register", employees: [
  { id: "eligible", name: "Eligible Employee", grossCents: 10000 },
  { id: "other-store", name: "Other Store", grossCents: 20000 },
  { id: "inactive", name: "Inactive Employee", grossCents: 30000 },
  { id: "terminated", name: "Terminated Today", grossCents: 40000 },
], grossCents: 100000 });
await team.runUntilIdle();
const entries = await admin.client.query(api.ledger.entries, { runId });
assert.equal(entries.length, 1);
assert.equal(entries[0]!.totalCents, 10000);
assert.equal(entries[0]!.source.ref, "mixed-register");
const asks = await admin.client.query(api.asks.list, { runId });
assert.equal(asks.length, 2);
const mixedAsk = asks.find((ask) => ask.body.includes("Other Store"));
assert.ok(mixedAsk);
assert.match(mixedAsk.body, /store.*does not match/);
assert.match(mixedAsk.body, /HR status is inactive/);
assert.match(mixedAsk.body, /terminated 2026-01-14/);
assert.equal((await admin.client.query(api.observe.violations, { runId })).length, 0);
console.log(`PASS only eligible payroll accrues; store/status/pay-date termination exceptions escalate; run ${runId}`);
