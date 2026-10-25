# Frozen payment contract — issue #59, lane A

Contract version: `scoped-ap-v2`. Baseline is #47 → #49 → #50 + #58. These interfaces consolidate `demoPayments`/`demoEvidence`; they do not add a payment state machine. `src/payments/contracts.ts` re-exports the existing bank contracts and hash functions from `src/integrations/contracts.ts` unchanged.

## Identity and compatibility

| Contract | Existing persisted/API identity |
|---|---|
| `CommandEnvelope<RequestPayment>.commandId` | `requestPayment.requestKey`, deduplicated within run and original requester with identical sorted bills/credits |
| `PaymentId`, `versionId` | `demoVersions._id`, also `BankCommand.commandId` and `BankCommand.approvalVersion` |
| `EffectId`, `LeaseProof.commandId` | `demoCommands._id`, **not** `BankCommand.commandId` |
| External operation key | Existing `BankCommand.idempotencyKey` (`demo:${versionId}`); never regenerate on retry/resume/migration |
| Lease generation | `demoCommands.generation`; increases on claim, fences complete/fail/heartbeat together with lease token and expiry |

All five `BankScope` fields remain required: organization, run, provider, environment and account. Framework IDs are plain strings only at the domain boundary. Adapters convert them to the existing Convex table IDs. No hash format or saved command field changes. `providerRequest` is the original string; validation must not replace it with reconstructed JSON. The unchanged request hash binds its exact bytes.

Other command envelopes carry correlation IDs; this refactor does **not** promise a generic durable command receipt ledger. Human approval retains its existing actor + snapshot replay semantics; cancel and resume retain existing backend checks. No client `subject`, role or actor flag is financial authority. Human commands use the authenticated JWT client; the server derives issuer|subject and seat. Controller approval cannot enqueue a bank transfer.

## Concrete API mapping for lanes B/C

Imports:

```ts
import { PAYMENT_EXECUTOR_VERSION } from "src/payments/contracts";
import type { PaymentCommands, PaymentKernel } from "src/payments/ports/payment-kernel";
import type { PaymentRail } from "src/payments/ports/payment-rail";
import type { PaymentEvidence, EvidenceBank } from "src/payments/ports/payment-evidence";
```

Use repository-relative imports in implementation. Adapters bind complete scope and credentials once. Ports contain neither tokens nor Convex/Node imports. Failed calls reject; there is no invented Result wrapper around existing mutations. Adapters normalize Convex's void/null responses to `Promise<void>` where needed.

`PaymentCommands` maps directly:

| Method | Existing endpoint and mapping |
|---|---|
| `requestPayment(envelope)` | `demoPayments.requestPayment({scope, seatId, token, requestKey: envelope.commandId, billIds, credits})` → `{versionId, snapshotHash}` |
| `approveWithinPolicy(envelope)` | `demoPayments.approveWithinPolicy({scope, seatId, token, versionId, snapshotHash})` → awaiting human approval |
| `approveAndQueue(envelope)` | Human `demoPayments.approveAndQueue({scope, versionId, snapshotHash})` → `{commandId}` (effect ID) |
| `cancel(envelope)` | Human `demoPayments.cancel({scope, versionId})` |
| `resume(envelope)` | Human `demoPayments.resume({scope, commandId, reason})` (same original effect/key/bytes) |

`PaymentKernel` maps directly to `demoPayments.claim`, `heartbeat`, `complete`, `fail`, with scope + dispatcher token injected by adapter. `claim({workerId, leaseToken})` returns `EffectLease | null`. Keep its existing `commandId`, `command`, `generation`, `leaseToken`, `providerTransferId` and **add**:

```ts
paymentExecutorVersion: "scoped-ap-v2";
action: "submit" | "reconcile";
firstAttemptAt: number; // original persisted first attempt, including across manual resume
leaseExpiresAt: number;
```

First claim (`attemptCount === 0`, no previous dispatch evidence) may return `submit`. Every reclaimed, unknown, resumed or previously attempted command returns `reconcile`. Persist the attempt before external I/O. Keep existing lease duration, bounded retry budget, durable next-attempt time and lease checks. `complete` records the provider transfer identity and pending acceptance only. `fail` records unknown/exception, never definitive provider rejection, journal entries, paid bills or reservation release. Use existing `configuration` failure classification for a recovery decision requiring review. Preserve `transport`/`unknown`/`rate_limit` retry behavior and budgets for transient failures.

`PaymentEvidence` methods map 1:1 to same-named `demoEvidence` endpoints; scope and evidence token are injected. `work()` returns typed minimal projections `{notices, commands, transactions, cursor}`; richer backend rows remain assignable. `EvidenceBank` retains only read methods. Webhook verification stays outside the kernel: authenticate raw bytes, persist notice, then ACK. Notices never constitute posting evidence. `resolveCommand` resolves the stored frozen command by its external key; it is not proof that the provider executed it.

