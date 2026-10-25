# V6 independent closure and combined replay

Production repair baseline: `2154234` (includes D fix `85459cc0cebc97468b2143e3d65525afbcb7e22a`). Verifier replay HEAD before this report: `cafb9b0034df5e8186aa9ea16090cbda29dfd9dc`, adding only independent extension tests/evidence from `50d0970`. Original cost baseline remains `852d835` / report commit `6b4b86c`; original bootstrap/grouped-credit baseline remains `1cd4cc5` / report commit `50d0970`.

**Result: 55 / 55 selected tests pass; root, backend and tests TypeScript checks pass.** This single replay includes 19 independent tests and 36 owner tests. Do not add earlier baseline/extension counts to this count. Every independent test file is byte-identical to its recorded baseline SHA256; neither failing financial assertion was changed for the repair.

- **V6-F1 closed:** UI builder now aggregates signed reversals by exact account/store, rejects unsafe aggregate cents and compares against the current signed remaining position. The unchanged actual-state probe now rejects expense credit3651 minus discount debit50 against expense balance3600. The unchanged valid boundary3650 minus50 still passes, posts the expected credit and leaves expense0/inventory3800. Backend forged-overdraw rejection remains atomic.
- **V6-F2 closed:** credit form now has an explicit posting date, retains the original document date and existing context includes that date. The unchanged credit date-control assertion passes. Actual backend still rejects an older date and accepts the explicit later date. Existing mounted context-invalidation test passes; this test covers the real cost component with parent-context changes, not a live end-to-end credit workflow.
- Bootstrap and grouped-credit independent tests continue to pass on the repair baseline. The former owner fixture `allocations[].store` type omission is corrected with explicit `null`, so the complete tests typecheck now passes.

Reproduction from the verification worktree:

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v6*test* tests/ap-system-cost-ui.test.tsx tests/ap-system-close-transport.test.ts tests/ap-system/sandbox-bootstrap.test.ts tests/ap-system/credit-application-read.test.ts tests/ap-system-correction-ui.test.tsx tests/ap-system-correction-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v6-repair.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

`V6-repair-results.json` records full source SHA, exact test identities, current hashes and original-hash equality checks. The local dependency symlink is removed after verification; tests/evidence only are committed. No production implementation, canonical registry, existing backend or browser service was modified by this verifier.

Evidence limits remain unchanged: these are independent engineering tests using isolated in-memory backend, mocked identity/protocol, synthetic private setup and mounted browser components. Auth0 has not been configured by the user and no real login is asserted. No new Increase or QuickBooks provider calls were made. Actual AP/accounting practitioner review remains an external acceptance item; agent review is not its sign-off.
