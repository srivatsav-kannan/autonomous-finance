# Independent payment recovery verification

Issue: [#59](https://github.com/srivatsav-kannan/autonomous-finance/issues/59).
Canonical starting revision: `f1a7a73e5865ce86191bd180e1c5a51f76d7ddb2`
(#47 → #49 → #50 plus #58), with ownership at `65f9894`.

## Acceptance inventory before the contract freeze

This is a coverage inventory, not a passing integration report. Existing tests
must continue to run after consolidation. They establish several useful
invariants but do not by themselves prove the new execution-version and resend
gates.

| Scenario | Existing evidence | Independent extension |
| --- | --- | --- |
| Approved invoice, one transfer, one posted debit and cash entry | `demo-reconciliation.test.ts`; persistent `ci:recovery` | Inspect bank and journal independently after restart |
| Death after claim, before send | Lease reclaim covered in `demo-backend.test.ts` | Prove lookup precedes the first send after reclaim, with original command bytes |
| Accept/drop and restart | `demo-dispatcher.test.ts`; child process in `ap-demo.ts` | Require original transfer found by lookup without a second send |
| Local posting rollback | `demo-reconciliation.test.ts` corrupts reservation after bank settlement | Retain retryable evidence, unchanged balances/head/journal, no bank resend |
| Concurrent/stale workers | `demo-backend.test.ts` and `demo-dispatcher.test.ts` | Assert lease generations do not change the external operation identity |
| Accepted but unsettled | Dispatcher assertions retain unposted state | Inspect bill, cash ledger and evidence before settlement |
| Scope mismatch | Identity/account tests and evidence tests | Reject mismatched lookup results across every BankScope field |
| Policy or beneficiary changes | Immutable snapshots exist | Reject pre-dispatch stale versions; reconcile original instruction after possible send |
| Migration | Legacy API guard exists | Missing/unknown executor or historical ambiguity stays gated; no command backfill |
| Return before settlement, duplicates, feed replay | `demo-reconciliation.test.ts`, `demo-final-review.test.ts` | Keep independent debit and compensating return with original links |
| Module boundaries | No automated architecture gate | Inspect imports for domain/framework and application/adapter dependencies |

The starting dispatcher and `scripts/testing/recovery-evidence.mjs` expect two
`createTransfer` calls after a lost response. Those expectations encode the old
same-key replay behavior. Once the new contract is integrated, the persistent
gate must require lookup first and exactly one send when the transfer exists.
That change belongs to the owners of the existing dispatcher/CI files.

## Fixture design

`tests/payments/fixtures.ts` uses the existing Convex fixture with a real
SQLite-backed FakeBank. It records boundary calls and copies command values
before transport, supports closing/reopening the same bank database, and reads
financial tables independently of the worker's returned status. Simulator
controls remain test-only. No production API is defined by this fixture.

New tests will bind to the reviewed contract and integration commits rather
than introducing a parallel executor. Failure injection uses the existing
kernel transport, persisted leases and bank fault schedule. Scope, amount,
operation key, request hash, destination and exact saved provider bytes remain
part of every recovery assertion.

## Evidence levels

| Level | Required evidence | Current status |
| --- | --- | --- |
| Local unit/integration | Existing and independent tests against local Convex fixtures and durable FakeBank | Pending contract/integration |
| Local persistent process recovery | Fresh isolated Convex backend, exited/restarted dispatcher, bank database, verified journal | Coordinator runs after integration |
| Provider HTTP contract | Pinned Increase fixture and Prism tests | Coordinator runs after integration |
| Live Increase sandbox | Actual provider, authorized credentials and reviewed sandbox setup | **NOT_RUN** |
| Real human JWT / external webhook delivery | Actual identity and delivery prerequisites | **NOT_RUN** |

Use `npm run ci:recovery` on a disposable POSIX environment with an unconfigured
Convex user. Follow `docs/ci.md`; do not delete or reuse another user's global
Convex state to make the runner start. Retain sanitized counts, hashes,
revision and runtime. A missing or failed run is never a pass. Full bank rows,
worker tokens and local admin credentials are private diagnostic material.
