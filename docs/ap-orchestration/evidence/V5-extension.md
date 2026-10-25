# V5 extension — corrected costs, period sync authority and cancellation reconciliation

Independent engineering review found no new actionable product defect in this bounded extension. **64 distinct tests pass**: 33 focused extension cases, including **10 newly authored independent probes**, plus 31 relevant prior close/credit regressions. Backend and test TypeScript checks both pass. This is independent agent verification, not AP practitioner sign-off or live Auth0/Increase/QBO acceptance.

## Immutable scope

The extension branch is frozen at test/evidence baseline `45ca97f4e83b18b9c3ceae0c048e5849161b3e3f`. Production starts from `41cbbb963f5e4cdc7165472a4806c0e5fed507ee`, which includes `4ff9be5a55321b3e1cf1f94c99574897de4ba127` and the F1 repair. It adds exact owner patch `9ed4ed3626a294d36324dfe4443aa54a640407c8` as `b997879`, and previously verified F2 patch `78532b33f0c5752525c7a2f9c148c92887bf6387` as `071bc99`. Existing V5 reports are preserved by test-only cherry-picks. The old-baseline null-link fixture adaptation is intentionally not carried here; this production base supports nullable case-less links.

Spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contracts `ap-evidence-v1` and `ap-business-v1`. Expected arithmetic and authority invariants were recorded in `V5-extension-expectations.json` before execution. Complete test names, raw-result hashes and test-source hashes are in `V5-extension.json`. Subsequent store/Class mappings and restored-credit sync patches are excluded and separately assigned.

## Independent results

Three public-flow corrected-cost cases exercise actual AP mutations and export queries:

- Original expense 7,700 is reclassified 3,000 to inventory, then 500 of inventory to prepayment. Positions are exactly expense 4,700 / inventory 2,500 / prepayment 500. The explicit first credit reverses 850 / 2,500 / 500, leaving expense 3,850. A second 3,850 credit clears cost and AP. The route requires owner plus finance, retry is idempotent, export preserves exact stores/accounts, the original journal is unchanged, and there are five journals, one bill and zero payment commands.
- A pending corrected-credit plan becomes stale after a one-cent reclassification and its exact reverse. Current account balances return to the same values, but the immutable history/snapshot has changed. Final approval rejects; a fresh explicit plan succeeds. This guards against using balance equality as a substitute for unchanged authority.
- A 7,700 accrual is reclassified 3,000 to inventory, then 1,000 to prepayment. A 3,850 manual reversal splits its one original allocation into 850 / 2,000 / 1,000. The invoice then reverses only the residual accrued unit using 3,850 against expense, while recognizing the full 7,700 invoice. Stored original allocation indices are `[0,0,0]` then `[0]`; capacity is not minted by the split. Final GL is expense 7,700, AP credit 7,700, inventory/prepayment/accrued zero, six journals and zero commands. Missing correction plans and excess reversal units reject.

Two period-runtime cases exercise actual authenticated backend export with simulated human identities:

- Status and preview derive an approved 77-dollar debit to expense and credit to accrued liability, preserving the store Class. Both make zero provider calls, expose no synthetic private client/secret values, and create no operation files. Retiring the human then prevents both status and preview, despite previously valid readiness.
- An explicitly synthetic Increase-shaped scope and in-memory QBO HTTP transport exercise the real bridge/dispatcher. Initial preview and submission load use one configured human; the final before-write export uses another valid configured human. The bridge rejects `submission_identity_changed`, issues no provider POST, retains attempts 0 and a prepared operation, and records no submission authorization. Provider GETs here are mocked protocol responses, not real QBO requests.

Five cancellation cases execute a real public request/approve/cancel followed by a replacement through FakeBank dispatch and settlement. With no evidence of an old send, the case is matched while retaining both command IDs. Each independently introduced contradictory old-command marker—attempt count, first-attempt timestamp, provider transfer ID or linked transaction—keeps aggregate reconciliation unmatched. Every case retains one actual FakeBank transfer and two journals. The contrary markers are deliberate test-owned history probes, not claims that a canceled command was actually sent.

## Inspection and regression limits

Inspection covers corrected cost reconstruction and journal hash checks, original share identities, signed capacities, correction reachability, current policy/treatment/store validation, snapshot and date checks, atomic credit/accrual application, and authoritative export. Posted historical cost facts remain facts; new actions still require current approval. Correction journals cannot become fresh capacity roots. The period bridge uses a request-owned human client, strict action/application selectors and required preview hash at the HTTP boundary; before-write code rereads exact backend authority. Existing transport regressions cover session/origin checks, rejected identity/scope injection, local-write refusal and malformed selectors.

The root reconciliation patch only filters canceled commands proven to have no send attempt or linked activity, preserving full history and unmatched contrary evidence. These tests verify that projection boundary and actual replacement execution; they do not certify every possible provider-history state.

The first runtime test execution had five fixture errors: the new worker lease token text was shorter than the existing minimum 16-character contract, so dispatch never began. Only that synthetic token text was lengthened; no product code or expected result changed. The initial failed output is retained in the JSON. The full 33-case rerun passed, followed by 31 prior cases. Repeated exploratory runs are not added to the 64-case total.

## Commands

```sh
./node_modules/.bin/vitest run tests/ap-system/v5-corrected-cost.test.ts tests/ap-system/v5-reconciliation.test.ts tests/ap-system/v5-close-runtime.test.ts tests/ap-system/cost-corrections.test.ts tests/ap-system/case-reconciliation.test.ts tests/ap-system/quickbooks-close-runtime.test.ts tests/ap-system/quickbooks-close.test.ts tests/ap-system-close-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-extension-results.json
./node_modules/.bin/vitest run tests/ap-system/v5-close.test.ts tests/ap-system/close.test.ts tests/ap-system/v5-governed-credit.test.ts tests/ap-system/v4-credits.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-extension-prior-results.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
```

All AP data is isolated `convex-test`; provider effects are FakeBank or in-memory HTTP. The transport regression uses its own ephemeral loopback test listener, never a shared service port. No private credential, live backend/provider or canonical registry was touched. Original V3/V4/V5 evidence remains preserved. Current credential setup, actual external writes, browser flows and practitioner review are Master/external acceptance responsibilities and are not inferred from this result.
