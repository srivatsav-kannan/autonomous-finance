# Recoverable accounts-payable demo

Implementation of [issue #39](https://github.com/srivatsav-kannan/autonomous-finance/issues/39): one configured organization/run, one USD account, one activated beneficiary version and outbound ACH credits. Convex owns approvals, reservations, attempts, evidence and the AP journal. The bank owns execution and economic transactions in an independent datastore.

See the [review-fix validation record](ap-demo/review-fixes-validation.md) for the latest regression, browser and recovery checks, and the [original validation record](ap-demo/validation.md) for earlier evidence. External sandbox checks still require credentials.

The [CI guide](ci.md) describes automated PR gates, isolated local recovery, retained evidence and separate optional live validation.

The selected demo uses `src/payments/agents.ts`, `dispatcher.ts` and `evidence.ts`. The legacy agent team and seat runtime no longer receive a bank handle, and the old payment handler no longer submits or unconditionally settles transfers. The old evaluator can still request payments but cannot execute them; money movement uses the dedicated scoped demo path. Demo runs reject the legacy financial mutation/read paths so agents cannot bypass the new permissions through older APIs.

## Reproducible checks

Use Node **24.18.0 or later**. The complete dependency set, including the pinned Prism contract-testing tool, requires this runtime; FakeBank also uses built-in `node:sqlite`. Check the active version before installing the committed lockfile:

```sh
node --version
npm ci
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm test
npm run build:console
```

The focused commands cover the following suites. Running the whole `npm test` suite already includes them; repeat an individual suite when investigating a failure.

| Proof | Executable coverage |
| --- | --- |
| Durable same-key identity, changed-payload conflict, eight concurrent processes, worker exit after accepted/lost response, account boundaries, deterministic clock/fault schedule | `src/integrations/banking/fake.test.ts` |
| Backend role/human authority, immutable approval, stale versions, reservations, cancellation/claim races, attempt fencing and retry budgets | `tests/demo-backend.test.ts` |
| Concurrent dispatcher claims, accepted-but-lost responses, worker/bank-handle restarts and crashes before local completion | `tests/demo-dispatcher.test.ts` |
| Role-specific evidence views, late exceptions, outstanding approvals, clean-close guards and returns after period close | `tests/demo-final-review.test.ts` |
| Missing/duplicate/reordered/early notifications, return-first ordering, consumed credits, cursor rollback/replay, concurrent cash posting, failed local posting retry, unknown activity blockers | `tests/demo-reconciliation.test.ts` |
| Provider payloads, original saved request/key retry, account ownership, posted settlement/return evidence, signatures, configuration and normalized errors | `src/integrations/banking/increase.test.ts` |
| Real Prism HTTP request/response validation with the pinned OpenAPI subset, including deliberately invalid contracts | `src/integrations/banking/increase-prism.test.ts` |

Unit/integration tests use actual Convex function handlers through `convex-test`; they do not require a deployed Convex service, an LLM key or Increase credentials. FakeBank contention tests spawn independent Node processes using the same SQLite file. The local demo below additionally uses a real local Convex deployment and separate application worker processes. Prism fixtures are hand-authored provider-shaped examples. None of these results is a live Increase result.

The development-only Prism dependency has a documented unresolved Faker advisory; production dependencies audit clean. See the [contract toolchain audit](../src/integrations/fixtures/increase/README.md#development-dependency-audit) for the exact dependency chain, supported overrides and reproducible audit commands.

## Local recovery demonstration

Use an isolated checkout and local Convex deployment. In one terminal, start the backend and leave it running:

```sh
npm run backend
```

On a fresh checkout, the first deployment may stop with an auth-configuration error because `AP_HUMAN_AUTH_ISSUER` and `AP_HUMAN_AUTH_AUDIENCE` have not been set. The local backend process remains running. After it creates the local deployment and `.env.local`, set these simulator-only placeholders from a second terminal in the same checkout:

```sh
npx convex env set AP_HUMAN_AUTH_ISSUER https://ap-demo.invalid
npx convex env set AP_HUMAN_AUTH_AUDIENCE ap-demo
```

These commands use the anonymous local deployment selected by this checkout's `.env.local`; do not add `--deployment local` for this bootstrap. The running dev process should retry the deployment after the environment change. Restart `npm run backend` if necessary, and wait for successful function deployment before continuing:

```sh
npm run demo:local
```

The placeholder issuer does not issue real JWTs. It enables the local authentication configuration while the trusted coordinator explicitly supplies the simulator identity `https://ap-demo.invalid|local-human-fixture` through local administrator authentication. Never use these placeholders to claim real human authentication.

The coordinator reads the local deployment configuration, provisions distinct demo service credentials, creates a fresh run and records a seeded invoice through the AP agent handle. The controller accepts the bill and the payments agent requests payment. The final approval uses an explicitly simulated human identity supplied through local Convex administrator authentication. The report labels this `local_admin_simulated_human`; it is not evidence of a real human JWT or a live human review. Production approval requires the separately authenticated JWT path described below.

The coordinator then performs the headline failure scenario:

1. Persist the exact approved command and its stable provider key in Convex.
2. Let FakeBank commit acceptance, lose the response, and exit the dispatcher process before it can record completion.
3. Keep both the SQLite bank file and Convex state intact. Wait about 31 seconds for the recorded lease to expire.
   The coordinator waits at least `--lease-wait-seconds` (default and minimum 31) and also until the killed worker's recorded `leaseExpiresAt` has passed.
4. Start another dispatcher process. It reuses the saved command/key and receives the existing transfer.
   The coordinator then replays the lost request with the same key and bytes and records that the bank returned the original transfer.
5. Settle the bank transfer, drop its notifications, and recover the posted debit by polling.
6. Post one cash journal effect, link the bank transaction to it, and rerun reconciliation to assert no duplicate.
7. Collect the controller and simulated-human signatures and verify that each demo period closes.

The command exits unsuccessfully when an invariant fails. A successful run prints the path to `var/ap-demo/<run-id>/report.json` and the command, provider transaction and journal IDs. The report contains the Git commit, seed, fixture hash, provider contract/specification pin, fault schedule, identity mode and linked evidence. Its independent bank state is retained at `var/ap-demo/<run-id>/bank.sqlite`. The bank and report are runtime artifacts ignored by Git. A second ordinary invocation creates a fresh run; an explicit reused `AP_RUN_ID` is rejected rather than replaying historical financial rows.

Detailed provider storage and fault controls are documented in [fake-bank.md](ap-demo/fake-bank.md).

### Browser approval with a local OIDC test identity

In an isolated local checkout with `npm run backend` running, start
`npx tsx scripts/testing/ap-browser-fixture.ts` and `npm run console` in separate
terminals. The fixture binds a temporary OIDC issuer to loopback, configures this
local deployment, rejects wrong-audience and expired tokens, and prints a path to
an ignored `browser-session.json`. Open `/ap-demo`, enter that file's scope and
test JWT, review the $100 payment, and approve it. The fixture then dispatches to
FakeBank, drops notifications, polls and posts once, and verifies both close
signatures. Refresh the UI to see `settled / posted / matched` and zero blockers.
The issuer remains running for this final refresh; stop it afterward to remove
the test token file. It changes the isolated deployment's demo service/auth
configuration, so do not share that deployment with other work. Restore your
issuer/audience before testing a different identity provider.

This exercises the browser and the backend's real JWT signature/claim validation
with a synthetic `local_oidc_test_identity`. It does not establish a production
identity, call Increase or demonstrate an external provider login.

### Browser approval, then crash recovery (one flow for judges)

The fixture above dispatches cleanly; `npm run demo:local` approves with a simulated
admin identity. To show both in one run, a human approves in the browser and then
watches the same crash and recovery as `demo:local`:

```sh
npm run backend      # terminal 1, leave running
npm run console      # terminal 2, http://localhost:5173/ap-demo
npm run demo:local -- --browser-approval      # terminal 3
```

1. The coordinator starts the same loopback OIDC test issuer as the fixture, binds this
   local deployment to it, and checks that wrong-audience and expired tokens are rejected.
2. It seeds the invoice and payment request, then prints `status: "awaiting_browser_approval"`
   with the path to `var/ap-demo/<run-id>/browser-session.json` (mode 0600).
3. Open `/ap-demo`, paste that file's `scope` and `jwt`, tick **Reload this view every 3
   seconds**, review the payment and approve it. The coordinator waits up to 10 minutes.
4. The coordinator runs the `demo:local` scenario on that approved command: the bank
   accepts, the response is lost and the dispatcher process is SIGKILLed before it records
   completion. The console shows `in_flight / unposted` with one attempt. Operator health
   shows one attempted payment with no confirmed transfer, and critical `dispatcher_not_reporting`
   and `evidence_not_reporting` alerts because no worker has completed a pass yet.
5. After the lease expires (about 31 seconds; the terminal counts down), a new dispatcher
   reuses the saved command and key and gets the original transfer back. The coordinator
   then settles it, drops the notifications, polls, posts once, and gets both close signatures.
6. It asserts the same invariants as `demo:local`: exactly one bank transfer, one posted
   debit and one journal entry for the payment, zero blockers. The report adds
   `approval: "browser_local_oidc"` and `identityMode: "local_oidc_test_identity"`.
   The console then shows `settled / posted / matched` and a healthy operator view. No
   worker keeps running after the demo, so about a minute later Operator health reports
   `dispatcher_stale` and `evidence_stale`: the stale-heartbeat alert doing its job.

The issuer stays up so the browser can refresh; press Ctrl-C to stop it, which also
deletes `browser-session.json`. Like the fixture, this rebinds the local deployment's demo
service secrets and human issuer (to a loopback port that stops with the process), so do
not share that deployment with other AP work. A later plain `npm run demo:local` still
works because it uses local admin authentication.

`--lease-wait-seconds <n>` (31 to 600) makes the pause before recovery longer, for example
to narrate. It cannot be shorter: the dispatcher lease is a 30-second backend constant
(`LEASE_MS` in `convex/lib/payments/applyEffect.ts`) shared with real dispatch, and a
restarted dispatcher cannot claim the command until it expires. The demo does not change it.

## Increase sandbox prerequisites and execution

Use a dedicated sandbox account with one eligible external ACH destination and adequate sandbox funding. The adapter fixes its host to `https://sandbox.increase.com`; it cannot be switched to a live host through an agent-supplied URL. The trusted harness alone can submit, settle or return a sandbox transfer, and it fetches the transfer first to verify account ownership.

Set these values in the trusted coordinator environment or an uncommitted environment file:

| Variable | Required value |
| --- | --- |
| `CONVEX_URL` | The isolated Convex deployment URL |
| `KERNEL_ADMIN_SECRET` | Trusted setup secret; also configured on that deployment |
| `AP_DISPATCH_SECRET` | Dispatcher-only secret, distinct from admin/evidence credentials |
| `AP_EVIDENCE_SECRET` | Evidence-ingestion/posting-only secret, distinct from admin/dispatcher credentials |
| `AP_HUMAN_JWT` | Valid human JWT from the configured issuer, for the configured audience |
| `AP_HUMAN_SUBJECT` | Exact Convex identity token identifier, `issuer|subject` |
| `INCREASE_SANDBOX_API_KEY` | Sandbox API key held only by the trusted adapter/harness |
| `INCREASE_SANDBOX_ACCOUNT_ID` | The one authorized Increase account |
| `INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID` | The one activated beneficiary reference |
| `INCREASE_SANDBOX_WEBHOOK_SECRET` | Required when verifying live signed webhook requests; polling can run without it |
| `AP_ORGANIZATION_ID`, `AP_RUN_ID` | Required explicit organization/new-run identity for the sandbox profile |
| `AP_SANDBOX_FUNDING` | JSON array of explicitly reviewed sandbox capital wires, each with `transactionId` and positive `amountCents` |
| `AP_BANK_SCOPE` | JSON scope binding shared by the Convex deployment and service workers, matching those identities, `increase`/`sandbox` and the authorized account |

For a fresh sandbox-backed deployment, configure real `AP_HUMAN_AUTH_ISSUER` and `AP_HUMAN_AUTH_AUDIENCE` values on the Convex deployment before its function deployment can succeed, then deploy `convex/auth.config.ts`. Replace any local simulator placeholders before using a real human JWT. The issuer must support the normal Convex JWT verification flow. Setup binds `AP_HUMAN_SUBJECT` to the active human CFO seat. Agent seat tokens, bank credentials and the dispatcher/evidence service secrets cannot substitute for that identity.

Fund the dedicated account using inbound wire simulations and review their posted
transaction IDs and amounts. For example, `AP_SANDBOX_FUNDING='[{"transactionId":"transaction_example","amountCents":100000}]'`
selects a $1,000 contribution of sandbox demo capital. The runner fetches each
exact transaction from the configured bank account and rejects a different amount
or source. The human JWT then approves its classification as cash / stockholders'
equity through `demoEvidence.approveSandboxFunding`. Each wire has its own journal
entry and audit record; it is not hidden from the statement. This helper is only
for reviewed sandbox capital contributions, not arbitrary income or loan receipts.

The run's own statement window is imported in full. Unselected wires, unrelated
collections and other unexplained activity created during the run remain close
blockers. The completion assertion
requires one debit for the approved payable, all selected funding accounted for,
zero blockers and both close signatures, rather than one transaction in the entire
account. The runner opens the selected funding periods as well as the invoice and
payment periods. Use a fresh run after deploying these pre-merge schema/identity
changes; historical records are not silently relabeled.

### Reusing a sandbox account ([#74](https://github.com/srivatsav-kannan/autonomous-finance/issues/74))

Use a fresh run, not a fresh account. `demo:sandbox` configures each run with
`activitySince`, the run's start time, stored with its demo configuration
(`demoPayments.configure`). The evidence worker asks Increase only for
transactions created on or after it (`created_at.on_or_after`), so polling no
longer rescans the whole account history. As a safety net the backend classifies
every imported row: unlinked activity created before `activitySince` (for
example the previous run's debit, which this run cannot match to any of its
commands) is stored as `prior_activity`. It stays visible in `humanView`, is
never re-observed or posted by this run, and does not block close. Anything
linked to one of this run's commands is kept regardless of timestamps, so clock
skew cannot hide this run's own debit (it is also fetched through its transfer).
Unexplained activity created after `activitySince` still blocks close.
Explicitly selected `AP_SANDBOX_FUNDING` wires usually predate the run; they are
imported and approved as before. Limitation: a late return for an earlier run's
transfer that arrives after the new run starts is unmatched in the new run and
blocks close; settle earlier runs before starting the next one.

### Isolating a bad bank transaction ([#75](https://github.com/srivatsav-kannan/autonomous-finance/issues/75))

Each listed transaction is verified on its own, with at most five transfer
lookups in flight. After a rate limit no new lookups start on that page. Rows
that fail (rate limit, a mismatch with their transfer, or a debit posted before
its transfer has `settlement`) are returned as failures. The page import records
them in `demoEvidenceRetries` in the same mutation that advances the cursor, so
the cursor never passes an unrecorded row. Open retries are retried with
exponential backoff (1 s doubling to 15 minutes, or the provider's
`Retry-After` if longer), stay close blockers until the exact transaction is
imported, and are reported as quarantined after five attempts. A failed listing
leaves the cursor untouched while notices, observations and posting for
everything else in the tick still run. Nothing is posted without the full,
validated evidence.

Signed notifications whose direct resource is verified to belong to another
account receive an audited terminal disposition. Failed fetches, wrong resource
identities and contradictory nested links remain unresolved. Valid unrelated ACH
collections are retained as `other` evidence without preventing the payable on
the same statement page from being posted.

Configure the same three distinct service/setup secrets on the selected isolated Convex deployment. The CLI accepts secret values through stdin or an interactive prompt, avoiding a literal secret in shell history:

```sh
npx convex env set KERNEL_ADMIN_SECRET
npx convex env set AP_DISPATCH_SECRET
npx convex env set AP_EVIDENCE_SECRET
npx convex env set AP_HUMAN_AUTH_ISSUER
npx convex env set AP_HUMAN_AUTH_AUDIENCE
npx convex env set AP_BANK_SCOPE
```

Select the intended isolated deployment explicitly when using the CLI. Set `AP_BANK_SCOPE` to the exact JSON object below, with your configured identifiers; the backend rejects even a valid service secret when its requested scope differs from this deployment binding:

```json
{"organizationId":"your-demo-organization","runId":"your-new-demo-run","provider":"increase","environment":"sandbox","accountId":"your-sandbox-account-id"}
```

Use the same organization and run in `AP_ORGANIZATION_ID` and `AP_RUN_ID`, and the same account in `INCREASE_SANDBOX_ACCOUNT_ID`. Changing these requires updating the backend binding before starting the fresh run. The local demo provisions its own `fake`/`local` binding automatically. Then run:

```sh
npm run demo:sandbox
```

Missing prerequisites print a structured `status: "not_run"` report listing missing variable names and exit with code 2. This is a blocked sandbox check, not a pass. Live sandbox execution is currently **NOT_RUN** because sandbox credentials and a real human JWT are unavailable; external webhook delivery has not been exercised. With prerequisites present, the script executes the same application approval/outbox/dispatcher/evidence path, uses the separate sandbox simulation harness to advance the ACH transfer, and polls for actual posted Transaction evidence. A passing local or Prism test does not change this status.

The adapter sends the original saved provider request bytes and original `Idempotency-Key` on every retry. It does not generate a replacement key, invent a key expiry, or switch providers after an ambiguous response. ACH raw `submitted` status alone is insufficient: normalized settlement requires `settlement.settled_at` and a fetched, account-verified posted debit; a return requires the distinct return transaction and original debit.

The pinned schema subset and example fixtures are in `src/integrations/fixtures/increase/`. `provenance.json` records the upstream URL/version/hash, subset hash, fixture hash and transformation. The offline pinning script is `scripts/testing/pin-increase-spec.mjs`. Updating provider assumptions requires reviewing the pin and rerunning both adapter and Prism checks.

## Trust boundaries and permissions

The AP agent can record invoices, attach evidence and flag discrepancies. It cannot approve or pay. The payments agent can request payment and read status; it cannot submit a transfer. Controller policy approval does not replace final human approval. Treasury/FP&A receive scoped aggregates, the auditor receives read access, and integrations diagnostics do not include service credentials. Backend mutations authenticate roles and full organization/run/provider/environment/account scope; narrow agent wrappers are an additional convenience, not the authorization boundary.

Human approval records the canonical version hash fixing the bill set, per-bill amounts, applied credits, net USD amount, beneficiary version and policy version. Reservation and immutable command creation commit with approval. An unsent material change cancels the old command atomically and requires new approval; once an attempt may have started, reservations cannot be released based on a timeout or an empty lookup.

Only the dispatcher is given the bank submission capability. The evidence worker receives read-only bank methods. Simulator controls and evaluator inspection remain in test/harness modules. JavaScript interfaces do not isolate a hostile process: deploy operating-agent processes without bank/service/admin secrets, the human JWT, bank filesystem access, or executable access to the trusted harness. Use separate OS identities/containers and restrictive parent-directory permissions. The local demo coordinator is a trusted harness process that intentionally holds these setup capabilities; it does not give them to its agent handles.

Signed ingress verifies raw bytes before durable notification ingestion. A notice only identifies a resource to fetch; it never authorizes posting. The production service entrypoint `scripts/ap-worker.ts` provides the dispatcher and evidence workers:

```sh
npm run worker:dispatch
npm run worker:evidence
```

Supply `CONVEX_URL`, the exact `AP_BANK_SCOPE`, and only that worker's appropriate service secret. Increase workers also require `INCREASE_SANDBOX_API_KEY`; the evidence worker needs `INCREASE_SANDBOX_WEBHOOK_SECRET` for signed ingress. A FakeBank worker instead requires an existing `AP_FAKE_BANK_PATH` and matching `AP_SEED` (default 7); it never creates or resets bank state. Workers deliberately do not load the coordinator's environment files automatically. Use `-- --once` for a single dispatch/reconciliation pass.

To enable the evidence worker's HTTP endpoint, set `AP_WEBHOOK_PORT` to the listening port. It binds to `127.0.0.1` by default; `AP_WEBHOOK_HOST` optionally changes that address. Send notifications to `POST /webhooks/bank`. The server reads the original bytes, enforces a 1 MiB body limit, verifies the provider signature and acknowledges with HTTP 204 only after durable ingestion commits. Signature or ingestion failures return HTTP 400. Deploy this listener behind the appropriate HTTPS ingress before configuring an Increase subscription.

Live webhook delivery has not been demonstrated merely by enabling this endpoint. The adapter and integration suites test signature verification and durable ingestion locally; successful external delivery requires a separately recorded sandbox check. Polling remains the recovery path for missing deliveries. Keep webhook event deduplication separate from economic transaction deduplication.

## Recovery and operator work

Inspect `demoPayments.humanReview` and `demoEvidence.humanView` using the authenticated human client. They expose command execution/posting/reconciliation states, attempts, next retry, error details, transaction evidence and close blockers. Operator resume requires the original command ID and a human-supplied reason; it is audited and preserves the original approved request/key/provider.

| Condition | Action |
| --- | --- |
| Rate limit | Persist the retry deadline, honor `Retry-After` and reuse the original command/key |
| Ambiguous transport, lost response or worker exit | Retain reservations; resume the fenced attempt using the saved request |
| Authentication/configuration failure | Pause automatic execution in exception state; repair credentials/configuration before human resume |
| Idempotency conflict | Quarantine and inspect saved payload evidence; never create a fresh key to work around it |
| Bank settled, local posting failed | Repair the local invariant and retry evidence posting only; do not dispatch again |
| Return | Fetch and post the original debit and separate return once each; applied credits remain consumed |
| Unknown transfer, unmatched transaction, missing evidence or unresolved returned obligation | Retain a close blocker until explicitly resolved |
| Worker died after claim, before send; `exception` with no provider transfer | After the 24-hour safety window, `npm run ops:release-unsent -- <commandId> "<reason>"` re-checks the provider and asks for the audited human release ([details](payment-refactor/RECOVERY.md#releasing-a-command-that-was-claimed-but-never-sent-76)) |

### Operator health and runbooks ([#56](https://github.com/srivatsav-kannan/autonomous-finance/issues/56))

A running process is not the same as a worker making progress. Each dispatcher
and evidence pass reports its outcome to `demoOps.recordDispatcherPass` /
`recordEvidencePass` with its own service secret (outcome and an allowlisted
error class only). `demoOps.operatorHealth` (human JWT, scoped to the configured
organization/run/provider/environment/account) returns:

- last pass and last successful pass per worker, and consecutive failed passes;
- oldest eligible command wait, unknown-outcome count and age, retry-exhausted
  count, exception classes, bank-settled-but-locally-unposted payments and late
  transfers after a release;
- oldest imported-unposted transaction age, open fetch retries (and quarantined
  ones), unprocessed notifications, and polling cursor progress (last import and
  last completed scan);
- `alerts`, each with the operator action, and a `status` of healthy, degraded
  or unhealthy.

Ages are computed from Convex server wall-clock timestamps (`clock:
"server_wall_clock"`): attempt, retry, import, receipt and pass times. Bank or
fixture business dates (FakeBank's virtual clock, `postedAt`) never feed health.
Reads use the `by_run_execution`, `by_run_state`, `by_run_open` and
`by_run_processed` indexes and are capped at 200 rows per state (reported as
`capped`). The view returns counts, ages, row IDs and error classes only: no
commands, idempotency keys, saved requests, lease tokens or provider messages.

| Alert | Operator action |
| --- | --- |
| `dispatcher_stale`, `evidence_stale`, `*_not_reporting` | Restore worker connectivity: the process is running, reaches `CONVEX_URL` and uses this run's `AP_BANK_SCOPE`; restart `npm run worker:dispatch` / `worker:evidence` |
| `*_failing` with `authentication` or `configuration` | Repair credentials or configuration (service secret, `AP_BANK_SCOPE`, provider API key) |
| `*_failing` otherwise | Restore connectivity to Convex and the bank; the worker retries |
| `dispatch_backlog` | Confirm the dispatcher is passing; work is claimed in order with the original request and key |
| `unknown_outcome` | Keep reservations; the dispatcher reconciles by operation-key lookup; for an `exception`, inspect `humanReview` and use the audited resume |
| `retry_exhausted`, `quarantined_command` | Inspect the quarantined command and saved request; confirm the outcome with the provider using the original key; repair the cause, then audited resume |
| `bank_settled_local_posting_failed` | Reconcile evidence: repair the local invariant (for example reopen the period) and let the evidence worker retry posting; do not dispatch again |
| `evidence_fetch_retrying`, `evidence_unposted`, `notification_backlog` | Restore provider connectivity or wait out rate limits; inspect rows in `humanView`; unexplained activity stays a close blocker |
| `released_payment_transfer_appeared` | Escalate as a possible duplicate payment; it is never posted automatically |

Every alert also carries the rule it must not break: never generate a new
provider key, resend a transfer, or free a reservation just to clear a warning.

The `/ap-demo` console shows this view read-only under **Operator health**, loaded
with the payment review for the authenticated human. It lists the status, each alert
with its runbook action, and every signal above next to its target with whether it is
within target. It has no buttons: recovery stays in the audited actions under
**Dispatch and recovery**. If the query fails, the panel says so and the rest of the
review still loads. The panel's rules are in `console/src/operatorHealthView.ts` and
are tested against the real query in `tests/ap-demo-console-health.test.tsx`.

Proposed SLO thresholds (`SLO_TARGETS` in `convex/demoOps.ts`) are **targets,
not measurements**: a worker pass within 60 s, fewer than 3 consecutive failed
passes, eligible commands claimed within 5 minutes, unknown outcomes, unposted
transactions and unprocessed notices resolved within 15 minutes, and quarantine
after 5 failed fetches. The configured mechanics they derive from are a 1 s
service loop, 10 s heartbeat, 30 s lease and an 8-attempt / 24-hour automatic
recovery budget. No baseline has been measured on a deployed backend yet;
`convex-test` timings are not representative and are not reported as SLIs.
The console prints the same label (`target_not_measured`) beside the thresholds.

| Target (not measured) | Value | Derived from |
| --- | --- | --- |
| Worker pass age | 60 s | 1 s service loop |
| Consecutive failed passes | fewer than 3 | |
| Eligible command wait | 5 minutes | 30 s lease, 10 s heartbeat |
| Unknown outcome, unposted transaction, unprocessed notice | 15 minutes | |
| Quarantine | after 5 failed fetches | exponential fetch backoff |

Historical application payments are not automatically migrated into this flow. Activation requires a fresh run without existing bills, payment intents or journal entries. Resolve old submitted/unknown outcomes through their original provider before considering a separately approved replacement. Preserve both bank and application state during recovery exercises; resetting either can erase the ambiguity the demo is intended to test.

## Deliberate limits

This is a principal-only USD outbound ACH slice. It has no fees, FX, tax allocation, incoming payments, additional accounts, arbitrary beneficiaries or ERP integration. The local human identity is a fixture. Real JWT approval, live Increase acceptance/settlement/return and live webhook delivery must be reported separately from simulator and contract results. The broader agent/world/evaluation remains a separate profile without bank submission capability; use this dedicated flow to execute payments.
