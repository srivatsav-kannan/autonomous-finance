# AP recovery CI

Implements [#55](https://github.com/srivatsav-kannan/autonomous-finance/issues/55)
for milestone #39, stacked on [PR50](https://github.com/srivatsav-kannan/autonomous-finance/pull/50)
(`codex/ap-demo-increase`, after #47 and #49). While PR50 is open, CI changes target
that branch. [Issue #59](https://github.com/srivatsav-kannan/autonomous-finance/issues/59)
extends the persistent proof to lookup recovery after an externally killed worker.
Its coordinator owns shared workflow/package wiring. Branch protection and merging
the stack remain repository-admin decisions. Datadog is deferred.

## Pull request gates

`.github/workflows/ap-ci.yml` runs for all pull requests, pushes to `main` and
`codex/**`, and explicit workflow dispatch. Superseded runs for the same PR/ref
are cancelled. It uses GitHub-hosted Ubuntu 24.04, Node 24.18.0, SHA-pinned
actions, `contents: read`, no persisted checkout credentials, no application
secrets and no dependency/state cache. It never uses `pull_request_target`.
PR runs validate GitHub's merge commit; the exact checked-out revision is in
each artifact. Fork PRs may need a maintainer's normal Actions approval.

The regression job runs `npm ci`, all three application/backend/test typechecks,
`npm test` once, and `npm run build:console`. The full test command includes
multiprocess SQLite FakeBank, dispatcher/reconciliation, and real Prism HTTP
contract tests. Focused `test:bank`, `test:payments` and `test:contracts` commands
are debugging tools, not additional CI passes. No audit gate is claimed by
`npm ci --no-audit`; the existing development-dependency advisory remains
documented in the [AP guide](ap-demo.md).

`ap-regression-<run>-<attempt>/checks.json` records each step as `PASSED`, `FAILED`,
`CANCELLED` or `NOT_RUN`, plus code revision, tracked-change flag and Node/OS/CPU
runtime. A skipped build or missing test result cannot become a passing check.

## Persistent local recovery gate

The separate ten-minute job installs the lockfile in its own fresh runner and
runs `npm run ci:recovery`. The runner has a six-minute internal deadline, a
seven-minute workflow step deadline, bounded startup/deploy/demo waits and
process-group cleanup. It uses Convex CLI from the lockfile and backend
`precompiled-2026-10-10-72ce13c`; update that pin deliberately when upgrading.
The first run needs network access to download that public backend binary.

The runner copies source inputs into a new private OS temporary directory outside
the checkout (so concurrent tests cannot rediscover the copied test suites),
starts an anonymous local Convex backend, and supplies only fixture auth
configuration. It never copies `.env*`, `.convex`, an existing bank file or
runtime data. Subprocesses receive a minimal environment without deploy keys,
bank credentials, human JWTs, service tokens or `NODE_OPTIONS`. The CLI can
reuse old global state, so the runner refuses a user with
`~/.convex/config.json` or
`~/.convex/anonymous-convex-backend-state/anonymous-agent`; use a fresh disposable
OS user/VM instead of removing or reusing someone else's state. Its normal
global binary cache may be reused. Anonymous project state is local to the
temporary directory. Two distinct free loopback ports are selected and explicitly
passed to the pinned CLI, so another local browser/backend job can use its own
ports. A bind failure fails the job; cleanup never stops another job's backend.

The existing `demo:local` harness performs the actual acceptance/lost-response
fault and pauses the dispatcher inside the bank call after acceptance. The parent
checks the persisted bank transfer and Convex's still-in-flight, unposted command
with no recorded provider response, unpaid bills and no transaction evidence.
It then sends **SIGKILL**, requires the actual signal termination (a normal exit
does not count), preserves both databases, waits for the 30-second lease, and
starts a new dispatcher. Each child has a 30-second deadline. The new worker
must emit a lookup checkpoint with the same canonical full-command fingerprint,
including the original operation key and exact saved request bytes. It drops notifications, polls
posted bank evidence, and asserts a second reconciliation pass posts nothing.
The CI runner then independently checks the report and fresh backend journal:

- One command and two leased attempts, with one bank create call and at least one
  persisted operation-key lookup after restart. The saved command, request hash
  and idempotency key match the single resulting transfer; recovery finds the
  accepted transfer without submitting again.
- One posted debit and one linked cash journal entry for the approved amount.
- Settled/posted/matched state, no close blockers and no ingested webhook rows.
- A parent-verified SIGKILL checkpoint before local completion, matching frozen
  command fingerprints at acceptance and lookup, and unpaid state until settlement.

`ap-recovery-<run>-<attempt>/recovery.json` contains the revision, runtime, backend
version, scenario, status/failure stage, counts and hashed identifiers. Both artifacts
expire after 14 days; download them for longer retention. Upload paths name
these two files explicitly. Diagnostics are embedded in `recovery.json`; no new
artifact path or workflow permission is needed. The collector scans at most
256 KiB per source, buffers at most 4 KiB of an incomplete line, and retains at
most 32 distinct diagnostic events per source. It exports fixed categories
such as `INVALID_MODULE_PATH`, `MODULE_NOT_FOUND`, `BUILD_FAILED`,
`AUTH_CONFIGURATION` and `ASSERTION_FAILED`, plus exact repository-known source
paths/line numbers and child exit/signal metadata. Unknown messages are discarded;
truncation is explicit. No raw error text or source excerpts are retained.
Raw backend/demo output is consumed without being printed or persisted because
it can contain generated credentials. No complete
demo reports, bank databases, `.env`/`.convex` files, worker configs, seat tokens,
admin credentials, provider payloads or environment dumps are uploaded. The
temporary project and its generated secrets are removed after the owned
processes stop. Runner termination may prevent final cleanup/upload; the hosted
VM is disposable and an absent artifact is not proof of success.

To reproduce on a clean POSIX checkout with Node >=24.18.0 and an unconfigured
Convex user:

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm test
npm run build:console
npm run ci:recovery
cat var/ci/recovery.json
```

For a failed recovery run, the retained `stage` distinguishes isolation,
backend startup/download, function deployment, crash/recovery, evidence checking
and cleanup. Inspect `diagnostics.processes[].events` for classified build errors
and source locations. Missing/failed/incomplete subprocesses fail the gate;
timeouts become `TIMED_OUT`, cancellation becomes `CANCELLED`, and both exit
nonzero. Success received after a deadline is rejected. A fresh `FAILED` record
is written before metadata/setup so an early error cannot leave an older pass.
Fix runtime/network access for startup failures. For deeper
diagnosis use a disposable checkout and follow the interactive
[local recovery demonstration](ap-demo.md#local-recovery-demonstration);
inspect raw logs/state privately, never attach them to CI or a PR. Do not
convert a failed or blocked recovery run into a successful skipped check.

## Separate optional validation

Every CI artifact explicitly records live Increase, real JWT authentication
and external webhook delivery as `NOT_RUN`. The local human identity is
`local_admin_simulated_human`; Prism validates fixtures and HTTP contracts.
Neither is evidence of live provider execution or real identity verification.

Live sandbox checks are **manual opt-in only**, outside PR CI. An authorized
operator must use a separate isolated sandbox deployment and the prerequisites
and `npm run demo:sandbox` procedure in the
[AP guide](ap-demo.md#increase-sandbox-prerequisites-and-execution). Missing
credentials produce structured `not_run` and exit 2, never success; do not use
`|| true`, fake secrets or `continue-on-error` to turn that into a pass. Record
the exact revision/runtime, individual executed scenarios and sanitized
evidence separately. `demo:sandbox` acceptance/settlement alone does not prove
returns or external webhook delivery: leave each unexecuted check `NOT_RUN`.
No live bank operation is part of these workflows.
