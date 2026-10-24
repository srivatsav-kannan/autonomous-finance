# Implementation TODO: simulator and recoverable AP payments

Tracking: [issue #39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39).
Read [DESIGN.md](DESIGN.md) for state ownership, recovery policy and source links.

Preparation is complete: design, editable diagrams, issue and this checklist.
All runtime milestones below remain unchecked. This branch starts from main at
`9183d48c6921a1e1c08ea6c7fe011edad0ca56e9`; it does not include the unmerged design
or fix branches. Inspect their current status before integrating any changes.

Read the [seven-diagram gallery](DIAGRAMS.md) and the
[data and lifecycle contract](IMPLEMENTATION_CONTRACT.md) with this checklist.
Views 6–7 specify schema ownership, transaction boundaries and approval/cancellation
guards; their implementation requirements map to the milestones and acceptance
scenarios below. They do not mark any runtime task complete.

## Dependencies and first step

M1 (contract/FakeBank) can begin while M0 prerequisites are being resolved.
M2 requires M0 and M1; M3 requires M2. A read-only sandbox/API contract spike can
run earlier, but M4 payment execution requires M0–M3. M5 validates the entire flow.

**First coding task:** define and inject BankingProvider, then implement persistent
FakeBank idempotency tests. Do not begin by wrapping the existing payment handler
in retries: it queries only approved intents, then marks them submitted before
the bank call. Failed submissions will not be selected again by that loop.

## M0 — verify baseline and selected-flow prerequisites

- [ ] Inspect current main, issue #37 and PRs #32–#38; record merged prerequisites.
- [ ] Run the existing baseline commands below in an isolated environment and
  record failures without relabeling known failures as passes.
- [ ] Ensure bill, credit allocation, reservation and journal changes are atomic
  for the selected flow. Reuse #1, #2, #3, #4 and #17 rather than duplicating them.
- [ ] Bind approval to immutable bill set, per-bill amounts, credit allocations,
  currency, net amount, beneficiary version and policy version. Reapprove changes.
- [ ] Enforce authenticated human approval and organization/run scope; reuse
  #27 and #28. Provider/harness identities must not impersonate the human approver.
- [ ] Record existing rows requiring migration/backfill. Do not blindly replay
  historical submitted payments whose external outcome is unknown.

Gate: rejected or replayed operations leave correct business state; approval and
provider boundaries hold for the chosen AP slice. Broader product changes remain
under the parent architecture issue.

## M1 — provider contract and deterministic persistent FakeBank

- [ ] Add typed command, observation, transaction, pagination and normalized
  error contracts under `src/integrations/`.
- [ ] Commands carry organization/run, provider environment/account, approved
  version, amount/currency, beneficiary reference, command ID, request hash and key.
- [ ] Inject BankingProvider into `src/agents/team.ts`, `runtime.ts` and
  `src/world/emitter.ts`; remove hard-coded WorldBank construction in both the
  team and world-emission paths.
- [ ] Extend `src/world/bank.ts` or add a world adapter with independent durable
  state, atomic updates and uniqueness enforcement. Document the storage choice.
- [ ] Same key plus identical payload returns the original transfer; conflicting
  payload rejects. Bank state must survive application worker restarts.
- [ ] Model pending, settled, rejected and returned outcomes plus their economic
  transactions; add current-state queries and paginated history.
- [ ] Use seeded IDs, virtual time and a persisted fault schedule. Replace the
  `Math.random()` duplicate-delivery choice in `src/world/emitter.ts` for this profile.
- [ ] Add test-only controls for post-acceptance response loss, delay, disconnect,
  429/5xx, notification loss/duplication/reordering and returns.
- [ ] Keep settlement controls and evaluator truth outside agent capabilities.

Gate: R01–R03 below pass against the real persistent fake, with reproducible seeds.

## M2 — durable dispatch and bounded retry

- [ ] Add scoped outbox, attempts, lease generation, retry time, provider IDs and
  separate execution/posting/reconciliation states to `convex/schema.ts`.
- [ ] Atomically create one immutable command and reserve obligations. Persist
  the stable provider key before the external request.
- [ ] Add a dispatcher that scans due commands and resumes submitted/unknown
  work. It must not depend on a handler querying only approved payment intents.
- [ ] Fence claim/heartbeat/complete/fail writes by lease generation/token,
  including the same seat after restart; seat identity alone is insufficient.
- [ ] Persist attempt start before calling the bank outside the DB transaction.
  Remove unconditional `send → settlePayment` from the current handler.
- [ ] Classify validation, auth/configuration, rate limit, ambiguous transport,
  idempotency conflict and evidenced permanent rejection separately.
- [ ] Persist bounded backoff with jitter, Retry-After when supplied, attempt/time
  budgets and an explicit exception state. Preserve reservations while unknown.
- [ ] Never change payment key/provider to resolve ambiguity. Do not release a
  reservation solely because retries ended or a status lookup returned no result.

Gate: R04–R06 and R10 pass, including a crash after bank acceptance and before the
provider ID is saved locally.

## M3 — verified ingestion, posting and reconciliation

- [ ] Add durable inbox plus processing jobs; deduplicate by provider/account/
  environment/event ID. Acknowledge a webhook only after durable ingestion.
- [ ] Verify signature over raw bytes and provider identity/scope. Fetch the
  associated transfer/transaction: the event notification is not settlement proof.
- [ ] Route polling and webhook observations through the same normalization path;
  commit imported pages and cursor advancement atomically.
- [ ] Retain unmatched early notifications and link them once command/provider
  identity is resolved. Arrival order must not regress execution state.
- [ ] Commit journal posting and consumed-event status atomically. Financial
  deduplication uses organization/run, provider, environment/account, bank
  transaction ID and posting purpose, independently of webhook delivery/event
  deduplication.
- [ ] If the bank settled but a local posting fails, retry only the local mutation.
- [ ] Handle returns with original debit and return evidence. If the return is
  observed first, import both verified effects once or raise an evidence exception.
- [ ] Match bank activity to existing cash entries without posting it twice.
  Keep unexplained entries/payments as close blockers for this AP slice (#24/#31).
- [ ] Expose blocked step, last error, attempt count, next retry, evidence and
  responsible operator in the console; add authorized, audited resume actions.

Gate: R07–R09 and R11–R12 pass with independent bank and application assertions.

## M4 — Increase sandbox and Prism

- [ ] Pin the supported API/specification version or hash; implement one outbound
  ACH credit path in `src/integrations/banking/increase.ts` (proposed location).
- [ ] Keep sandbox host/account binding explicit. Isolate credentials behind the
  adapter; do not expose arbitrary HTTP or simulation APIs as agent tools.
- [ ] Implement identical-POST/same-key retry as documented by Increase; preserve
  payload fingerprints. Do not invent a key-expiry interval or use a fresh key.
- [ ] Map settlement from `settlement.settled_at` plus posted Transaction evidence;
  raw ACH `submitted` can remain unchanged after settlement.
- [ ] Support signed notifications and recovery polling. Sandbox webhooks are not
  retried by Increase, so test dropped delivery explicitly.
- [ ] Add Prism tests against a pinned OpenAPI subset and fixtures, covering
  outgoing requests, incoming responses and invalid/error contracts.
- [ ] Add test-harness-only setup/settlement/return controls. Keep existing
  application code under test; do not substitute a different sandbox-only flow.
- [ ] Document environment variables and runnable local-sim, contract and sandbox
  profiles. Missing credentials must produce a clear not-run result.

Gate: R13 passes; label failures as adapter, contract, configuration or provider
failures rather than hiding them behind successful simulator tests.

## M5 — end-to-end evidence and completion

- [ ] Add executable tests for the full acceptance matrix, with a normal failing
  exit code on invariant violations. Resolve the no-tests baseline (#29).
- [ ] Demonstrate one invoice/receipt → independent approval → bank transfer →
  settlement evidence → journal posting → statement reconciliation.
- [ ] Run the headline lost-response/crash/lost-webhook scenario with a fixed
  seed; preserve the bank datastore when restarting only the application worker.
- [ ] Produce separate simulator, contract and sandbox reports with commit,
  seed, fault schedule, fixture hash and provider/spec version.
- [ ] Update diagrams/docs and operator recovery instructions to match the code.
- [ ] Update the issue and PR with exact commands/results, remaining limitations
  and reviewer request for `srivatsav-kannan`. No runtime checkbox is complete
  solely because the design text or diagram exists.

## Acceptance matrix

| ID | Scenario | Required assertion |
|---|---|---|
| R01 | Same key, same payload; repeated/concurrent request | One provider transfer and same identity returned |
| R02 | Same key, changed amount or beneficiary | Conflict; original transfer unchanged |
| R03 | Same seed/fault schedule, app restart | Reproducible events; bank state persists; agents cannot access controls/oracle |
| R04 | Accepted at bank, response lost, worker killed | New fenced worker resumes original command/key; exactly one transfer |
| R05 | Stale worker completes after lease takeover | Stale update rejected, including same-seat restart |
| R06 | Invalid/stale approval, concurrent credit/bill use | No unauthorized send, over-allocation or partial business writes |
| R07 | Missing/duplicate/out-of-order/early notification | Polling recovers; no state regression or duplicate economic effect |
| R08 | Crash while importing a bank page | Replay safely imports once; cursor never skips uncommitted records |
| R09 | Bank settled, local posting fails | Retry local posting; no additional transfer submission; read-only evidence retrieval remains allowed; at most one cash posting |
| R10 | 401/403, 429, ambiguous 5xx, retry exhaustion | Correct pause/retry/exception; unknown reservations retained |
| R11 | Return observed first or after restart | Original debit and return each posted once; missing evidence blocks reversal |
| R12 | Headline demo plus reconciliation | One transfer, one original debit, one settlement journal effect, one match; unexplained work blocks clean close |
| R13 | Prism and real Increase sandbox slice | Contracts pass and provider evidence corroborates state; missing credentials are not run |

For return scenarios R11/R12 additionally require the distinct return transaction
and compensating entry once. One original debit does not mean ignoring the return.

## Existing commands and new suite requirements

These commands already exist; they are not claims of passing in this handoff:

```sh
npm ci
npm run typecheck
npm test
npx vite build --config console/vite.config.ts
npm run backend
npm run smoke
npm run eval -- --stores 3 --days 14 --seed 7 --chaos 0.3
```

Keep `npm run backend` running separately. Backend-dependent commands require an
isolated Convex deployment, its URL and matching `KERNEL_ADMIN_SECRET` in the
deployment and local environment. Never print or commit those secrets. A live
LLM evaluation needs its own key; deterministic recovery tests should not.

At the reviewed baseline, `npm test` has no committed test files and fails; the
separate smoke suite exists. Add real tests rather than `--passWithNoTests`.
Choose and document new test script names during implementation; local-sim,
contract and sandbox are proposed profiles, not currently runnable commands.

## Relevant existing files

| Area | Existing entry points |
|---|---|
| Payment transitions | `convex/payments.ts`, `convex/ap.ts`, `convex/lib/post.ts` |
| Tasks and state | `convex/tasks.ts`, `convex/schema.ts`, `convex/observe.ts` |
| Worker and handlers | `src/agents/team.ts`, `src/agents/runtime.ts`, `src/agents/handlers/payments.ts`, `src/agents/handlers/cash.ts` |
| Bank and scenarios | `src/world/bank.ts`, `src/world/scenario.ts`, `src/world/emitter.ts`, `src/world/rng.ts` |
| Auth/client and evaluation | `src/core/kernel-client.ts`, `src/human/gateway.ts`, `src/evals/main.ts`, `src/evals/score.ts` |
| UI and smoke tests | `console/src/App.tsx`, `scripts/smoke-kernel.ts`, `scripts/smoke-memory.ts` |

Proposed new modules include `convex/providerOutbox.ts`, `convex/providerInbox.ts`,
`src/integrations/contracts.ts`, banking adapters and dedicated contract/scenario
tests. Adjust locations to the actual implementation, preserving the boundaries.
