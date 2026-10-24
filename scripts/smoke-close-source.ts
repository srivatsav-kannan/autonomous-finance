// Live local Convex proof for source completeness and snapshot-bound close.
// Requires the same CONVEX_URL and KERNEL_ADMIN_SECRET as the kernel smoke suite.
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";

const admin = new AdminClient();
const runId = `close-source-smoke-${Date.now()}`;
const tokens = { ap: newToken(), controller: newToken(), human: newToken() };
const created = await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret, runId, label: "Source-complete close smoke", company: "synthetic",
  simDate: "2026-01-31", periods: ["2026-01", "2026-02"],
  seats: [
    { seatId: "ap", role: "ap_clerk", name: "AP", kind: "agent", tokenHash: hashToken(tokens.ap) },
    { seatId: "controller", role: "controller", name: "Controller", kind: "agent", tokenHash: hashToken(tokens.controller) },
    { seatId: "human", role: "human_cfo", name: "Human", kind: "human", tokenHash: hashToken(tokens.human) },
  ],
});
assert.equal(created.ok, true);
const ap = new SeatClient(runId, "ap", tokens.ap);
const controller = new SeatClient(runId, "controller", tokens.controller);
const human = new SeatClient(runId, "human", tokens.human);
let checks = 0;
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
async function source(externalId: string, occurredOn = "2026-01-15") {
  const result = await admin.client.mutation(api.admin.ingestEvent, {
    secret: admin.secret, runId, type: "document.received", externalId, occurredOn,
    payload: { kind: "invoice", from: "accounts@supplier.example", text: "Synthetic source invoice" },
  });
  assert.ok(result.ok);
  return result.eventId;
}
async function record(documentEventId: string, invoiceNumber: string) {
  return await ap.client.mutation(api.ap.recordBill, {
    ...ap.auth, idempotencyKey: `bill:${documentEventId}`, vendor: "supplier", invoiceNumber,
    invoiceDate: "2026-01-15", dueDate: "2026-02-15", documentEventId,
    lines: [{ description: "Supplies", quantity: 1, unitCents: 10000, amountCents: 10000 }],
    totalCents: 10000, decision: "approve", exceptions: [], expenseAccount: "5000",
  });
}
const readiness = () => admin.client.query(api.ledger.closeReadiness, { runId, period: "2026-01" });
const sign = (seat: SeatClient, expectedSnapshotHash?: string) => seat.client.mutation(api.ledger.signClose, {
  ...seat.auth, period: "2026-01", ...(expectedSnapshotHash ? { expectedSnapshotHash } : {}),
});

const first = await source("invoice-a");
check(!(await readiness()).ready, "unprocessed invoice blocks readiness");
for (const seat of [controller, human]) {
  const result = await sign(seat);
  check(!result.ok && result.code === "close_blocked", `${seat.seatId} cannot bypass the source blocker`);
}
check((await record(first, "INV-1")).ok, "recording and accruing the first invoice succeeds");
const firstSnapshot = await readiness();
check(firstSnapshot.ready, "resolved source restores readiness");
const firstSign = await sign(controller, firstSnapshot.snapshotHash);
check(firstSign.ok && firstSign.status === "open", "one controller signature leaves the period open");

const second = await source("invoice-b");
const blockedHuman = await sign(human);
check(!blockedHuman.ok && blockedHuman.code === "close_blocked", "a late invoice blocks the second signature");
check((await record(second, "INV-2")).ok, "late source can be resolved before close");
const humanFirst = await sign(human);
check(humanFirst.ok && humanFirst.status === "open" && humanFirst.signedBy.length === 1,
  "old controller approval is not reused after source changes");
const stale = await sign(controller, firstSnapshot.snapshotHash);
check(!stale.ok && stale.code === "close_changed", "stale reviewed snapshot is rejected");

const duplicate = await source("invoice-a-resend");
const duplicateResult = await record(duplicate, "INVOICE-0001");
check(!duplicateResult.ok && duplicateResult.code === "duplicate_invoice", "duplicate source is rejected by the kernel");
await source("future-invoice", "2026-02-01");
const finalSnapshot = await readiness();
check(finalSnapshot.ready, "proven duplicate and unrelated future source do not block January");
const finalController = await sign(controller, finalSnapshot.snapshotHash);
check(finalController.ok && finalController.status === "open", "refreshed controller signature is recorded");
const finalHuman = await sign(human, finalSnapshot.snapshotHash);
check(finalHuman.ok && finalHuman.status === "closed", "two current signatures close the resolved period");
console.log(`ALL PASS (${checks} checks; ${runId})`);
