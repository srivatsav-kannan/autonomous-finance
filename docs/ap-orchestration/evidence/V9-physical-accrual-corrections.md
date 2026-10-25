# V9 physical accrual corrections

Scope: E04 defects F1/F2, implemented on integration `471560255198452bf3919f3cc7eb8f42576f589c`. Specification SHA remains `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. This is owner implementation and local component evidence; independent acceptance remains with V/Master. No live HTTP, provider, credential, payment, or practitioner action was performed.

## Defects and correction

- **F1 — wrong supplier accrual:** physical-identity validation checked the source/review/line but omitted the accrual's supplier. `validateAccrual` now requires both the immutable catalog supplier and the mapped invoice supplier to equal the requested supplier, raising `physical_accrual_supplier` before accounting effects. The existing shared validation path runs for proposal and final approval. A separately onboarded, otherwise valid supplier cannot use another supplier's receipt.
- **F2 — cross-period physical identity loss:** October excluded a November invoice from current source cases; the standalone-source fallback reconstructed receipt capacity from historical accruals using only hash/SKU/unit. Distinct 0.5 and 1.5 physical lines collapsed. The fallback now finds the immutable original-hash catalog and retains **all** its physical lines, including any unaccrued sibling, with exact physical IDs and frozen capacity. Existing as-of invoice consumption and net accrual/reversal coverage then remain separate per physical line. Inconsistent historical accrual supplier/identity/capacity produces `received_source_conflict`.

The patch changes only `convex/lib/apSystem/accruals.ts` and `convex/lib/apSystem/periodView.ts` in production. It does not rewrite posted rows/journals, change contract/API shapes, or touch E02 dimension allocation policy/propagation. No additional UI operation is required. The current accrual form still uses parser `lineId` plus explicit `identity.reviewId` and `identity.physicalLineId`.

## Exact accounting checks

The original has two KALE-24 receipt lines: north 0.5 case and south 1.5 cases, each at 3,850 cents/case, with the invoice dated November 2. October 31 accruals are 1,925 and 5,775 cents. Expected and locally measured aggregate journal effect:

| Account | Debit cents | Credit cents |
|---|---:|---:|
| 5000 cost | 7,700 | 0 |
| 2010 accrued liability | 0 | 7,700 |
| 2000 AP | 0 | 0 |

No bill is recognized in this scenario. October can close with both lines accrued. Missing south, only 0.5 of south accrued, or fully reversed south remains `received_not_invoiced` on the south physical ID and `close_not_ready` on attempted close. A seeded historical wrong-supplier accrual remains an explicit source conflict. These are synthetic company-policy/component outcomes, not practitioner signoff.

## Reproduction and validation

Copied the unchanged independent V9 files temporarily from the verification worktree; the originals were never modified:

| File | SHA-256 |
|---|---|
| `v9-physical-fixture.ts` | `33d6b91aecb8a048eccd80b27f3a3fb15e135fbe7f7cb0e5df8c3752afbd024a` |
| `v9-physical.test.ts` | `48216f5a08aab3a607801af4d2bb1c674dbc02a1b972c8bf8e560548348f1f6f` |
| `v9-accrual-close.test.ts` | `4e66b947339a7cb6ca4faf3fc9f301885b51fc10194546606822eca67fad6fea` |

Before patch: the 15 original probes produced **13 pass / 2 fail**, exactly F1 wrong-supplier acceptance and F2 cross-period false blockers. After patch: **15/15 pass**. The temporary copies were removed before commit; six owner regression cases and a fixture adapted from V9 remain committed under `physical-accrual-regressions.test.ts` and `physical-accrual-fixture.ts`.

Combined local convex-test run: **12 files, 119 tests pass**:

```text
npx vitest run tests/ap-system/physical-accrual-regressions.test.ts tests/ap-system/physical-lines.test.ts tests/ap-system/close.test.ts tests/ap-system/close-capacity.test.ts tests/ap-system/v5-close.test.ts tests/ap-system/cost-corrections.test.ts tests/ap-system/local-dimensions.test.ts tests/ap-system/quickbooks-dimensions.test.ts tests/ap-system/quickbooks-close.test.ts tests/ap-system/quickbooks-close-runtime.test.ts tests/ap-system/v9-physical.test.ts tests/ap-system/v9-accrual-close.test.ts
```

`npm run typecheck`, `npm run typecheck:backend`, `npm run typecheck:tests`, and `git diff --check` pass. This includes E02 local and QBO dimension regressions without changing their production logic. Next action: Master integrates the narrow commit; V independently replays its frozen probes.
