# V5 repair checkpoint — standalone receipt capacity and QBO query proof

Independent reviewer: `/root/verifier`. Both V5 findings are closed for their reproduced and inspected engineering scope. This checkpoint does not represent practitioner sign-off or real provider acceptance. The immutable failing baseline remains `391f2e9fc027f79babd736fe83047bc253bab1fa`, with tests and findings committed in `266c894`; its report and result JSON are unchanged. Spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contracts `ap-evidence-v1`, `ap-business-v1`.

## Additive repair identity

The new branch `codex/ap-system-verification-v5-repair` starts from the failing evidence commit and adds only the following implementation-owner fixes:

- `354cb3603c2c723d532969be5c593e3f2b03782e`, replayed as `babba08`: standalone receipt reviewed capacity accounting plus three owner regressions and owner evidence.
- `78532b33f0c5752525c7a2f9c148c92887bf6387`, replayed as `26f2b59`: validated QBO query envelopes in identity reconciliation and restored-principal consumption plus three owner regressions.

No production code is authored by the verifier. Exact replay commits, source/test SHA256s and complete test identities are in `V5-repair.json`. Master should integrate only verifier baseline/report/test commits when the owner fixes are already present, not replay those production cherry-picks again.

## Results and narrow compatibility changes

1. SHA256 checks confirmed all original V5 test files and frozen expectations were unchanged before the first repaired run. That run was **70/71 passed**. Both original F1 close probes passed. F2 now correctly rejected with `qbo_query_envelope_invalid`; its original regex permitted `restored_balance_incomplete|response`, so that one assertion failed solely on diagnostic vocabulary. This failed run is retained in the evidence JSON rather than relabeled successful.
2. The only independent-test migration adds that exact new error code to the same rejection regex. The unchanged next assertion confirms the count remains three original accounting POSTs, with no fourth replacement POST. The replay then passed **71/71**, comprising all **16 independent V5 tests**, 49 prior regressions and six owner-fix regressions across ten files.
3. The migrated current V3 QBO suite also passes **13/13** under the repaired client. Thus the bounded post-repair suites contain **84 distinct passing tests**. The subsequent three-case owner-envelope fixture rerun is a repeat and is not added to that total.
4. The owner-envelope fixture initially used null `caseId` and `billId`, supported by the owner's newer B4 types but not by frozen baseline391f2e9. Test TypeScript reported exactly two TS2322 errors. Master and the owner authorized replacing only those two unused fixture link fields with explicit synthetic strings in this isolated branch. The three envelope tests were rerun and passed; test and backend TypeScript checks now both exit 0. This type-only compatibility commit is separate and **must not be brought into current integration solely for this replay**. Current integration intentionally supports case-less null links.

## Why the fixes address the reproductions

F1 now feeds standalone receipt capacity from approved immutable accrual interpretation into the existing source/SKU/unit coverage calculation. It compares received units against invoice units plus accrued units minus reversals with posted journals as of period end. Historical accrual existence cannot by itself discharge an original. Conflicting capacity remains held. Both actual public close attempts now reject and leave the period open; the owner positive case still permits a fully covered standalone receipt while carrying forward legitimate unpaid AP. Existing fresh/stale reversal, exact allocation-cent, invoice reversal and reclassification probes all remain green.

F2 now requires an own, non-null object `QueryResponse`, an array for any explicitly present expected entity, valid row identities and coherent pagination metadata. Missing, null, array, wrong-entity, malformed-ID or incomplete results reject. Valid empty object and empty expected entity array remain supported, and valid exact economics remain usable. Both `find` and `journalAppliedCents` use the same validation, so malformed identity or capacity proof cannot authorize a new write. The corrected independent reproduction rejects before a fourth POST. Existing duplicate/mixed-link/fractional-cent negatives and accepted-response-lost recovery with the original request/approval also pass.

The primary [Intuit QueryResponse schema](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/a77ed435-080a-c935-aad5-d09b2088d222.htm) distinguishes returned-row count, starting row and total filter count; the [official query limits](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html) cap a response at 1,000 entities. The implementation retains the conservative 1,000-row refusal instead of inferring completeness. This documentation check is not a live QBO test.

## Exact commands

```sh
./node_modules/.bin/vitest run tests/ap-system/v5-close.test.ts tests/ap-system/v5-quickbooks.test.ts tests/ap-system/v5-governed-credit.test.ts tests/ap-system/close.test.ts tests/ap-system/close-capacity.test.ts tests/ap-system/governed-payment-credits.test.ts tests/ap-system/quickbooks-business.test.ts tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/quickbooks-corrections.test.ts tests/ap-system/quickbooks-query-envelope.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-repair-unchanged-results.json
# After the single rejection-code migration, same file list and flags:
# --outputFile=/private/tmp/ap97-v5-repair-results.json
./node_modules/.bin/vitest run tests/ap-system/v3-quickbooks.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-repair-v3-results.json
./node_modules/.bin/vitest run tests/ap-system/quickbooks-query-envelope.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-envelope-compat-results.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
```

The evidence boundaries in `V5-baseline.md` still apply: actual isolated AP backend/FakeBank for governed-payment cases, in-memory QBO HTTP protocol and test-seeded Increase-shaped settlement/return rows for accounting sync cases, simulated human identity, no shared backend/provider/private credentials. This checkpoint excludes subsequent corrected-cost business paths, period-sync request bridge and aggregate cancellation-reconciliation changes; those are a separately assigned extension, not silently folded into the original baseline. Original V3 and V4 evidence remains intact. AP practitioner review, real Auth0 and live provider acceptance remain external tasks.
