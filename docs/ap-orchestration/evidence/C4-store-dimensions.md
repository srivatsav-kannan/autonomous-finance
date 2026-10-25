# C4 exact store dimensions

Frozen source spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.

B's authoritative `9ed4ed3626a294d36324dfe4443aa54a640407c8` export now retains required `store: string | null` on each original approved invoice and credit allocation. The export already compares the complete approved journal dimensions. C4 consumes this value directly; no current unapproved candidate, supplier default, or mapping fallback selects a store. The older non-B3 export now also compares the posted journal's exact store/vendor dimensions against the approved candidate.

Bill and VendorCredit `AccountBasedExpenseLineDetail.ClassRef` is mapped from each non-null store using the explicit operator `classes` mapping. This applies equally to positive costs and negative discount lines. A deliberately null store omits ClassRef. An absent/invalid store produces controller-owned `store_dimension_missing`; a non-null unmapped store produces `class_mapping_missing`. Class identity/name/active state remain checked by the existing provider mapping verification before submit. The mapping hash and immutable plan bind the dimension. Existing operations are not rewritten when a mapping changes.

Readback rejects a changed, removed, or unexpectedly added expense-line ClassRef. Applying an already recognized VendorCredit also compares its complete immutable payload against the current authoritative recognition, including the original signed amounts and mapped ClassRefs.

Current status and preview derive mapping holds from authenticated exports plus private operator mappings without provider calls. Status returns `holdHistory` separately, retaining the original stored record and a computed `current` flag. A fixed mapping no longer contributes a stale active hold; historical receipts and hold files remain intact. Selector-specific historical mapping holds recheck that exact authenticated request, not merely its parent Bill. These checks are bounded to 32 distinct requests; unavailable authority remains held and marks status incomplete. Return/correction holds still require their existing proof rules.

## Official schema basis

Intuit's [AccountBasedExpenseLineDetail properties](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/108c0f49-5f2f-6efa-69a1-397fff17e1d4.htm) identify ClassRef as the Class associated with an expense. This supports the explicit local store-to-QBO Class mapping. It does not establish live company configuration or acceptance of this project's entire payload.

## Offline verification

- `node_modules/.bin/vitest run tests/ap-system/quickbooks*.test.ts tests/ap-system/close.test.ts tests/ap-system/cost-corrections.test.ts`
- `node_modules/.bin/tsc --noEmit -p tsconfig.tests.json`
- `node_modules/.bin/tsc --noEmit -p convex/tsconfig.json`
- `node_modules/.bin/tsc --noEmit`

Result: 101/101 tests passed across 12 files; all three typechecks and `git diff --check` passed.

The tests use synthetic backend fixtures and a local HTTP protocol double: exact signed Bill/VendorCredit ClassRef, immutable candidate independence, missing mappings/stores, explicit null, changed external ClassRef, credit application dependency mismatch, legacy journal tampering, and mapping repair with historical evidence retained. No credentials, OAuth grant, live provider calls, real ledger writes, or new services were used by this workstream. Live acceptance remains Root's separately authorized validation gate.
