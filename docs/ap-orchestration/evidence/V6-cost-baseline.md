# V6 independent cost bridge / UI baseline

Immutable production baseline: `852d835bba09180e2cd71dabefd14d807b3f9da8` (D `df7a8ef9928576c43236d9c1b20177bdeb4934c6`). Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. This is independent agent engineering review, not practitioner sign-off, real Auth0 verification, provider verification or integrated I1/I2 acceptance. The expected arithmetic was fixed in `V6-expectations.json` before executing probes.

## Findings

- **V6-F1 / P2 / open:** `console/src/APCostCorrection.tsx:buildCostCorrection` checks original-share capacity but omits aggregated signed account/store positions. Actual backend fixture recognizes gross expense 7700 less discount 100 in account 5000, then reclassifies 4000 to inventory 1200. Current positions are 5000=3600 and 1200=4000. A half-credit plan credit5000=3651, credit1200=199, debit5000=50 fits each original share but consumes 3601 from account5000. UI builder accepts it and the editor marks it ready. The unchanged independent negative test fails. Backend independently rejects `cost_capacity_exceeded` atomically; no money/ledger bypass was found. Fix must aggregate signed values per account/store and still allow the exact valid boundary credit3650 minus debit50=3600.
- **V6-F2 / P2 / open:** `console/src/APSystemBusiness.tsx` renders the posting date input only for invoices. A credit dated 2026-10-19 against an original corrected on 2026-10-31 cannot use its default date: actual backend rejects `cost_correction_date`. Exactly the same valid plan with explicit 2026-10-31 can be proposed, but the credit form has no date control and omits `accountingDate`. Independent SSR date-control assertion fails. Expose the explicit posting date for credits, preserve original document date, and invalidate the reviewed cost context after a date change.

Both findings were sent to Master before production changes. This branch contains no production edits.

## Evidence

Command (worktree `/Users/junjiexiong/.codex/worktrees/ap-system-verification/calhacks`):

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v6-cost*test* tests/ap-system-cost-ui.test.tsx tests/ap-system-close-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v6-cost-final-baseline.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

Result: **17 passed, 2 failed, 19 total**; tests typecheck passes. Independent tests: 8 total, 6 passed / the two findings failed. Owner tests: 11 passed. These counts are one selected run, not additive with older checkpoints.

Actual `convex-test` business and close handlers prove signed netting success, atomic overdraw/date rejection, and current configured human reads rejecting anonymous, unconfigured, retired and wrong-run identities without ledger or payment mutations. The direct service/HTTP owner tests verify the new read bridge and server-owned scope.

A mounted React/Chromium probe uses an isolated ephemeral Vite port, fake deferred cost reads, and `/private/tmp` cache. It proves an aborted late original-A response cannot authorize original B; a reviewed plan becomes unready and unchecked after editing; a changed parent context hides the old form while loading; a mismatched returned journal ID cannot become ready. It is a component fixture, not a live application/authentication test. Initial browser assertion counted DOM before the loading render; it was synchronized to React's loading state without changing readiness assertions.

Money probes preserve exact safe-integer cents, reject malformed values, forbid blank/default accounting amounts, and retain real positive outstanding limits for payments. Source review confirms actual payment and batch-run paths still call `paymentAmountInput` with the current outstanding amount; credit application additionally checks credit availability and total obligation. No new accounting helper replaced these payment limits.

New fixture corrections before final evidence: table name `apBusinessProposals` corrected to real `apApprovalProposals`, and schema status `none` corrected to `not_proposed`. Initial diagnostic outputs are retained privately under `/private/tmp/ap97-v6-cost-{baseline,all}.json`; they are not authoritative pass evidence. The final test uses actual proposal rows in atomic snapshots.

No credentials read, no existing services touched, no live backend/provider requests, no canonical registry writes. The temporary dependency symlink points read-only to the integration checkout; final cleanup removes only that symlink.
