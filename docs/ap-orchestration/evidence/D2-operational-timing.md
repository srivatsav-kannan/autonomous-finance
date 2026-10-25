# D2 operational timing projection

This checkpoint adds a provider-free, read-only projection of persisted operational events. It does not establish service-level targets, production performance, external-provider acceptance, or practitioner acceptance.

`GET /api/ap-system/metrics` requires the existing subject-bound HTTP session. The request-owned human client calls `apOperationalMetrics:current` with the server's complete bank scope. The backend checks current human authorization and restricts records to that scope. The response identifies the server `asOf`, current case ID/revision/hash, each measured interval's event references, and each payment's frozen source revision/hash, version/hash, and payment-run membership where retained. Historical source bindings that cannot be reconstructed remain null.

## Definitions and evidence

| Measure | Start | Completion | Missing evidence behavior |
| --- | --- | --- | --- |
| Document to review | Current immutable `apCaseRevisions.at` | First approved same-revision/hash field-review decision | No retained revision time is not measurable. This begins at source retention, after parsing; it does not claim upload/OCR latency. |
| Review to post | That approved field review | Recognition journal `postedAt`, with a same-revision/hash bill-approval decision | Old-revision recognition cannot become the current revision's posting time. No approved review means not started. Accounting dates are never event clocks. |
| Human waiting | Initial source-review queue; business proposal creation; or frozen payment proposal creation | First field decision; business route `completedAt`; or exact payment human approval/proven cancellation | This is queue elapsed time, not active human labor. Stale or superseded authority without a stopping timestamp is not measurable. Scheduling time after approval is excluded. |
| Exception age | Persisted negative field decision, pending business proposal, dispatch-block audit, or failed dispatch completion | Next approved field review, business completion, dispatch claim/cancellation, or matched outcome/release | Current computed holds without their own persisted onset are explicitly not measurable. Generic `updatedAt` is never substituted. Repeated evidence requests form one episode until approved. |
| Unresolved payment age | Command `firstAttemptAt`, the first recorded dispatch claim | A posted-and-matched bank transaction or proven release/cancellation | A claim means submission may have started, not proof the provider received it. Unsent scheduled/blocked proposals have not started the clock. Terminal provider state without completion evidence does not become a zero or fabricated duration. |
| Recovery time | First recorded completed failed dispatch attempt | A subsequent posted-and-matched transaction or proven release/cancellation | Provider acceptance alone does not close recovery. Abandoned earlier attempts without failure completion, or unresolved commands without a recorded failure timestamp, are not measurable. |

The UI separates completed median durations from oldest ongoing ages and reports interval coverage. Ongoing age stops at the explicit server snapshot; it does not silently tick against the browser clock. Overlapping measures are not summed into a total. Record details expose start/completion timestamps and exact event/source/payment/run references. The client rejects a response whose scope or current case/revision/hash set differs from its loaded case list, hides prior-generation results, and aborts superseded requests.

No worker heartbeat, configured timeout, retry budget, target duration, document accounting date, or UI load time is treated as operational progress. A lack of recorded intervals is distinct from a measured zero. A true pair of equal persisted timestamps may legitimately produce zero milliseconds.

## Validation

Focused timing checks cover pure interval boundaries, missing/reversed/future timestamps, current revision isolation, repeated evidence requests, scheduled proposals, dispatch blocks, missing failure timestamps, completed and ongoing recovery, and the UI's separate coverage groups.

The `convex-test` workflow uses genuine persisted records with an isolated in-memory FakeBank: source retention, field review, recognition, payment proposal, human authorization, accepted transfer with a lost response, recovery and matched posting. It verifies calculated durations against the stored event timestamps, a single bank transfer, and no journal/command mutations from reading metrics. A second workflow verifies sequential independent business votes. A third verifies frozen payment-run membership, unsent cancellation, and exclusion of another account's records. These are local test results, not external bank or practitioner evidence.

Transport checks verify request-owned human/server-scope routing, missing/expired/unapproved/cross-user sessions, origin rejection, GET-only behavior, absent capability, no-store responses and abort forwarding. Render checks verify missing time is not zero and historical unknown revision is not relabeled current.

Validation result: 17 timing-focused tests and the broader 119-test AP UI/auth/transport set pass. Application, backend and full test typechecks pass. Console build and design check pass; the existing bundle-size advisory remains.

Commands:

```sh
npx vitest run tests/ap-system-operational-timing.test.ts tests/ap-system/operational-timing.test.ts tests/ap-system-timing-ui.test.tsx tests/ap-system-timing-transport.test.ts
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm run build:console
npm run design:check
git diff --check
```

The existing D2 browser fixture now provides an explicitly synthetic `/metrics` response. Its timing values are presentation examples, not observed workflow performance. It displays no completed bank recovery and marks its unsent payments not started. Root owns the CUA check at desktop/mobile widths and light/dark palettes; this checkpoint does not claim that visual pass.

Fixture: `http://127.0.0.1:5191/@fs/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks/docs/ap-orchestration/evidence/D2-browser/fixture.html`. Expand **Operational durations and waiting ages**, inspect the two result columns and coverage, select a case, and expand **Inspect timing basis**. **Open this case** should navigate to the same case without changing economic state. The top banner labels all data and actions synthetic; the fixture never forwards requests.

The query currently scans the selected run's persisted records, matching the existing case-list scale. Production pagination/aggregation and new historical timestamp instrumentation are outside this bounded projection. In particular, legacy computed holds and abandoned attempts may remain unmeasurable; their missing timestamps are displayed rather than backfilled with guesses.
