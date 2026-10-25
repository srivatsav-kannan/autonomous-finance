# Shared agent worker recovery and drain contract

The shared `Team` runtime retries control-plane transport failures without rerunning a business handler as part of an RPC retry. This applies to all staffed roles. It does not change the separate AP dispatcher/evidence workers or add a payment execution path.

## Recovery

Each control-plane call gets three attempts by default. Backoff uses exponential half-to-full jitter (initial cap 100 ms, maximum cap 1 second). Each attempt has a 5-second deadline; the worker's HTTP transport also aborts stalled requests after 5 seconds, including response-body reads. Tests can override the call policy through `Team`'s `retry` options. Attempts must be finite and between 1 and 10.

Network/socket timeouts, connection failures, HTTP 408/429 and HTTP 500/502/503/504 are transient. An exhausted call leaves the worker degraded and the polling loop tries again on a later round. A failing seat does not prevent other seats from processing work; a seat-list or staffing outage uses the last known seats. Authentication failures, unexpected application errors, missing functions, and other nontransient RPC failures raise `OperatorActionRequired`. The CLI exits nonzero so an operator can repair deployment/configuration/credentials instead of getting an endless retry loop.

A claim, completion, failure report, human wait, telemetry record, or automatic seat spawn has a request ID. The kernel authenticates first, then stores and replays successful responses through the existing idempotency table. Reusing an ID with different arguments fails. Tokens are excluded from the recorded payload hash. Empty claims do not accumulate polling records. Callers without request IDs retain the existing lease checks. New requests still require the current lease owner and attempt; replaying a committed transition never changes a newer lease. Automatic staffing saves the credential before sending its idempotent spawn request.

After a handler returns, only its chosen transition is retried. An uncertain completion is never converted into `failTask`. If all transition responses are lost, the task's durable state determines what happens next: completed work stays done, and an uncommitted transition leaves a lease that can expire and be reclaimed. Business handlers must retain their existing idempotency guarantees for crash/lease recovery; this is not an exactly-once guarantee for external effects.

The worker emits JSON diagnostics on stderr: `degraded`, `recovered`, and `operator_action_required`. If telemetry exhausts its retry budget after a transition, `telemetry_fallback` retains run/seat/task/request identifiers, outcome, usage, and timing. It omits tokens, raw exception/HTTP bodies, and free-form summaries. Collect stderr in the process supervisor. This fallback is not a durable telemetry uploader: records are not automatically imported back into Convex, and remote usage totals can be incomplete during an outage. Lost telemetry never reopens completed work.

## Drain and evaluation

`tasks.drainState` generalizes the payment-specific retry check proposed in PR #48. It examines all queued and leased tasks in a run, including queued work with a future `notBefore` and the next lease expiry. It reports unstaffed executable work separately. Waiting tasks requiring human action and terminal `done`/`failed` tasks are excluded.

`runUntilIdle({ timeoutMs, idleRounds })` resolves only after empty claim rounds are confirmed by this query. It waits for the next due time, rechecking at least once a second so new work and renewed leases are visible. An empty claim that only terminalizes an exhausted lease cannot hide other queued work. The default deadline is 300,000 ms for the whole drain, including transport outages and in-flight handlers. The runtime throws `DrainIncomplete` with reason `timed_out`, `stopped`, or `unstaffed` instead of reporting success. Deadline expiry stops further scheduling on that Team instance.

```sh
npm run agents -- --run RUN_ID --drain --drain-timeout-ms 300000
npm run eval -- --seed 7 --drain-timeout-ms 300000
```

The evaluator only advances to the next simulated day or scoring after a successful drain. Incomplete drains and operator errors produce a nonzero exit. Terminal failed tasks and human waits are still evaluated by the existing scorer; a successful drain means no remaining executable work, not that every task succeeded.

## Shutdown

Both agent and evaluation entrypoints handle SIGINT and SIGTERM. The first signal immediately disables new claims and wakes polling/backoff/retry waits. A claim already sent may commit; if shutdown is observed before the handler starts, that task is left for lease recovery. Handlers already running may finish and report their original transition. The CLI grants them at most 30 seconds; the deadline or a second signal exits with 130 (SIGINT) or 143 (SIGTERM).

`Team.stop()` is cooperative: JavaScript cannot forcibly cancel an arbitrary handler. Library callers must enforce a process boundary if their handlers can hang. A drain deadline rejects immediately and stops new scheduling, but an already-running handler can still finish; the CLI/evaluator exit nonzero on this error. Lease fencing and handler idempotency remain necessary after process termination.

## Integration and verification

- Deploy the updated kernel functions together with the worker. Request IDs are optional for old callers, but the new worker needs the new validators and `tasks.drainState`. No schema migration is required.
- PR #48 overlaps `src/agents/team.ts` and `convex/tasks.ts`. Retain its startup `enqueueRecovery` hook and payment handler changes. Use this all-role drain query instead of keeping a second payment-only wait loop. Payment send/receipt/settlement behavior is outside this PR.
- PR #51 overlaps task transitions. Its deferred tasks already use `queued` plus `notBefore`, so this query covers them. Route `deferTask` through the same idempotent transition protocol on integration, and retain a monotonically increasing lease generation; decrementing the fencing attempt must not be reintroduced. This PR neither adds AR nor changes deferral semantics on main.
- Offline regression tests use actual mutation/query handlers through `kernelHarness`, with before/after-commit transport fault injection, fake clocks, and a real Convex HTTP client against a mocked fetch. They verify polling recovery, unchanged handler counts, response replay, all-role due times, expired leases, deadlines, operator failures, and signal grace periods.
- These tests do not deploy Convex, call a real bank/model, or establish live provider recovery. The separate AP workers remain outside this change.
