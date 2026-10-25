# Current USD engineering checkpoint — 25 October 2026

The full integrated suite on `341f472` passed **1,864 tests**, with four intentional skips and no failures, using four workers. The final code checkpoint `7a67840` subsequently changes only receipt guidance; 15 focused UI/transport checks, all three TypeScript checks, console build and design checks passed. The intervening `a9ead60` change is the practitioner document refresh. This is a local engineering checkpoint, not overall roadmap or external acceptance.

## Preserved failure and replay

The first full run at `1a5dc70` reported1,834 passed,4 skipped and2 failures, both the unchanged5-second deadline: the zero-cash restored-credit protocol test and V12 returned-cash/credit/replacement sequence. Those same two files replayed32/32 with no code, assertion or timeout change. The formerly timed-out cases took about1.31s and1.62s. The later full suite ran with `--maxWorkers=4` to bound local contention and passed. Every earlier assertion identity remains in the final report. No functional defect is inferred from these timeouts, and the initial failure is retained in the machine-readable evidence.

[Results](FINAL-engineering-checkpoint-results.json) retain per-file assertion names, statuses, durations, failure stacks and hashes of the original raw reports. Commands:

```sh
npm test -- --reporter=json --outputFile=/private/tmp/ap97-integration-1a5dc70.json
npx vitest run tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/v12-external-settlement.test.ts --reporter=json --outputFile=/private/tmp/ap97-timeout-replay.json
npm test -- --maxWorkers=4 --reporter=json --outputFile=/private/tmp/ap97-integration-341f472.json
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm run build:console
npm run design:check
```

Build passed with the existing large-chunk advisory (final main bundle871.99kB). Design check:0 FAIL,0 WARN,1 ANSWERED. No performance improvement or production hosting result is claimed.

## Independent and browser evidence

[V13](V13-repair.md) preserves two reproduced eligibility-evidence failures and the unchanged99-test successful repair replay. [V14](V14-independent.md) passes25 independent plus30 related owner checks on tax JournalEntry mapping, current authority, immutable historical recovery and transport. These overlap the full suite; counts must not be added.

[Desktop review](D2-tax-desktop-review.md) checked explicit tax facts, pending review, adjustment inputs and historical receipt controls in synthetic components. A prepared receipt incorrectly invited verification; its guidance was corrected and rechecked without changing authority or button logic. This local fixture never calls QBO or a backend.

## Scope and remaining acceptance

The user agreed to finish USD and move multicurrency/FX to [#104](https://github.com/srivatsav-kannan/autonomous-finance/issues/104); [#97 records the decision](https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6396796577). The original frozen snapshot is unchanged. UI acceptance is laptop/desktop web; hosting remains future work. [Issue receipts](2026-10-25-scope-and-issue-receipts.json) also retain the independently verified OCR packaging comment.

The practitioner packet now contains22 expected scenarios and58 balanced entries, including tax/header/adjustment, dimensions, contact and physical identity cases. These remain EXPECTED_ONLY; actual reviewer identity, findings and sign-off are unfilled.

Actual Auth0 login and eight QBO reference writes were previously verified. INV-1001 still needs the actual operator's field and bill decisions; payment authorization is separate. QBO accounting transaction writes remain0. No Increase funding, worker or outbound payment has run. Real provider round-trip/recovery and practitioner acceptance remain pending. The real operator preview intentionally remains pinned to its earlier isolated code while the user reviews. This checkpoint does not merge main, publish a website, change live policy/mappings or execute money movement.
