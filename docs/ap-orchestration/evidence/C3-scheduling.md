# C3 payment scheduling and explicit partial disbursement

Implementation checkpoint; final integrated acceptance is pending the Auth0/API seam and B3 business-authority integration. No Increase operation was performed for this evidence.

The payment requester may choose an exact UTC initiation date and a positive bill allocation bounded by the approved outstanding balance. Missing date preserves immediate-after-authorization behavior. The due date is shown as the editable default in the case workspace. Past dates are immediately eligible after authorization. A calendar date is not a bank settlement guarantee or a business-day/cutoff calculation.

The schedule is part of the immutable, human-approved payment snapshot and its hash. `nextAttemptAt` remains technical retry state. A future authorized command receives no lease, attempt or recovery-budget start before its initiation date. At first dispatch the engine rechecks current bill, source, policy, beneficiary and human authority. A possible prior send instead recovers the original command, idempotency key, request bytes and first-attempt time. Rescheduling requires cancellation while provably unsent, a new proposal and renewed independent authorization. The case cancellation endpoint validates identity, scope and case/version membership.

Partial selection is explicit. The original invoice and approved payable stay unchanged. The request key binds date, bill selection, gross allocation and credits; retries cannot silently change them. One live reservation owns each bill, including when the selected amount is partial. A verified posted debit consumes only that allocation. Credits were recognized earlier; their allocation does not recognize cost/AP again. Cash must remain positive on the bank path; a credit-only workflow belongs to the B3 domain allocation path.

Measured component evidence:

- 18 scheduling/allocation/backend tests cover calendar validity, leap day, UTC boundary, overdue date, no authorization, reset-shaped worker claims, attempts/budget, cancellation/reapproval, changed replay input, revoked authority, response loss/retry, bounded amounts, missing balances and case cancellation.
- Actual FakeBank + Convex test-kernel path: a 10,000-cent recognized bill and a 2,000-cent recognized credit; first selected gross allocation 6,000, cash 4,000; outstanding bill 4,000. Second independent authorization pays the remaining 4,000. Observed 2 transfers, 2 posted debits, 1 recognition journal, 1 credit journal, 2 settlement journals and AP control net zero. Repeated reconciliation and request replay do not duplicate effects.
- 3 UI component tests cover initiation wording, partial remainder availability, unknown-outcome hold and exact USD input (no rounding).
- Existing payment suite: 174/174 passed after the engine extension. Independent V2 tests are re-run separately after integration.
- TypeScript, console build and static design checks passed; console build has its existing >500 kB bundle warning. Browser visual verification of the new selection controls remains pending, distinct from D1 cold-session verification.

These tests use simulated human identities and local bank evidence. They do not establish real Auth0 login, Increase settlement, QuickBooks synchronization, or AP practitioner sign-off.

## Payment runs checkpoint

`apPaymentRuns` groups one to 25 reviewed cases into an immutable manifest. It prepares existing per-case payment versions in one atomic mutation; no second payment engine or aggregated cross-supplier bank instruction is introduced. Human run authorization binds the run hash and every current case/payment hash. A stale or cancelled member rolls back all newly queued commands. Cancelling a batch is atomic only while every member is provably unsent; a possible send prevents blanket cancellation. Individual bank commands and outcomes remain visible through the case/payment records. Seven component tests pass for replay, duplicates, rollback, authority, rescheduling, possible-send preservation and manifest corruption. The run controls still require D2 UI/API wiring.
