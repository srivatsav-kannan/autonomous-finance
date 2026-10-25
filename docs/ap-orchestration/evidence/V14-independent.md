# V14 — independent tax accounting and historical recovery verification

**25 independent scenarios and 30 related owner regressions pass on integration `1a5dc708ef0de26fbd1f2f7f82c33f49a914ae28`.** All three TypeScript checks pass. No production defect was found within this bounded review. The verifier authored only the two V14 test files and this evidence; it did not author or change the implementation under review.

## Verified behavior

- The approved USD tax adjustment produces the exact separate JournalEntry: debit expense 3.85, credit tax receivable 3.85, retaining Vendor, Class and Department references. The plan freezes original approval, journal and submitting identity. Same-account netting, reversed movement ordering, duplicate account mappings, altered original Bill payloads and non-USD originals fail closed.
- Historical recovery uses the original immutable request and saved payload. Malformed query envelopes, incomplete counts, duplicate external records and added/removed financial dimensions never produce a successful receipt. An absent result stays unknown across repeated GET-only attempts. Prepared, rejected and conflicted operations do not become recovery candidates.
- Stale/future access, wrong environment, action substitution and mid-request journal-authority changes are rejected before token acquisition or provider access. The real authenticated backend rejects altered approved-action and posted-journal data.
- A different active reader may recover a receipt after both policy and the original submitting seat retire. The recorded original submitting identity and authorization remain unchanged. Recovery does not change local journals, Bills or banking commands. Concurrent recovery requests serialize against the same saved operation; a later invalid readback does not erase the successful receipt.
- Historical status does not obtain a token or contact the provider. Even with valid current mapping files present, retired policy does not permit new preview or submission. An explicit verify request can only read the saved operation.
- UI permission matrices keep historical preview and submit disabled despite contradictory write flags. Prepared/rejected/conflicted records expose no recovery action. Browser recovery sends only a selector and the current authenticated session. Changing login while obtaining a token prevents dispatch. The HTTP route reauthenticates the current subject, rejects a cookie from another subject and rejects caller-supplied scope, authorizer or operation payloads.
- A current submitter changing during the final authority check blocks the new JournalEntry create call.

## Evidence and reproduction

[Machine-readable results](V14-results.json) contain all 55 assertion identities, exact source hashes and the raw Vitest report hash. The independent set initially passed 20/20, then 25/25 after adding the separate UI/transport suite; the final bounded replay passed 55/55. There was no failed baseline or production repair in V14.

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v14-tax-receipt-independent.test.ts tests/ap-system/v14-tax-ui-transport.test.tsx tests/ap-system/quickbooks-tax.test.ts tests/ap-system/quickbooks-close.test.ts tests/ap-system/quickbooks-close-runtime.test.ts tests/ap-system-close-qbo-ui.test.tsx tests/ap-system-close-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v14-regression.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

## Limits

The independent tests reuse the owner's synthetic approved-tax scenario setup, then use a separately authored protocol harness and expectations. Recovery cases seed saved operation states explicitly; they are not evidence of a live first POST. The related owner regression includes the synthetic full submit/readback path. The provider transport is injected and loopback HTTP uses synthetic identities. No real provider, private credential, shared backend, active policy, mapping or user approval was accessed or changed.

This is independent agent engineering verification, not practitioner sign-off, tax advice, desktop CUA acceptance or real QBO/Increase acceptance. Root owns desktop review and the current full integrated regression. The scope remains USD and laptop web; multicurrency is a separate user-approved follow-up.
