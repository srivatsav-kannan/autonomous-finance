# Persistent FakeBank

This implements task A of [issue #39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39). It uses `node:sqlite` and needs the repository's Node version (24.18 or later); Node may print an experimental SQLite warning.

Run the provider tests:

```sh
npm ci
npx vitest run src/integrations/banking/fake.test.ts
npm run typecheck
```

The tests include eight independent Node processes racing the same request, an actual process exit after a committed transfer's response is lost, durable fault counters, changed-payload conflicts, account isolation, duplicate/reordered/dropped authenticated notifications, paging, rejection, settlement and returns. These are local simulator tests, not evidence of a successful Increase sandbox request.

## Opening a bank

The trusted demo coordinator calls `openFakeBank` from `src/integrations/banking/fake.ts` with a persistent SQLite `path`, a `seed`, and the full `BankScope`. The demo supports one `fake`/`local` USD account per database. Reopening a file with another organization, run, account, seed, or an explicitly different webhook secret fails. Never reset this file when restarting only an application worker.

The returned object separates three capabilities:

- `provider`: balance, transfer submission/lookup and posted transaction lookup/pagination. Only the dispatcher receives transfer submission.
- `events`: raw-body signature verification and read-only event history.
- `harness`: clock advancement, settlement/rejection/return, fault scheduling, notification delivery and inspection. Give this only to the test coordinator.

The operating agent receives none of these objects. An interface split is not an operating-system sandbox: run untrusted agent tools under a separate OS identity/container without access to the bank database, worker environment or harness module execution. The bank file is created with owner-only permissions. Protect its parent directory and SQLite sidecar files with the same deployment boundary. Default notification authentication uses a random persisted secret; a fixed secret can be supplied explicitly only for reproducible tests.

## Persistence and recovery

SQLite WAL, `synchronous=FULL`, a ten-second busy timeout and `BEGIN IMMEDIATE` transactions make key allocation, balance reservation, transfer creation and lifecycle changes atomic across processes. The idempotency key has a unique database constraint. Its saved canonical request must match on replay. The request hash is SHA-256 over the recursively key-sorted complete command excluding only `requestHash`; IDs, scope, approved version and beneficiary version are included.

IDs and event times use the persisted seed, sequence and virtual clock. Faults select a method and one-based invocation number; these counters are persisted independently of process memory. The `accept_then_lost_response` fault commits the transfer before throwing an ambiguous transport error. A restarted dispatcher must retry its original saved command and key. Available faults also cover authentication, rate limits/Retry-After, disconnects, unavailable responses and delay. Delivery controls drop, duplicate or reverse queued notices while preserving queryable event history.

A pending transfer reserves available funds but has no posted cash movement. Settlement creates a distinct immutable posted debit; a return requires that debit and creates a distinct posted credit referencing it. Repeating a completed transition does not add another transaction. Rejection creates no posted transaction. Insufficient funds produces a durable rejected transfer. Pending holds become `complete` when the transfer settles or is rejected, matching Increase; they remain queryable but are never returned by `listTransactions`, which supplies only posted economic evidence.

`BankPage.cursor` is an incremental checkpoint, including on empty pages. `nextCursor` is non-null only when another page currently exists. Persist imported records and `cursor` together in the application transaction. A cursor is bound to the account and resource kind; replaying it is safe. A bank notification is only a hint: verify its raw bytes, durably ingest it, then fetch the current transfer and transaction before posting cash.
