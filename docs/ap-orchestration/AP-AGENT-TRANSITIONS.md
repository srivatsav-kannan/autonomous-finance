# Retained AP agent transition evidence

Continuation of #97 / #108, based on PR #109 (`6438103`). The deterministic case worker now saves the state it observed before and after each committed claim, advancement, ownership handoff, escalation, pause and resume. The evidence is available through the existing scoped case-detail API at `timeline[].agentTransition`.

Each versioned record includes a stable operation ID, the authenticated actor on the timeline event, lease generation, worker ownership/wait state, case revision, source hashes, policy version, status dimensions, exact cent amounts, and decision/bill/payment/command/bank/journal references. The snapshots explicitly select those fields; they do not copy original documents, extracted text, private credentials or bank destinations.

The before/after values describe **one worker operation**. Bank settlement or human approval may occur between operations and therefore first appear in the next operation's **before** snapshot. These observations do not claim that the agent itself authorized or executed the payment. The existing human decisions and payment workers remain authoritative.

## Commit and replay behavior

- The queue change, optional payment proposal, operation receipt and audit insert share one Convex mutation. Invalid audit evidence rolls back all of them.
- Retrying a completed claim or advancement returns the saved result without another audit entry or payment proposal. Unchanged polling does not produce transitions.
- Handoffs persist the new stage, owner and requirements. Replaying a completed handoff returns that stage instead of the previous stage. Discovery handoffs increment the generation only when routing changes.
- Pause/resume events record the newly committed generation. Old leases remain fenced. Pausing this worker does not stop the separate observer for payments already in flight.
- Historical stage-only events remain readable with no `agentTransition` field. No historical before/after values are invented or backfilled. The optional database field is additive.
- A definite policy refusal can commit an owned escalation with outcome `blocked`. Rejected authentication/stale-lease calls still throw and roll back; this is not a complete log of every denied API request.

## Local verification, October 25, 2026

Node 26.8.1 on the MacBook; fresh checkout and dependencies, without the Mac Studio runtime or private provider configuration.

```sh
npm exec vitest run tests/ap-system src/ap-system/contracts.test.ts
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
```

**893 tests passed across 117 files**, including the existing browser-mounted AP tests. All three TypeScript checks passed. The agent suites contain 20 passing tests, including five additional regressions. Saved records and source hashes are in [the transition evidence directory](evidence/agent-transition-v1/manifest.json).

The same-case test retains the missing-receipt wait through a later source revision, independent reviews, one proposal, human payment authorization and a FakeBank settlement. Its saved trace links one bill, one proposal, one command, one provider transfer, one posted bank debit and two journals. FakeBank retains both the completed pending record and the posted transaction; only the posted transaction is linked to the settlement. Replayed settlement creates no additional posting. The process test kills the actual CLI after claim and resumes it against state retained by the parent Convex-test process; lease expiry is advanced by the fixture. This does not establish a durable database restart.

Other checks cover immutable snapshots after later authorization, handoff replay, pause/resume generations, idle polling, safe snapshot fields, legacy event compatibility, policy-refusal escalation and rollback when audit validation fails.

This is local component/integration evidence with synthetic text originals, simulated humans and FakeBank. No new Increase, QuickBooks, Auth0 or model calls were made. Model-selected tools, complete denied-action tracing, external accounting IDs and the APEX replay remain separate #108 / #107 work; this change does not close either issue or #97. The UI receives the richer timeline payload, but a dedicated before/after display is not part of this backend change.
