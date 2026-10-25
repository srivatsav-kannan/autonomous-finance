# V13 — independent repair replay

**V13-F1 is closed within the tested scope: 32/32 independent tests and 67/67 owner regressions pass, with all three TypeScript checks passing.** The same 99 assertion identities ran before and after the repair. All four independent fixture/test file hashes are unchanged. The immutable failure evidence remains in `V13-baseline.md` and `V13-adjustment-baseline.md`.

Original recognition baseline: `1108afee1091554c2b58ecf8852b79f4139f06b6`. Adjustment baseline: `3ee360d747e14a45cd9e39ac0a2f22d76d1d2b77`. Root's two-file production repair: `e71228101c5eefea3fda7257ac364668bcda246c`. It was applied alone to the independent extension checkpoint, producing isolated replay runtime `2183e93891bc13664d76d641289fd1df27f6b408`. No later UI, external integration or unrelated root changes are included.

| Scope | Frozen extension baseline | Repair replay |
| --- | --- | --- |
| Initial recognition and credits, independent | 20/21 | 21/21 |
| Immutable adjustment and credit coupling, independent | 10/11 | 11/11 |
| Bounded owner regressions | 67/67 | 67/67 |
| Total | 97/99 | 99/99 |

The initial recognition gate now rejects eligibility material whose hash matches the original invoice or another current invoice. The adjustment gate obtains the original invoice hashes from the already validated immutable approval's tax facts and rejects byte-identical eligibility documents. This closes both exact reproduction paths: changing source ID, filename, delivery and document kind no longer makes the same invoice bytes independent evidence. Neither probe nor financial expectation was changed.

Passing positive sequences remain intact: explicit per-line header arithmetic and partial acceptance, cumulative original and post-adjustment recovery rounding, separate cost/tax capacity, current tax and cost snapshot binding, independent financial/tax review, prior-credit/cost-reclassification attribution, exact post-adjustment supplier returns, and single-winner final-vote concurrency. Original bills and prior journals remain unchanged; the tested adjustments create no payment commands.

## Evidence

[Machine-readable repair results](V13-repair-results.json) retain every assertion identity, original source hashes, exact runtime/repair identifiers and raw result hash. The unchanged command was:

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v13-tax-independent.test.ts tests/ap-system/v13-tax-adjustment.test.ts tests/ap-system/tax-policy.test.ts tests/ap-system/tax-business.test.ts tests/ap-system/tax-header.test.ts tests/ap-system/tax-adjustments.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v13-repair.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

This is independent agent engineering verification using synthetic documents, humans and policies in isolated `convex-test`. It does not establish statutory tax eligibility, practitioner sign-off, UI acceptance, QBO tax export behavior or live provider acceptance. No private credentials, shared backend, live provider or canonical registry was accessed or changed. The verifier's commits contain tests/evidence only; root authored the production repair.
