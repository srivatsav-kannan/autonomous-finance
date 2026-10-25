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

## Independent tests and fixtures

`tests/payments/fixtures.ts` uses the existing Convex fixture with a real
SQLite-backed FakeBank. It records boundary calls and copies command values
before transport, supports closing/reopening the same bank database, and reads
financial tables independently of the worker's returned status. Simulator
controls remain test-only. No production API is defined by this fixture.

Contract freeze: integration `6e22066`, followed by lane A domain rules at
`f57031b`. The independent suites bind to these reviewed contracts. Failure
injection uses the existing kernel transport, persisted leases and bank fault
schedule. Scope, amount, operation key, request hash, destination and exact
saved provider bytes remain part of recovery assertions.

- `recovery.test.ts` exercises the application through narrow ports. It checks
  lookup before resend, scope and observation mismatches, known transfer IDs,
  unknown/failed lookup, lease expiry and the strict retention boundary. A saved
  Increase JSON body with valid extra whitespace detects accidental regeneration.
- `migration.test.ts` checks explicit executor selection, old callers, readable
  historical rows with missing metadata, refusal to activate over legacy
  submitted payments, policy/beneficiary changes and stale completion fences.
- `evidence.test.ts` checks accepted versus settled state, local posting rollback
  with a reserved credit, unknown same-account bank activity, and distinct
  debit/return postings under reordered duplicate delivery. It reads accounting
  tables independently of worker results.
- `architecture.test.ts` scans TypeScript imports, including type-only and dynamic
  imports. Domain and ports remain independent of IO/frameworks; application
  code depends on domain/ports, and agent entries receive no transfer capability.
- `process-recovery.test.ts` launches actual worker subprocesses through a private
  loopback bridge to the parent's **in-memory Convex fixture**. It exits a worker
  after claim/before send and after accept/drop, reopens the same SQLite bank,
  and checks that the restarted worker looks up before any send. This proves
  worker-process isolation and bank persistence; it does **not** prove a Convex
  backend restart. The separate `ci:recovery` gate supplies persistent-backend
  evidence.

The child harness receives only a local fixture configuration and a minimal
environment. Its bridge permits dispatcher mutations only. Its call trace
and SQLite file are private temporary test inputs, removed after each test.

## Recovery and migration operations

Fresh runs record executor `scoped-ap-v2`. Claim callers must identify that
executor. A historical run missing its version stays readable through the
human review endpoint but is blocked from execution; do not stamp a new version
onto it, create a replacement operation key, or reconstruct request bytes.
Existing legacy financial rows prevent fresh scoped activation on that run.
Resolve the historical bank outcome and retain its evidence for explicit review.

For a current run, inspect the command, first-attempt time, provider transfer ID,
attempt history, execution/posting state and original scope. An expired lease
requires reconciliation of the saved command. A found transfer is bound to its
existing ID. An unknown result stays unresolved. Absence permits the same saved
request only when the adapter's complete operation-key lookup and documented
retention guarantee both allow it; changing the retry budget does not extend
provider retention.

An accepted transfer leaves the bill reserved and unpaid. If bank evidence is
posted but local accounting failed, retain the evidence and repair the local
cause (for example, reservation ownership or a closed accounting period) through
the reviewed operator process. Retry evidence posting; a new bank submission is
not an accounting repair. A return is a separate compensating entry tied to the
original posted debit. Neither delayed pending notifications nor duplicate feed
pages may remove that economic history.

### Releasing a command that was claimed but never sent ([#76](https://github.com/srivatsav-kannan/autonomous-finance/issues/76))

A dispatcher can die after the claim records an attempt but before the provider
POST. Increase is configured never to resend after an attempt, so recovery finds
nothing and the command lands in `exception`; `resume` repeats the same lookup
and `cancel` is refused once an attempt exists. The bills would stay reserved
forever. `demoPayments.releaseUnsent` is the audited way out:

