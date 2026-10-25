# V5 QBO extension baseline — signed stores, mapping history and restored credit

Independent agent engineering review of production `3c834ae` (full SHA in JSON), with unchanged prior evidence replay giving baseline `2ea9555a77412ff1bae944df5320bf114858ff1f`. Assigned patches: store dimensions `533fecc8e3cc01c81824b558dceb1aabd7c42ed1` and restored-credit synchronization `8725f63c415e459fdb6060d1ca585eeba9ef9ada`. Spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

The final baseline run has **43 tests, 42 passed and one product failure**. Four newly authored independent probes contribute three passes and the failure; 18 owner regressions and 21 migrated historical independent tests pass. Test/backend TypeScript checks pass. No live provider, real Auth0 identity, shared backend or practitioner acceptance is claimed.

## V5-QBO-F3 — medium: unexpected JournalEntry Class is not an external conflict

The new `client.matches()` exact-Class safeguard applies to `AccountBasedExpenseLineDetail` but not `JournalEntryLineDetail`. Expected object matching otherwise accepts additional keys. Thus a journal approved without Class can gain an external Class and still be certified as exact return evidence.

The final test in `v5-qbo-dimensions.test.ts` creates actual AP business/return authority in isolated Convex tests, syncs an original Bill, VendorCredit, original cash payment and approved return JournalEntry through an in-memory HTTP protocol, then adds `ClassRef: {value: "999"}` to the external returned AP credit line. The approved journal has no Class on that line. `checkHolds(base, {verify: true})` returns `[]`, certifying the changed return proof. Expected: `return_correction_sync_required` and no new accounting POST. This reproduction establishes acceptance of altered dimensions; it does not claim an actual live duplicate, bank transfer or the release of an unrelated application hold.

The issue was reported immediately to Master and the C4 implementation owner with exact test paths and immutable baseline. Production was not edited. Existing non-null Class mismatch checks alone do not cover an added dimension on a previously classless JournalEntry.

## Passing independent results

- Signed Bill 77 minus 1 = 76 dollars, VendorCredit 38.5 minus 0.5 = 38 dollars. Both positive and negative cost lines retain exact Class9 for the approved store. Changing or removing any tested external Class rejects readback, creates no further POST and preserves original local receipts.
- A missing Class mapping creates a current controller hold. Restoring the mapping makes the current hold inactive while preserving its immutable historical record (`state: held`, `current: false`) and the successful receipt. Status/preview make no provider calls. Changing the mapping to Class10 after the successful Class9 export cannot overwrite the immutable operation: submit rejects `immutable_operation_conflict`, with the original receipt and one original POST intact.
- An actual governed 2,500-cent credit application after a test-seeded 2,000-cent cash return allocates exactly 500 cents of original principal and 2,000 restored principal. External zero-cash BillPayment has `TotalAmt: 0` and linked amounts Bill5, return JournalEntry20, VendorCredit25 dollars. AP outstanding is 5,200 cents. No new local journal or bank command is created. The existing held application remains held after submit and ordinary no-network inspection, and resolves only after explicit readback containing proofs for both return and application. An unrelated application's hold remains held. Retry preserves request ID and five total POSTs. Later changed application readback creates an active `restored_application_verification_required` hold without another POST.

The shared fixture here is explicit test setup, never an expected-output oracle. Expected economics and boundary rules were recorded before execution in `V5-qbo-extension-expectations.json`; the new assertions are literal independent values. QBO transport is entirely in memory. Settlement/return records are explicitly test-seeded Increase-shaped records, not actual Increase or FakeBank settlement proof for these tests.

## Historical test migration and initial diagnostics

Before migration, the retained V3/V5 QBO suites produced 2 passes and 19 failures because their configuration lacked the newly required store-to-Class mapping. The production behavior was correctly held before the older substantive assertions. Only test fixtures were updated: explicit `sf-hayes-valley -> Class9`, a synthetic Class lookup response, and Class9 in V3's exact expected Bill line. All existing monetary, permission, idempotency, unknown-recovery, privacy and no-extra-POST assertions remain. These 21 tests now pass. Their pre/post source hashes and the pre-migration results are retained in JSON; original V3 and V5 baseline reports are not rewritten.

The first new-test run also used an overly specific error expectation `external_modified_conflict` for the correctly rejected changed Class; the actual established code is `external_stale_or_changed`. The rejection matcher was extended to that code, with all economic/no-write assertions unchanged. That first 20/22 result is retained. The final 42/43 result isolates only F3; repeated runs are not added together.

## Commands

```sh
./node_modules/.bin/vitest run tests/ap-system/v3-quickbooks.test.ts tests/ap-system/v5-quickbooks.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-qbo-current-compat-results.json
./node_modules/.bin/vitest run tests/ap-system/v3-quickbooks.test.ts tests/ap-system/v5-quickbooks.test.ts tests/ap-system/v5-qbo-dimensions.test.ts tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/quickbooks-runtime.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-qbo-extension-current-results.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
```

Full test names, counts, hashes and initial failures are in `V5-qbo-extension-baseline.json`. F3 remains open at this immutable baseline. Any repair replay must be recorded additively. Current real provider setup and all live accounting writes remain Master-only; agent review is not practitioner sign-off.
