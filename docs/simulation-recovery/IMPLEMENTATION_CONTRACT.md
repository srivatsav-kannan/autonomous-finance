# Data and lifecycle contract for the AP demo

Status: proposed implementation contract for issue #39, not completed runtime work.
Read this with views 6 and 7 in the [seven-diagram gallery](DIAGRAMS.md).
Names below are logical concepts; the implementer should map them to concrete
tables, validators and indexes after inspecting the current schema.

## Ownership and identity

For this demo, Convex owns the application state and AP journal. The selected
bank adapter exposes independent provider execution state. Git supplies reviewed,
activated policy and beneficiary versions; it does not own money or credit state.
An ERP-authoritative product is a future alternative, not a second writer to the
same demo books.

| Concept | Required identity and relationships | Current-to-target change |
|---|---|---|
| Bill | Scoped vendor/invoice identity, source evidence, original and approved amounts, currency | Extend existing bills; preserve source amounts when short-paying |
| Credit and allocation | Credit identity, bill/payment version, available/reserved/consumed/released amount | New explicit model; reject concurrent over-allocation |
| Payment version | Distinct bill IDs and per-bill amounts, credits, net amount, currency, beneficiary version, policy version, canonical snapshot hash | Existing intent plus new immutable version |
| Approval | Principal, authority/limits, exact version/hash, decision | Bind existing approval concept to the immutable version |
| Provider command | One per authorized version; provider/account/environment, exact request, request hash, stable idempotency key | New durable outbox |
| Attempt | Command, attempt identity, lease generation/token, start/result, error class, retry time | Extend task lease concept; persist attempt start before HTTP |
| Inbox/evidence | Provider event identity, fetched resource/transaction identity, command linkage, processing state | New durable ingestion; retain unmatched early notifications |
| Economic posting | Scoped provider transaction ID + posting purpose, journal, balances, consumed marker | New marker around existing journal path |
| Reconciliation | Bank transaction evidence linked to existing cash journal effect | Explicit link; matching cannot post cash a second time |

Scope identifiers by organization/run and provider/environment/account wherever
applicable. Organization scope is new work; current rows are mainly run-scoped.
Enforce logical uniqueness with indexed reads and writes in the same mutation;
an index by itself is not a declarative uniqueness constraint. Keep execution,
posting and reconciliation as separate state dimensions.

## Atomic boundaries

- **T1 — accept bill:** accepted bill, accrual journal, balances/head and
  idempotency result commit together. Invalid operations cannot leave partial state.
- **T2 — authorize and queue:** verify version and approvals, reserve obligations
  and credits, create the immutable command/key and queued state together. If a
  reservation already exists, validate ownership instead of reserving twice.
- **Claim attempt:** fence by generation/token and persist attempt start before
  network I/O. Reject stale claim/heartbeat/completion writes, including same-seat
  restarts. This transaction cannot include the external bank call.
- **T3 — ingest:** durable notice/page records, processing work and polling cursor
  commit together. Webhook acknowledgment follows durable ingestion. Matching and
  posting may happen later, without blocking safe cursor advancement.
- **T4 — post:** verify stored bank evidence and atomically commit the unique
  economic marker, balanced journal, balance/head and payment/bill/credit effects.
  Retry a failed local posting without submitting another bank payment.

## Lifecycle guards and accounting example

The example is USD principal only, without fees, FX or tax allocation. Accepting
a simple expense bill records Dr expense / Cr AP. Verified settlement records
Dr AP / Cr cash. Reconciliation links the bank debit to that existing journal.

An independently approved payment version fixes its bill amounts, credits,
currency, net amount, beneficiary and policy. Material changes before dispatch
invalidate the unsent version, atomically release only eligible reservations and
require a new version and approval. Cancellation must atomically prove no attempt
has started and prevent a later claim. If submission may already have begun,
resolve that command's outcome before replacement or release; a local void is
not evidence that the bank did nothing.

An evidenced permanent rejection with no economic movement closes the command
and releases eligible reservations atomically; it does not create a settlement
journal. An ambiguous timeout, empty lookup or exhausted retry budget does not
prove rejection. Preserve the command, key, provider and reservations and raise
an operator exception when automatic recovery reaches its budget.

A verified return is a distinct economic transaction: Dr cash / Cr AP for the
returned principal, preserving the original settlement entry. Previously applied
credits remain consumed; a return must not silently make those credits reusable.
If return evidence arrives first, fetch and validate both original debit and
return, posting each once. Missing evidence blocks posting. Re-payment requires
a new approved command based on resolved outcomes and remaining obligations.

Unknown payments, unposted verified transactions and unexplained bank activity
block a clean close. Simulation controls and evaluator truth remain outside
operating-agent tools.

## Exact implementation handoff

1. **B with A/C, M0–M2:** publish concrete table/validator/index mappings for
   view 6 and command/observation types before parallel schema edits. Include
   request hashes, all scoping fields and the T1–T4 transaction entry points.
2. **B, M0/M2; R05/R06:** implement version-bound approvals and an atomic
   cancel-versus-claim guard. Test material changes, concurrent credit use,
   stale workers and cancellation racing the first attempt. Assert rejected
   operations leave no partial writes and cannot later send.
3. **C, M3; R07–R11:** distinguish delivery deduplication from economic posting;
   cover permanent rejection, local-posting retry, return-first delivery and
   returns after credit application. Assert returned cash does not free consumed
   credit and unknown outcomes do not release reservations.
4. **D with B/C, M5; R12:** demonstrate view 7 from invoice evidence through
   independent approval, settlement and reconciliation. Record IDs linking
   version, command, provider transaction and journal; repeat with response loss,
   worker restart and missing webhook. Keep simulator and sandbox proof separate.

Source references: [Convex mutation transactions](https://docs.convex.dev/functions/mutation-functions#transactions),
[Increase idempotency](https://increase.com/documentation/idempotency-keys),
[Increase events and webhooks](https://increase.com/documentation/webhooks).
