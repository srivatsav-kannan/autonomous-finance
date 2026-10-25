// Run against a configured local backend: npx tsx scripts/smoke-ap-integrity.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";

const admin = new AdminClient();
const runId = `smoke-ap-integrity-${Date.now()}`;
const roles = ["ap_clerk", "controller", "lease_accountant", "auditor", "payments"] as const;
const seats = roles.map((role) => ({ role, token: newToken() }));
assert.equal((await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret, runId, label: "AP integrity regressions", company: "synthetic", simDate: "2026-01-02", periods: ["2026-01"],
  seats: seats.map(({ role, token }) => ({ seatId: role, role, name: role, kind: "agent" as const, tokenHash: hashToken(token) })),
})).ok, true);
const client = (role: typeof roles[number]) => new SeatClient(runId, role, seats.find((seat) => seat.role === role)!.token);
// Bills must cite a document the company received.
const received = await admin.client.mutation(api.admin.ingestEvent, {
  secret: admin.secret, runId, type: "document.received", externalId: "synthetic-doc", occurredOn: "2026-01-02",
  payload: { kind: "invoice", channel: "email", from: "ar@synthetic.example", subject: "INV-1", text: "INV-1" },
});
assert.equal(received.ok, true);
const docId = String((received as { eventId: string }).eventId);
const ap = client("ap_clerk");
const invoice = {
  ...ap.auth, idempotencyKey: "bill-1", vendor: "synthetic-produce", invoiceNumber: "INV-1", invoiceDate: "2026-01-02", dueDate: "2026-01-16",
  lines: [{ description: "Synthetic produce", quantity: 1, unitCents: 10000, amountCents: 10000 }], totalCents: 10000,
  documentEventId: docId, decision: "approve" as const, exceptions: [], expenseAccount: "9999",
};
const failed = await ap.client.mutation(api.ap.recordBill, invoice);
assert.equal(failed.ok, false);
assert.deepEqual(await admin.client.query(api.ap.bills, { runId }), []);
assert.deepEqual(await admin.client.query(api.ledger.entries, { runId }), []);
assert.deepEqual(await admin.client.query(api.ledger.trialBalance, { runId }), []);
assert.equal((await admin.client.query(api.observe.violations, { runId })).length, 1);
console.log("PASS failed accrual leaves no bill or ledger effect, and retains the violation");

const corrected = await ap.client.mutation(api.ap.recordBill, { ...invoice, expenseAccount: "5000" });
assert.equal(corrected.ok, true);
const bills = await admin.client.query(api.ap.bills, { runId });
assert.equal(bills.length, 1);
assert.equal(bills[0]!.entryId, corrected.entryId);
const entries = await admin.client.query(api.ledger.entries, { runId });
assert.equal(entries.length, 1);
assert.equal(entries[0]!.source.ref, corrected.billId);
assert.deepEqual(await ap.client.mutation(api.ap.recordBill, { ...invoice, expenseAccount: "5000" }), { ...corrected, replayed: true });
console.log("PASS corrected retry records exactly one bill and linked accrual");

for (const role of ["auditor", "payments"] as const) {
  const seat = client(role);
  for (const decision of ["hold", "reject", "approve"] as const) {
    const result = await seat.client.mutation(api.ap.recordBill, { ...invoice, ...seat.auth, idempotencyKey: `${role}-${decision}`, invoiceNumber: `${role}-${decision}`, decision, expenseAccount: "5000" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
  }
}
assert.equal((await admin.client.query(api.ap.bills, { runId })).length, 1);
console.log("PASS auditor and payments cannot create approved, held, or rejected bills");

const lease = client("lease_accountant");
const rentDoc = await admin.client.mutation(api.admin.ingestEvent, {
  secret: admin.secret, runId, type: "document.received", externalId: "synthetic-rent", occurredOn: "2026-01-02",
  payload: { kind: "lease_invoice", channel: "email", from: "leases@landlord.example", subject: "RENT-1", text: "RENT-1" },
});
assert.equal(rentDoc.ok, true);
assert.equal((await lease.client.mutation(api.ap.recordBill, { ...invoice, ...lease.auth, idempotencyKey: "rent", invoiceNumber: "RENT-1", decision: "hold", expenseAccount: "5200", documentEventId: String((rentDoc as { eventId: string }).eventId) })).ok, true);
console.log(`PASS lease accountant can still record held rent bills; run ${runId}`);
