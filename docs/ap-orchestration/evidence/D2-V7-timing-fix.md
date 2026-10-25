# D2 V7-T1 retained approval authority

Baseline: independent review commit `e3707a2`, including the unchanged `tests/ap-system/v7-timing.test.ts` reproduction.

Pending business projection now checks retained vote identities, original seat bindings, independent positions, current group membership, retained escalation rules and delegation validity. It reuses the existing complete-approval validation through a partial-route wrapper that omits only the requirement for future quorum votes. Complete approval validation continues to require every quorum.

A retired or rebound voter, or expired/revoked retained delegation, makes the current projection `stale` with `business_authority_hold`. Existing timing logic then marks the pending approval queue `unavailable`, with null duration and no invented stopping timestamp. Valid partial routes remain pending and ongoing. Completed historical durations remain completed even when present approval authority later becomes stale.

This is a read-model correction. It does not modify stored proposals, votes, decisions, case records, journals or commands; it does not approve, cancel, recertify or send a payment. The real final-vote path continues to reject invalid retained authority.

Validation: 69 tests pass across business, payment-boundary/integration, retained-authority and timing suites. The five independent V7 timing tests pass unchanged. Six added regressions cover valid partial quorum, retired/rebound retained identities, revoked/expired delegation, preservation of completed history, rejected continuation and unchanged durable records after projection reads. Application, backend and full test typechecks and `git diff --check` pass. No UI or provider operation was performed. Independent post-fix verifier replay remains owned by Master/V.
