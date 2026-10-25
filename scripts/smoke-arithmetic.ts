// Run against a configured local backend: npx tsx scripts/smoke-arithmetic.ts
import "../src/core/env";
import assert from "node:assert/strict";
import { AdminClient, SeatClient, api, hashToken, newToken } from "../src/core/kernel-client";

const admin = new AdminClient();
const runId = `smoke-arithmetic-${Date.now()}`;
const token = newToken();
assert.equal((await admin.client.mutation(api.admin.createRun, {
  secret: admin.secret, runId, label: "Arithmetic regressions", company: "synthetic", simDate: "2026-01-02", periods: ["2026-01"],
  seats: [{ seatId: "ap", role: "ap_clerk", name: "AP", kind: "agent", tokenHash: hashToken(token) }],
})).ok, true);
const ap = new SeatClient(runId, "ap", token);
const max = Number.MAX_SAFE_INTEGER;
const posting = { ...ap.auth, idempotencyKey: "overflow", date: "2026-01-02", memo: "Synthetic extreme arithmetic", source: { kind: "adjustment" } };
const failed = await ap.client.mutation(api.ledger.postEntry, { ...posting, lines: [
  { account: "5000", debit: max, credit: 0 }, { account: "5000", debit: 2, credit: 0 },
  { account: "2000", debit: 0, credit: max }, { account: "2000", debit: 0, credit: 1 },
] });
assert.equal(failed.ok, false);
assert.deepEqual(await admin.client.query(api.ledger.entries, { runId }), []);
assert.deepEqual(await admin.client.query(api.ledger.trialBalance, { runId }), []);
console.log("PASS rounded unequal aggregate totals are rejected without ledger writes");

assert.equal((await ap.client.mutation(api.ledger.postEntry, { ...posting, idempotencyKey: "max-safe", lines: [
  { account: "5000", debit: max - 2, credit: 0 }, { account: "5000", debit: 2, credit: 0 },
  { account: "2000", debit: 0, credit: max },
] })).ok, true);
const before = {
  entries: await admin.client.query(api.ledger.entries, { runId }),
  balances: await admin.client.query(api.ledger.trialBalance, { runId }),
};
assert.equal((await ap.client.mutation(api.ledger.postEntry, { ...posting, idempotencyKey: "balance-overflow", lines: [
  { account: "5000", debit: 1, credit: 0 }, { account: "2000", debit: 0, credit: 1 },
] })).ok, false);
assert.deepEqual(await admin.client.query(api.ledger.entries, { runId }), before.entries);
assert.deepEqual(await admin.client.query(api.ledger.trialBalance, { runId }), before.balances);
assert.equal((await admin.client.query(api.ledger.verifyChain, { runId })).ok, true);
assert.equal((await admin.client.query(api.observe.violations, { runId })).length, 2);
console.log(`PASS exact safe boundary posts; later balance overflow preserves ledger and hash chain; run ${runId}`);
