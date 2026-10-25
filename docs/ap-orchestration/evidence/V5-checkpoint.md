# V5 checkpoint — V4 repair replay and current V3 contract migration

Independent reviewer: `/root/verifier`. Immutable production baseline: `391f2e9fc027f79babd736fe83047bc253bab1fa`. Spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; evidence contract `ap-evidence-v1`. This checkpoint closes the three recorded V4 defects in the tested scope and migrates the current V3 suite. It does not accept the newly assigned B4/C4 scope, real Auth0 login, provider workflows, or practitioner sign-off.

## V4 repairs

Before execution, SHA256 checks against the preserved `V4-results.json` confirmed the three V4 test files and frozen expectations are unchanged. The original V4 baseline `a8ea9efcc25536ef363ebfc383923bdcce98dbd4` and failing report remain available in commit `1c23e87a0a2a92e5406bf8c3b60316d2e1f10b3b`; that report is not rewritten.

At the V5 baseline, all **15 unchanged independent V4 tests pass**, including all four formerly failing probes. The **13** current implementation-owner authority regressions also pass, for **28/28** across four files. The owner cases are counted separately, not attributed to the independent verifier. Test TypeScript compilation passes.

The integrated correction is `126596b6f344b4fd26d7ace04664d51b22a7dd1c` (owner source `d1f747ceb0bdb6effdb2e81746ef8db5e94c8a6e`). Independent inspection confirms:

- F1: a retained semantic fingerprint binds the whole original purchasing line set (supplier/kind/SKU/unit/quantity/price), independent of parser IDs. Consumption keys use original identity and SKU/unit; copied/renumbered originals cannot reset capacity. Ambiguous repeated physical SKU/unit lines are explicitly held. Older records reconstruct their retained original interpretation. The owner's passing positive case demonstrates that the exact remaining one unit can still be recognized.
- F2: supplier activation rechecks retained verifier active human seat, current verification group and original seat binding; approver and proposer separation uses actual seats. Current payment authority also revalidates verifier/approver seats and groups. A replacement supplier revision can repair expired authority without rebooking recognition.
- F3: votes and delegations retain original subject/principal seat IDs. New and retained votes resolve current active bindings and reject shared underlying seats, including aliases and delegated principals. Rebinding cannot transfer an earlier decision to another person.

This closes V4-F1/F2/F3 for the exact reproduced paths and inspected repair. It is not a claim that every possible authority configuration has been exhaustively tested.

## Current V3 test migration

Historical V3 source and report remain unchanged at commit `ac0be77906b1a9458b180c6fcdf39a63489f6cad`, on production baseline `6251f5770f1394a48a3c6d517429498f9a569bfd`. The current running file `tests/ap-system/v3-quickbooks.test.ts` is deliberately updated; its original and new SHA256 are recorded in `V5-checkpoint.json`. No production or shared fixture is edited.

1. First external POST now requires explicit `SubmissionAuthorization` bound to the plan hash, subject and current decision time. Direct journal tests provide it only for the initial write. Recovery/read calls retain no authorization argument. The concurrent writer and reopened-journal cases additionally assert that the original submission authorization is preserved. Existing one-POST, stable request ID, unknown/no-repost, duplicate conflict, SyncToken conflict, immutable mappings, response mismatch, private-file and corruption assertions remain.
2. Partial export is now supported. The obsolete blanket rejection is replaced with exact economic assertions using actual AP backend and FakeBank settlement: accepted bill 7,700; gross discharged 5,000; outstanding 2,700; cash 5,000 without credit or 3,800 with a separately recognized linked credit application of 1,200. Planning keeps the original Bill at 77 dollars, links 50 dollars of gross Bill discharge, adds a 12-dollar VendorCredit link only when selected, and reports 50/38 dollars cash. An attempted substitution of full 7,700 gross while retaining the partial cash/credit still rejects.
3. The former credit fixture used an unlinked legacy `recordCredit`; current authoritative export requires the B3 original approval/allocation link. The migrated branch obtains a real governed credit through public B3 proposal/vote, then applies exactly 1,200 of it. The original V3 failure text `row outside account scope` came from the missing link's scope assertion; merely patching scope would not establish this authority. Synthetic Increase-shaped planning remains explicitly separate from actual FakeBank execution.

The migrated current suite passes **13/13**. Existing linked-Bill external-change and before-write authority recheck tests continue to pass. No QBO HTTP request reaches the network: transport is an explicit in-memory protocol double.

## Commands

```sh
./node_modules/.bin/vitest run tests/ap-system/v4-auth.test.ts tests/ap-system/v4-business.test.ts tests/ap-system/v4-credits.test.ts tests/ap-system/business-authority-regressions.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-v4-repair-results.json
./node_modules/.bin/vitest run tests/ap-system/v3-quickbooks.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-v3-migration-results.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
```

Total checkpoint: 41/41 tests across five files, TypeScript exit 0. Full names/results and raw-output hashes are in `V5-checkpoint.json`. No shared backend, private credentials or live service was accessed. Further B4/C4 adversarial review continues separately; the canonical registry remains Master-owned.
