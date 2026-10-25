# V9 — independent E04 backend baseline

Independent agent engineering review of immutable integration `55f1efe815f68ec86719b21fdd3f7ef00370a93e`, containing E04 backend `3242bf6d64d72c2be6ec21a4feefe755f21a265a`. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. No provider, live backend, private credentials or registry changes. This is not practitioner sign-off or E04 browser acceptance.

**35/37 checks pass:** 18/20 independent tests and all 17 owner regressions. Root/backend/test TypeScript checks pass. Two actionable findings were reproduced through public backend operations and sent to Master/B before repairs. Both remain open at this frozen baseline. Exact names, source/test hashes and output reference are in `V9-E04-baseline-results.json`.

## Independent expectations

One original receipt contains two actual synthetic receiving lines: north **0.5 case**, south **1.5 case**, both KALE-24. At 3,850 cents per case, the independent expected costs are **1,925 + 5,775 = 7,700 cents**. Parser labels, ordering, file/source renaming, splitting north into 0.25 + 0.25, or merging rows into 2 cannot alter either physical line's capacity. Consuming north twice must fail even while aggregate receipt/PO capacity remains. Separate invoices may legitimately consume north and south. Returns use a separate original/purpose and never refill receiving capacity.

A physical receipt supports only its supplier. Invoice and accrual portions must share exact physical identity; invoice-triggered reversals must discharge the selected physical sibling, while unrelated siblings retain their accruals. Manual reversals reopen accounting coverage but do not erase original received obligations. A period with both physical lines fully recognized or accrued must be closable after other reconciliations, even if the expected invoice is dated in the following period. Current human and case/source authority must be repeated at final posting. A safe hold on unsupported migration is a negative boundary, not successful migration coverage.

## V9-F1 — wrong-supplier mapped accrual posts (P1)

`convex/lib/apSystem/accruals.ts`, mapped-identity branch around lines 91–112.

Reproduce with two independently onboarded suppliers: retain and approve the original north/south receipt catalog for `golden-state-produce`; submit an accrual naming `other-supplier`, the Golden State original and approved physical mapping, north quantity/capacity 0.5, and 1,925 cents of correctly reconciled allocations. Public `apClose:propose` and human `apClose:vote` both succeed. The negative test expects refusal before any accounting effect.

The branch verifies `a.supplierId` has a current supplier and independently verifies the catalog against the mapped case, but never requires `a.supplierId === catalog.supplierId`. Thus a valid unrelated supplier receives the accrual attribution. The unmapped branch already requires the receipt supplier to match. No cash transfer is involved in this reproduction. Required repair: bind the proposed accrual supplier to the catalog/mapped source supplier at proposal and final posting validation.

Test: `rejects an accrual posted for another supplier against the first supplier physical receipt` in `v9-physical.test.ts`.

## V9-F2 — complete cross-period coverage falsely blocks close (P2)

`convex/lib/apSystem/periodView.ts`, standalone/accrual-derived receipt fallback after the source-case receiving loop.

Use a field-reviewed invoice dated **2026-11-02** with the same original receipt. Approve physical mapping; publicly post October 31 accruals for north 0.5 (1,925 cents) and south 1.5 (5,775 cents), each naming the expected November case. Both receipt portions are fully accrued in October. October `apClose:view` nevertheless returns `received_source_conflict` and `received_not_invoiced`, both keyed only by `[original SHA, KALE-24, case]`.

The November case is excluded from October `sourceCases`. The fallback then derives receipt capacity from accruals without `physicalLineId`, colliding 0.5 and 1.5 capacities, and fails to match the physical accrual coverage. The independent positive test expects no receiving coverage blocker and then attempts an actual period close. Same-period fully recognized actual close already passes, so a general close fixture failure is excluded. Required repair: carry the original catalog and physical identity through out-of-period/accrual-derived coverage; retain per-line as-of accounting and the existing partial/reversal holds.

Test: `permits full October physical accrual coverage when the mapped invoice is dated in November` in `v9-accrual-close.test.ts`.

## Successful paths and negative boundaries

- Successful new invoices consume both physical siblings across merged, split-again and reordered parser forms, producing exactly 1,925 and 5,775 cents. One previously merged parser form later splits north into two quarter-case rows and still recognizes the legitimate north remainder. Final capacity view shows both original lines fully consumed and no remaining quantity.
- A duplicate half-case fails specifically at physical-line capacity while aggregate receipt and agreement still have spare units. Two concurrent final approvals for that half-case result in exactly one bill/journal. Identical original bytes cannot create a second catalog; partial merged allocation must sum exactly.
- A same-case parser revision invalidates its old mapping; a fresh exact mapping to the existing catalog permits recognition. Another case's mapping cannot be reused. Policy revision invalidates an unapproved mapping. Remapped reviewer identity blocks final business approval; retired reviewer blocks a new payment request without rewriting recognition.
- Both physical siblings can accrue separately. Invoicing north rejects a south accrual application, then correctly reverses north only. A manual half-case reversal of south followed by its valid reaccrual and later invoice applications leaves expense 7,700, AP 7,700 credit, accrued liability zero. The test concerns invoice-triggered **accrual reversals**; it does not claim standalone cancellation of an already posted invoice.
- Full repeated-SKU recognition plus an actual supplier statement review and opening reconciliation reaches a closed period with unpaid AP 7,700. An explicit physical accrual reversal reopening uncovered capacity prevents actual close.
- Separate return original: north and south credit notes recognize 1,925 + 5,775; duplicate north return is denied; merged representation remains valid; original receiving capacity remains consumed. Receiving original cannot be relabeled as return capacity.
- Historical untagged invoice consumption and accrual both produce `physical_legacy_usage`; accounting remains unchanged. This verifies a hold only; no migration capability is claimed.

## Reproduction and remaining bounds

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v9-physical.test.ts tests/ap-system/v9-accrual-close.test.ts tests/ap-system/v9-credits-history.test.ts tests/ap-system/physical-lines.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v9-e04-baseline.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

Synthetic retained text originals and explicit simulated humans were used; no claim about real receiving activity, PDF page geometry or OCR accuracy. The locator contract uses global extracted-text offsets and checks that a page exists; precise PDF-coordinate provenance remains outside this E04 test. Standalone-only originals cannot positively obtain E04 case-bound mappings here; untagged historical usage is not migrated. Mixed-unit/price merges and unsupported source extraction remain held. D's pending HTTP/UI work and A's dimension work are outside this immutable baseline review. Prior V8/V7 artifacts remain untouched.

Before freezing these results, two independent fixture construction errors were corrected: parser-row selection now checks a label suffix rather than a word also present in an invoice name, and explicit case revision advances candidate.revision. Neither was reported as a product defect. The dependency symlink points read-only to integration node_modules; temporary evidence is under `/private/tmp`.