- Human JWT only. Agent seats and service secrets are refused. A reason is required.
- Only an `exception` command with a first attempt and no provider transfer ID.
- Only after `RELEASE_SAFETY_WINDOW_MS` (24 h) since `firstAttemptAt`. Increase
  guarantees at most one object per idempotency key but documents no key
  retention or read-visibility window, and advises against automating on list
  reads ([idempotency keys](https://increase.com/documentation/idempotency-keys)).
  Our own bounds are far shorter (15 s request timeout, 30 s lease, 24 h
  automatic recovery budget), so the window adds margin rather than proof.
- A fresh provider check (at most 15 minutes old, taken after the window):
  operation-key lookup returns `not_found`, and a complete read-only scan from
  `firstAttemptAt` finds no ACH transfer to the beneficiary with this amount or
  key and no posted debit of this amount. Convex holds no bank credentials, so
  the trusted operator harness (`npm run ops:release-unsent -- <commandId> "<reason>"`,
  `ReleaseUnsentPayment` in `src/payments/application/`) performs the check and
  the mutation re-validates it, plus local evidence (no accepted attempt,
  observation, imported transaction or unprocessed notice for the run).
- On release the command becomes `cancelled`, the payment version is cancelled,
  bill and credit reservations are released, and `unsent_payment_released` is
  audited with the operator, reason, original key/request hash and the check.
- A transfer that later appears for the released command is never posted. It
  sets `lateTransferId`, records `released_payment_transfer_appeared`, keeps its
  transaction in `exception` and blocks close as a possible duplicate payment.

The same-key resubmit alternative was not taken: Increase's documentation does
not state how long a key is retained, so a resubmit could not be proven safe.
Tests: `tests/payments/release-unsent.test.ts`.

## Evidence levels

| Level | Required evidence | Current status |
| --- | --- | --- |
| Local unit/integration | Existing and independent tests against local Convex fixtures and durable FakeBank | **PASSED**; see revision details below |
| Local worker subprocess | Two real worker exits/restarts; same SQLite bank; in-memory Convex bridge | **PASSED**; one send, one lookup and one cash entry per case |
| Local persistent process recovery | Fresh isolated Convex backend, exited/restarted dispatcher, bank database, verified journal | **PASSED** at integrated `794a10e`; see `core-validation.json` |
| Provider HTTP contract | Pinned Increase fixture and Prism tests | **PASSED** in full repository suite; no live provider call |
| Live Increase sandbox | Actual provider, authorized credentials and reviewed sandbox setup | **NOT_RUN** |
| Real human JWT / external webhook delivery | Actual identity and delivery prerequisites | **NOT_RUN** |

Use `npm run ci:recovery` on a disposable POSIX environment with an unconfigured
Convex user. Follow `docs/ci.md`; do not delete or reuse another user's global
Convex state to make the runner start. Retain sanitized counts, hashes,
revision and runtime. A missing or failed run is never a pass. Full bank rows,
worker tokens and local admin credentials are private diagnostic material.

## D verification record — 2026-10-24

Verification ran on Node `v24.22.0`, macOS arm64, with local fixture identities. Production
dependencies were A `4d8827c` / `f57031b`, B `c167d70` / `0d9e033`, and C
`20d7aad` / `1255df3` / `8568fd0`. With D's independent suites, the full repository
run passed **386 tests in 35 files**. Application, backend and test TypeScript
checks and the console production build also passed.

After the final B evidence-parser update `62ad28d`, the affected demo, kernel
and payment-module suites passed **153 tests in 14 files**; backend and test
TypeScript checks passed again. The payment-module folder contains 35 lane A
rule tests and **43 independent lane D tests** across migration, application
recovery, evidence, architecture and real subprocess recovery.

Independent verification found a regression in C `20d7aad`: a verified scoped
pending transfer without a local command was rejected before retention. The
unchanged existing regression and new independent observation-table assertion
both failed. C `8568fd0` restored retention; B `62ad28d` validates the unmatched
observation before retaining it. Both tests now pass, while no unmatched
transaction can create a journal entry.

The D handoff above preceded the coordinator's persistent run. The coordinator
then fixed unsupported hyphenated Convex helper filenames and independently
verified integrated `794a10e`: **387/387 tests**, all three TypeScript checks,
console build, and persistent local Convex/FakeBank recovery passed. The proof
records two leased attempts, one create call, one lookup, one transfer, one
posted debit, one linked cash journal entry, and zero close blockers. See
`core-validation.json` for hashes and runtime. Additional CI/browser gates are
tracked in `COORDINATION.md`; they are not inferred from this core run.
Live Increase, real external human JWT and external webhook delivery remain **NOT_RUN**.

## Final integrated CI and browser validation

The coordinator's clean `28a270dd0d42d76ad55ed7f55105d4cd4b534c7c` passed **400 tests
in 37 files**, all three TypeScript checks and the console build. The upgraded
persistent gate sent a real parent-issued **SIGKILL** after durable bank acceptance
and before any local completion. After lease expiry, the replacement worker
looked up the identical frozen command: one submit, one lookup, one transfer,
one posted debit, one cash journal entry and zero close blockers. This supersedes
the earlier deliberate child-exit recovery proof without claiming a backend restart.

Three real Chromium tests also passed against a separate local Convex/FakeBank
fixture with signed RS256 test-human JWTs. The browser verified authorization,
human approval, pending unpaid state, verified settlement and visible evidence;
the runner independently read the persisted journal. Staging is **NOT_RUN**,
exit 2, until its target and authentication fixture are supplied. Full sanitized
results are in [final-validation.json](final-validation.json); commands and the
reusable staging gate are described in [BROWSER.md](BROWSER.md).
