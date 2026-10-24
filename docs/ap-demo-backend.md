# AP authorization, dispatch and reconciliation

Implements tasks B/C of [#39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39), on the persistent bank contract in #47. The Increase adapter and executable live demo are the next stacked PR.

The demo uses fresh configured runs. `demoPayments.configure` binds one organization, run, provider, environment and USD account to an immutable beneficiary/policy version and human identity issuer+subject. Historical financial rows cannot be activated or automatically replayed. Existing anonymous legacy queries and write APIs reject configured demo runs.

AP records invoice evidence and discrepancies. Controllers accept bills within policy. Payments request versions using stored bills/credits; the backend computes amounts and destinations. Controller/CFO approvals never replace the required independent human JWT. `approveAndQueue` binds the reviewed snapshot hash and atomically reserves bills/credits and stores the exact bank command/key. Increase requests additionally persist exact request bytes. Changing terms requires a fresh version and approval. There is no agent banking capability in Team/SeatRuntime; the legacy payment handler only requests payment. Use the new demo flow for execution.

Only the dispatcher service may claim, heartbeat, complete or fail an attempt. Its deployment secret is distinct from admin/evidence credentials and bound by `AP_BANK_SCOPE`. An attempt is saved before I/O; lease generation and random token fence stale workers, including same-seat restarts. Cancellation atomically refuses any started attempt. Unknown outcomes, exhausted retries and configuration failures retain reservations. Human `resume` records a reason and keeps the original request/key; its budget is separate from lifetime attempt history.

Only the evidence service may ingest hints, fetch/import bank facts, advance cursors and post. `EvidenceWorker.receive` verifies raw bytes before storing a notification; HTTP callers must acknowledge only after the mutation succeeds. Polling pages and cursor updates commit together. Notifications are deduplicated separately from immutable transaction IDs. Cash requires the matching approved command, fetched transfer, exact original/return transaction ID, posted status and signed amount. Journal, balances, consumption marker, bill/credit effects and reconciliation link commit in one mutation. A failed local write retries posting without resending. Returns preserve the debit and consumed credits. Unmatched transfers/transactions, failed posting, pending approval, open bills and AP flags block close.

`/ap-demo` is the human console: exact snapshot review, expected-hash approval, dispatch/posting/matching state, attempts, next retry, operator, evidence IDs and reasoned resume. It requires an actual configured JWT; it does not accept agent/service credentials or expose simulator controls.

## Checks

Node 24.6+ is required for SQLite. Run:

```sh
npm ci
npm test
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npx vite build --config console/vite.config.ts
```

Focused suites: `npm run test:bank` and `npm run test:payments`. Tests invoke actual Convex function implementations with `convex-test` and an independent persistent SQLite bank. They cover authorization/issuer/scope isolation, exact approvals, conflicting idempotency, atomic allocation and cancellation, concurrent dispatch, stale workers, lost bank responses, failed local completion, bounded retries, missing/duplicate/reordered webhooks, returns, cursor rollback, concurrent posting and failed posting after journal writes. `convex-test` is a transaction-capable test implementation, not a deployed Convex server or real human identity provider.

Deploy backend and workers together. Configure `AP_HUMAN_AUTH_ISSUER`, `AP_HUMAN_AUTH_AUDIENCE`, `AP_BANK_SCOPE` (full JSON scope), and distinct `KERNEL_ADMIN_SECRET`, `AP_DISPATCH_SECRET`, `AP_EVIDENCE_SECRET`. Human JWT authentication must bind the configured issuer+subject to an active human CFO seat. Keep the three service roles and bank/harness files outside agent OS/process access; TypeScript capability objects do not sandbox a process with filesystem access. Broader legacy scenario/evaluator completeness is outside this one-account demo.

Validated on current main `adbe32c`: 212 tests passed (32 new backend/recovery tests and 12 FakeBank tests), application/backend/test TypeScript and console build passed, and the existing local Convex/kernel+Git smoke suite passed all 42 checks. Real human-provider and Increase sandbox execution are not claimed by these checks.
