# V5 QBO repair — exact JournalEntry Class readback

**V5-QBO-F3 is closed for the reproduced and inspected scope.** The unchanged independent failure now rejects an added external JournalEntry Class and retains `return_correction_sync_required`. The repaired bounded run passes **47/47** across six files: four new independent dimension/restored-credit probes, 21 migrated historical independent probes and 22 implementation-owner regressions. Root, backend and test TypeScript checks all exit 0.

The failing production baseline `3c834ae` and evidence commit `c3a42e4ab94eff8c8ec1a62b604f21ed061a9956` remain unchanged. This separate additive branch replays only owner fix `d37071fbb1321ed7132729638c64e663d37678a9`, as `59abb13eae708119284ad751456876820e775d4b`. SHA256 verification confirms every independent QBO test, helper and frozen expectation is byte-identical to the failing evidence commit. Complete test names, raw-result hash and source hashes are in `V5-qbo-repair.json`. Spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

The fix moves the special Class-presence check into recursive object matching. An unexpected non-null ClassRef is rejected at the matched object level regardless of whether it is an expense detail, JournalEntry detail or top-level entity. Expected Class values continue to compare recursively. The owner regressions additionally exercise changed known JournalEntry Class, unexpected Class on a classless liability line and at top level; ordinary MetaData/domain additions still pass. Existing exact signed Bill/VendorCredit dimensions, current mapping versus immutable history, no-write mapping conflicts, restored-credit readback release, lost response and original request identity assertions all remain passing.

```sh
./node_modules/.bin/vitest run tests/ap-system/v3-quickbooks.test.ts tests/ap-system/v5-quickbooks.test.ts tests/ap-system/v5-qbo-dimensions.test.ts tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/quickbooks-runtime.test.ts tests/ap-system/quickbooks-close.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-qbo-repair-results.json
./node_modules/.bin/tsc --noEmit --pretty false
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
```

This is independent agent engineering verification using isolated actual AP backend code, simulated humans and in-memory QBO protocol. The accounting tests' Increase-shaped settlement/return records remain explicitly seeded test evidence. No real provider request, shared service, private credential or canonical registry was accessed. This closes the local F3 defect and verifies the assigned dimension/restored-credit paths; it is not practitioner sign-off, a real Auth0 test, live QBO acceptance or a full-repository pass. Earlier V5 checkpoints have distinct baselines and overlapping suites, so their counts must not be summed into one unique total.

Only this report/evidence commit and baseline test/migration commit need integration when the owner production fix is already present. Do not replay the verifier's duplicate production cherry-pick.
