# V7 independent operational timing review

Immutable baseline `7b0f6444bf79ec914c0c7d0a4af1444af092c49c`, timing source owner commit `ef897251bcf706ce1b19e1a7b6e2453d175d648b`. This is independent engineering verification with actual AP handlers, persisted events and isolated in-memory FakeBank. No real provider, current shared backend, credential or canonical registry was accessed or changed.

## Baseline result

The combined selected suite has **24 tests:23 passed,1 failed**. Seven are new independent tests (two original/key checks and five timing checks), of which six pass. All17 existing timing tests pass. The one failure is a confirmed status/metric defect, not an accounting or payment bypass. The original/key review separately passes all104 visible fact comparisons and four original integrity checks.

Command:

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v7*test.ts tests/ap-system-operational-timing.test.ts tests/ap-system/operational-timing.test.ts tests/ap-system-timing-ui.test.tsx tests/ap-system-timing-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v7-final-baseline.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

The full tests typecheck passes. Application and backend typechecks also pass, as recorded in the final structured results.

## V7-T1 / P2 / open: invalid retained voter remains an ongoing queue

The independent expectation, recorded before running the test, treats invalid retained authority as unavailable rather than a current measurable approval queue. Actual reproduction:

1. Create a governed proposal, record the owner vote, then supersede it with a new proposal on the same revision. The first proposal correctly becomes unavailable because no supersession completion time is retained.
2. Record the new proposal's owner vote and retire that owner's configured human seat.
3. Attempt the next finance approval: the real backend rejects the invalid retained voter, preserving payment/accounting safety.
4. Read metrics. The new proposal still reports `state=ongoing`, `elapsedMs=20000`, and the case domain projection still considers it pending. The independent expectation of `unavailable` fails.

Cause: `convex/lib/apSystem/businessProjection.ts` checks retained votes through `assertApprovalCurrent` only for already approved proposals. Pending proposals do not revalidate those retained vote identities for the read model. `projectCaseTimings` uses `domain.approvalStatus===stale` to mark a pending route unavailable, so this pending invalid-voter state continues its queue age.

Master confirmed this as a status/metric defect after reviewing the reproduction. It is not a payment defect. The intended behavior is to mark invalid retained-voter authority stale and leave its queue duration unavailable when there is no stopping timestamp. Fix the authoritative pending projection and retain the unchanged negative test; do not fabricate a stopping time from generic updatedAt or retirement discovery time. No production fix is included in this baseline.

## Passing independent boundaries

- Actual policy activation with a new version makes the frozen pending route unavailable. Superseded routes likewise do not accumulate an invented ongoing interval.
- Metrics excludes same-run foreign-account payment versions and foreign-organization proposals even when they point at the same case/bill, and a retired read identity is rejected. Reading leaves commands, versions and journals unchanged.
- A lost bank response starts a recovery interval. Even after the isolated bank has settled, local metrics remain ongoing until local evidence is imported, matched and posted. Completed recovery stays fixed as server `asOf` advances. A later return uses its own matched return endpoint for unresolved-outcome duration; the first completed recovery episode remains historical. One actual FakeBank transfer is retained.
- Missing/future/reversed timestamps stay unavailable and do not become zero samples or enter completed/ongoing aggregates. Two genuinely equal persisted timestamps produce a legitimate zero duration.
- Existing tests separately cover current human/session/scope transport, source revision binding, grouped payment-run membership, scheduled unsent clocks, dispatch blocks, abandoned attempts and UI separation of medians, ongoing oldest age and missing coverage.

## Diagnostic corrections and limits

An initial new recovery assertion assumed `matchedAt` equaled the test's nominal 60000ms clock; the fixture actually persisted matching at60001ms. It was corrected to calculate duration from the independently read durable failure and matched timestamps, while still requiring matching no earlier than the nominated tick. A temporary test selector used `purpose=payment`; the actual FakeBank transaction contract uses `debit`, which was corrected. No production code or economic expectation changed.

The metrics are persisted-event intervals, not upload/OCR latency, active staff labor, service targets, production performance, or provider acceptance. Overlapping samples must not be summed. Historical missing timestamps remain gaps. These tests do not provide real Auth0 or AP/accounting practitioner sign-off.
