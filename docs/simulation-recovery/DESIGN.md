# Simulator selection and recovery design

Discussion draft, 2026-10-23. These are proposed changes, not implemented capabilities.
Goal: one credible vendor-payment demo with low deployment and integration cost.

Implementation: [issue #39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39).
Start with the dependency-ordered [TODO](TODO.md); see the [handoff](README.md)
for editable diagrams and instructions for the implementing agent.

## Recommended stack

| Component | Decision | Responsibility |
|---|---|---|
| Existing Worldsim | Keep | Seeded invoices, receipts, company events, virtual clock and evaluator-only truth |
| Stateful FakeBank | Extend the existing WorldBank | Independent persistent bank state, transfers, transactions, idempotency and programmable failures |
| Increase sandbox | First external provider | Validate actual API/authentication and one outbound ACH credit lifecycle with bank activity |
| Prism | Add with the HTTP adapter | Validate requests and responses against a pinned OpenAPI subset; fixture responses for contract tests |
| Mockoon | Defer | Add only if a configurable HTTP fixture UI saves more work than maintaining another mock system |
| stripe-mock | Defer to a Stripe slice | Stripe SDK/request-shape smoke checks, not bank behavior or settlement proof |

Odoo/ERPNext are later upstream business-document environments; Lago is a billing
source. None is needed to simulate the first bank flow. Formance/Blnk/TigerBeetle
are ledger choices, not substitutes for a bank simulator. Beancount/Fava can
inspect a derived accounting export, but cannot establish provider execution.

Run the same application and BankingProvider interface against FakeBank or the
Increase adapter. Select the provider explicitly and persist it on each command.
Never fail over a payment with an unknown outcome to another provider or simulator.

## What to mock

Mock the external banking boundary: connection errors, latency, rate limits,
malformed responses, lost responses after acceptance and notification delivery.
Use a stateful simulator for bank lifecycle and economic events. Use Prism for
the HTTP contract. These are different kinds of evidence.

Keep the real approval rules, credit reservations, durable jobs, inbox/outbox,
ledger mutations and reconciliation in end-to-end tests. Mocking those would
hide the defects we need the demo to expose. A replayable model response can be
used in recovery tests to remove LLM variability; keep live-agent evaluation separate.

The current `src/world/bank.ts` is a JSON outbox with intent-ID deduplication and
next-day debits. `src/agents/handlers/payments.ts` immediately calls settlePayment
after WorldBank.send. This does not yet prove the lifecycle or recovery below.

## FakeBank requirements

- Independent persistent test datastore with atomic writes and unique keys;
  a separate SQLite test database is a reasonable small implementation. No
  dependency on application memory or a shared application/bank transaction.
- Seeded IDs, virtual time and a persisted fault schedule for reproducibility.
- Same key and same request returns the original transfer; changed request under
  the same key rejects. Compare a canonical request fingerprint.
- Transfer states plus separate pending and posted bank transactions. Support
  rejection and returns, rather than treating every send as an immediate settlement.
- Queryable current state, event history and paginated transactions.
- Harness-only controls for settle, return, duplicate/drop/reorder notifications
  and crash points. Agents cannot advance the bank or inspect the answer key.
- During a worker crash test, preserve the bank datastore and Convex state.
  Resetting both sides would erase the ambiguous transaction and invalidate the test.

## Recovery policy

Persist an immutable approved command and its provider idempotency key before any
external request. Record attempts, fenced lease generation, nextAttemptAt,
normalized error class, request hash, provider IDs and evidence references.
Worker memory is disposable. Bank calls occur outside Convex database transactions.

| Failure | Required recovery |
|---|---|
| Invalid amount, stale approval, changed beneficiary | Reject before sending. Correct the cause and reapprove changed payment terms |
| 401/403 or configuration failure | Pause the adapter and notify an operator; do not hot-loop |
| 429 | Honor Retry-After when supplied; persist bounded backoff with jitter and reuse the original command/key |
| Network timeout or 5xx after submission may have started | Mark outcome unknown, retain reservations, and use the provider's supported same-key retry policy |
| Worker crash | Expired lease permits another worker to resume the recorded step; fencing rejects stale local updates |
| Same key with different payload / 409 conflict | Quarantine the command; diagnose the mismatch. Do not solve it by generating another key |
| Missing webhook | Poll events and transactions; commit each imported page and its cursor together |
| Duplicate or out-of-order event | Deduplicate event ingestion, fetch current provider facts and avoid regressing state |
| Bank settled but local posting failed | Preserve bank evidence and retry only the local posting transaction; never resubmit the payment |
| Return | Retrieve original debit and return transaction; post each economic event once, retaining original history |
| Exhausted retry budget, invalid accounting invariant or insufficient evidence | Exception queue with owner, evidence and explicit resolution. Unknown outcomes retain reservations |

Classify provider outcomes from documented semantics, not HTTP status alone.
Permanent rejection must be evidenced before releasing a reservation. A timeout
or an empty lookup is not proof that a payment does not exist.

Keep execution, posting and reconciliation states separate. Ingestion first
verifies the webhook's raw-body signature and environment/account scope, then
persists the event and processing job before acknowledging it. Increase events
reference objects; the worker fetches those objects rather than treating the
notification itself as settlement evidence. Polling joins the same processing path.
Journal writes and the consumed/economic-event marker commit in one mutation.
Use organization/run, provider, environment/account, bank-transaction ID and
posting purpose for financial deduplication, separately from webhook event-ID
deduplication.

If a return is observed first, fetch both underlying bank transactions. Import
both verified economic events if needed, without regressing the returned state.
Missing original evidence causes an exception, not an invented reversal.
Reconciliation links the statement entry to an existing posting; it does not
post the same cash movement again.

## Provider-specific details

- Increase recommends retrying identical POST parameters with the same
  Idempotency-Key for transient errors. Lookup by key exists, but list-based
  lookup is not its recommended normal recovery algorithm. Do not invent a
  provider-specific 24-hour key expiry. [Idempotency documentation](https://increase.com/documentation/idempotency-keys)
- Sandbox simulation APIs can trigger external effects and corresponding
  notifications. [Sandbox documentation](https://increase.com/documentation/sandbox)
- Failed sandbox webhook deliveries are not retried. Events reference resources
  that need fetching; event history is available for 30 days. Longer outages
  require resource/transaction reconciliation, not an assumption of complete
  event history. [Webhooks documentation](https://increase.com/documentation/webhooks)
- ACH's raw status can remain `submitted` after settlement. Use
  `settlement.settled_at` and the corresponding posted Transaction. Returns have
  a separate Transaction. [ACH lifecycle](https://increase.com/documentation/sending-ach-transfers)
- Prism checks API contracts; stripe-mock does not reproduce complete Stripe
  behavior. [Prism](https://github.com/stoplightio/prism),
  [stripe-mock](https://github.com/stripe/stripe-mock)

## Demonstration and acceptance evidence

Primary scenario: approve one bill, let the bank accept the transfer, drop its
response, kill the worker, resume with a new lease and the same key, drop the
webhook, recover through polling, then post and reconcile.

Assert one provider transfer for the command, one original debit, one settlement
journal effect and one reconciliation link. In a return scenario, expect the
additional evidenced return transaction and compensating entry exactly once.

Also cover changed replay payload, stale approval, concurrent lease holders,
duplicate and reordered events, posting failure after bank settlement, cursor
replay after a crash and retry exhaustion. The operator view must show the step,
last error, next attempt, evidence and why an item is blocked.

Report simulator, contract and sandbox results separately, with seed, fault
schedule, application commit, fixture hash and provider/spec version. Missing
sandbox credentials mean not run, never pass. This design update did not execute
a provider integration or claim these tests already exist.
