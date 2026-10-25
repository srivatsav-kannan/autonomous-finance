# V9 — independent E04 repair replay and transport extension

Reviewed immutable integration `906d4878aa5d2a3991fa724a2d5559e04417a6c3`, containing B repair `953bc27da402f79608fb3e898f9f0c26186ef7d0` and D physical UI/transport `5711ed9476fe1f549c727f5005997f583f92d97c` (integrated `764701b`). Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

The original baseline remains **35/37**, frozen at runtime `55f1efe815f68ec86719b21fdd3f7ef00370a93e` and verifier commit `c524f67a5d967bfe12e777173cc614a7b785ed09`. No original fixture, expected value, assertion or baseline report was changed. All four baseline file SHA-256 values match. This checkpoint independently resolves V9-F1 and V9-F2; it does not rewrite the baseline as passing.

- **Backend repair: 43/43 pass.** All 20 unchanged independent tests, 17 original owner tests, and 6 repair owner regressions pass.
- **UI/transport extension: 13/13 pass.** Three new independent tests pass alongside D's 8 UI and 2 transport tests. These are separate from the backend count.
- Root, backend and test TypeScript checks pass. Exact test identities, file integrity and raw-output digests are recorded in `V9-E04-repair-results.json`.

## Repair conclusions

**V9-F1 (P1), resolved:** `validateAccrual` now requires both the frozen physical catalog supplier and mapped invoice supplier to equal the proposed accrual supplier before claims are resolved. The unchanged public wrong-supplier accrual probe now rejects with no accounting-state mutation. Correct-supplier accrual, invoice application and reversal positives still pass.

**V9-F2 (P2), resolved:** the out-of-period fallback now reconstructs the entire frozen receipt/service-acceptance catalog with physical IDs. It checks retained accrual supplier, original, physical ID, SKU, unit and capacity; it includes unaccrued siblings rather than inferring the receipt from only accrued portions. The unchanged independent October accrual / November invoice test now reaches an actual period close. Partial, missing and reversed sibling coverage remains blocked in the repair regressions. The original same-period close and independent invoice/manual reversal tests still pass.

## Added independent UI/transport checks

`v9-physical-transport.test.tsx` crosses actual loopback HTTP, the production service, and isolated convex-test backend. Authentication is an explicitly synthetic request identity fixture; it does not claim official Auth0 token validation or a real login.

1. A controller mapping proposal with empty links is rejected and creates no review. A valid two-line proposal replays exactly. A nonmember cannot approve it, a forged scope is rejected, and switching bearer identity while retaining the other identity's session cookie is rejected. A separately established authorized reviewer's request approves and replays. The returned decision records that reviewer's actual backend subject/seat. Exactly one catalog exists, its capacities remain 0.5 and 1.5, and no bill, journal or payment command is created. The read response contains neither private tokens nor original byte/ref fields.
2. An empty allocation for a positive half-unit claim fails both the shared UI validation and public backend proposal with unchanged state. The explicit north-half allocation succeeds, produces exactly 1,925 cents, and leaves south's 1.5 units available. Server-rendered allocation controls begin empty; missing inventory renders unavailable/loading rather than fabricated choices. This positive claim check does not claim browser interaction or comprehensive zero-amount draft behavior.
3. An actual same-case revision changes parser row IDs. Retained prior inventory no longer offers its mapping/accrual choices against the new case detail; shared UI validation and backend proposal reject the old claim. A source remaining in historical `sources` but removed from `currentSourceBindings` likewise cannot supply a current UI mapping.

Code review also traced the controller-only proposal / human-only decision service paths, current case/source/snapshot validation, supplier-filtered accrual choices, explicit allocation sum checks, and component request-key/abort handling. Proposal, identity approval, business recognition and payment remain distinct. The frontend's displayed remaining capacity is informational: backend atomic validation controls the actual post, including allowed accrual reversals.

## Commands and bounds

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v9-physical.test.ts tests/ap-system/v9-accrual-close.test.ts tests/ap-system/v9-credits-history.test.ts tests/ap-system/physical-lines.test.ts tests/ap-system/physical-accrual-regressions.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v9-e04-repair.json
node node_modules/vitest/vitest.mjs run tests/ap-system/v9-physical-transport.test.tsx tests/ap-system-physical-ui.test.tsx tests/ap-system-physical-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v9-e04-ui-transport.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

No new actionable defect was reproduced in this bounded extension. Existing limits remain: synthetic retained text is not original-PDF/geometry evaluation; untagged historical physical usage is held rather than migrated; this checkpoint is not a full test suite, browser acceptance, live backend/provider run, actual payment, real Auth0 acceptance or practitioner sign-off. E02 dimensions present in the ancestry are not independently accepted here. No canonical registry or production source was edited. Temporary outputs remain under `/private/tmp`; dependencies were read through the integration worktree's node_modules link.