## Execution authority and first dispatch

Fresh configured runs persist `paymentExecutorVersion: "scoped-ap-v2"` in the immutable run configuration. Existing configure callers may omit the argument if the server explicitly writes that constant. Historical rows missing the version must not silently default to v2. Reject legacy payment execution on configured v2 runs server-side; application routing alone is insufficient. Unknown historical outcomes require review, not a key backfill.

Configuration freezes `policyVersion` and beneficiary external account/version. Optional `{decisionPath, knowledgeCommit}` provenance records the reviewed source; Git is not consulted for live dispatch authority. Before first dispatch, inside the mutation, use `assertSnapshotCurrent`, `assertCommandMatchesSnapshot`, and `assertFrozenBankCommand` **alongside** existing authenticated human approval, snapshot hash, reservation, bill version/flags and credit checks. Reclaims preserve and reconcile the original frozen command even if new configuration would no longer authorize a new payment. Executor version and lease fencing apply to every claim.

Runtime parsers in `domain/validation.ts` validate safe integer cents, real dates, scopes, command/envelope shapes, exact provider request semantics, evidence and leases. Parsing does not authenticate an actor or prove a bank request hash; `assertFrozenBankCommand` performs the unchanged hash check. Parsers never trim, normalize or regenerate immutable command fields.

## Recovery capability and retention

`PaymentRail` keeps `createTransfer(BankCommand)` and adds `lookupTransfer(command, providerTransferId?)` and a declarative `recovery` capability. Lookup returns a scoped identity tuple (`scope`, `commandId`, `idempotencyKey`, `requestHash`, `checkedAt`) plus `found`, `not_found`, or `unknown`. `found` includes a fully checked `TransferObservation`. A missing known transfer ID is not permission to create a replacement. A partial scan, unavailable lookup or failed request is `unknown`, never an authoritative absence.

After each recovery claim, lookup before any resend. `decideRecovery` permits resend only when all hold:

1. Reconciliation lease remains valid and lookup matches all frozen scope/identity fields.
2. No known provider transfer ID exists; the complete operation-key lookup returned `not_found`.
3. Rail declares scoped operation-key lookup and documented same-key/same-bytes idempotency.
4. For bounded retention, original `firstAttemptAt` is strictly within `retentionMs`; neither lease takeover nor manual budget reset refreshes it.

Policies are `never`, `retained` with positive safe integer duration and documentation, or `durable` with documentation. `found` binds the existing provider identity via `complete`, then evidence ingestion independently verifies settlement/rejection/return. Even a settled observation does not post cash. Unknown lookup leaves the original command unresolved and bounded recovery/operator review applies.

FakeBank may declare durable retention only while its original scoped SQLite database is retained, using its saved unique-key/request record. Destroying/replacing that database invalidates the guarantee. Its lookup implementation must query stored state without calling create. See [fake-bank.md](fake-bank.md) and the canonical `transfers` table.

Increase should initially use `sameKeyResend: {kind: "never", reason: "Provider retention not established for this recovery window"}` unless its adapter owner explicitly documents an adequate guarantee. Do not invent a TTL. Its scoped ACH query may find an existing transfer; lack of guaranteed resend permission does not block read-only reconciliation. Provider documentation references for adapter verification: [idempotency keys](https://www.increase.com/documentation/idempotency-keys), [ACH transfers](https://www.increase.com/documentation/api/ach-transfers).

## Financial evidence rules

`assertObservationMatchesCommand` requires full scope, command ID, external key, request hash, amount, currency, immutable destination and (when supplied) persisted dispatch context/provider identity. Retain existing monotonic observation handling and reject conflicting transaction links; do not overwrite a returned/settled state with delayed pending evidence.

`assertPostingEvidence` allows only a posted, negative debit for the frozen amount and the observation's original transaction ID, or a separate positive return linked to that original debit. Posting a return additionally requires the original debit's matching scope/command/transfer/amount and an existing journal entry. Unrelated account activity (`purpose: other`) remains imported and blocked for separate explicit review; it cannot settle an AP payment. A transfer accepted/pending/unknown is never cash evidence. Preserve all account evidence even if it cannot be matched.

Convex remains responsible for atomic journal + bill/credit/reservation effects + match, transaction/purpose uniqueness, open accounting periods and replay markers. Rules are pure checks, not a transaction coordinator. Preserve separate return entries and existing scoped posting keys. Application and rail adapters cannot mark bills paid directly.

## Lane verification

Lane A owns validators/rules and `tests/payments/rules.test.ts`. B owns authoritative mutation checks and backend regression tests. C owns adapter mapping and application recovery. D/coordinator verify crashes, stale workers, migration, local posting failure and integrated behavior. Unit tests alone do not establish live provider guarantees.
