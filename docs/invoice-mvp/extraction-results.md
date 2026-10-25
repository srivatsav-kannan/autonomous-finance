# Invoice extraction follow-up

Verified application: `3645c003e2463f1db28ca23ef78a154f9890ec5c`, based on main `27680f6`. The additive [protocol](extraction-validation-protocol.md) was committed before the new application run. [Machine-readable evidence](extraction-results.json) records source identities, hashes, counts and restart results.

## What improved

Printed text extraction now handles PDF page wrappers and letterheads, labels on separate lines, common invoice/credit labels, registered customer aliases, and negative or parenthesized credit totals. Exact integer arithmetic preserves cents even at the safe-integer boundary. Evidence references quote the actual title, identity and amount fields rather than only the beginning of the source.

The extractor distinguishes final totals from subtotals and balances due, flags arithmetic inconsistencies, and refuses conflicting totals, customer identities, mixed currencies and multiple document identities. It does not repair ambiguous OCR digits or infer missing totals. Oversized competing financial fields also remain conflicts. The backend independently re-extracts recognized text layouts before accepting an inclusion; a caller cannot select a subtotal merely because that number appears somewhere in the source.

Complete printed candidates use deterministic extraction even with an optional model configured. They retain review warnings. Newly supported layouts require human approval under the existing narrow server-side routine grammar. A bare dollar symbol raises a specific USD confirmation warning. Model-origin proposals still require human approval; no budget or model adapter behavior was relaxed.

## Measurements

| Check | Result |
| --- | --- |
| Public development regression corpus | **13/36 before → 36/36 after** |
| Eligible original-benchmark documents with exact persisted customer/number/amount candidate | **107/107** |
| All financial candidates with exact printed fields | **109/109** |
| Ineligible duplicate/superseded sources with financial candidates | **2**, both awaiting review; **0 accepted effects** |
| Original scorer, accepted customer net totals | **0/18** |
| Original source versions retained, including original bytes/text | **148/148** |
| Provider calls / API spend | **0 / $0** |
| Full deterministic run wall time | **61.569 seconds** |

The 36 fixtures were written alongside the implementation and are development regressions. The original benchmark is previously seen. These are not unseen accuracy or production-readiness claims. The supplemental field score reads persisted application proposals after the run, using evaluator-only keys; it does not replace the official scorer or feed answers into the application.

The final benchmark workspace contains 32 excluded supporting sources, 112 cases needing review, four missing-evidence cases, zero pending cases and zero recorded financial documents. No human decisions were supplied. Consequently, official accepted-total accuracy remains 0/18. Correctly extracted fields are useful review candidates, not established accounting treatment. Duplicate/revision disposition still needs work.

The local 4 MiB/s write-rate limit caused transient import/processing retries. The run settled, retained every source and produced no duplicate effects. Sustained production throughput has not been established.

## Operator and durability verification

An isolated browser uploaded a public four-source bundle containing a letterhead invoice, a signed credit, a contradictory invoice and a customer registry. The operator inspected and accepted the two supported proposals. Gross $1,045.25 minus credit $45.25 produced **$1,000.00**, with exactly two contributions and two decision receipts after replay. The contradictory total stayed Evidence missing with acceptance disabled. Refresh preserved the result; browser console errors were zero.

Both owned gateways and the actual local Convex process were stopped, their ports verified unbound, and the same database restarted. The benchmark persisted-state comparison passed. The browser workspace retained its two accepted contributions, two decisions, $1,000 total and unresolved conflict exactly. No inference ran during restart. The browser flow began at `d75aa1b`; the final oversized-field guard was verified by regression tests and a fresh full benchmark at `3645c00`, followed by browser/API and restart checks at that final source.

Checks pass: **849 repository tests** (four intentionally skipped), all application/backend/test TypeScript checks, **31 Python evaluator tests**, and the console production build. The build retains its existing bundle-size advisory. No UI components were changed.

## Reproduction

```sh
npm ci
npm run invoice-mvp:test
node --import tsx scripts/invoice-extraction-check.ts
# Historical parser comparison; this baseline is dependency-free except erased types.
mkdir -p var/invoice-mvp/extraction-validation
git show 27680f6:src/invoice-mvp/parser.ts > var/invoice-mvp/extraction-validation/parser-before.ts
node --import tsx scripts/invoice-extraction-check.ts \
  --baseline-module var/invoice-mvp/extraction-validation/parser-before.ts
```

Use the [existing deterministic HTTP evaluator](../../evals/invoice-mvp/README.md) with a fresh run, clean source attestation and `--cohort post-fix`. Start the local backend with `--codegen disable` when evaluating the checked-in generated types; automatic regeneration can otherwise invalidate the clean-source attestation. Then run both `evals/invoice-mvp/score.py` and `score_extraction.py` with `--run`, `--upstream`, and a new private `--out` directory. Never reuse a paid run or budget ledger.

Private final artifacts are `extraction-3645c00-original`, `extraction-3645c00-original-score`, `extraction-3645c00-original-fields`, and `extraction-3645c00-restarted` under the established evaluator-private directory. Earlier successful `d75aa1b` artifacts and two pre-import dirty-attestation failures remain preserved and separate; failed setup attempts are unscored. No old report was overwritten.

Next accuracy work should measure a newly frozen unseen document cohort, especially customer aliases, OCR damage and competing revisions. Raw PDF/OCR extraction is still upstream-supplied; there is no new OCR, held-out or live-model score. Local simulated identity and throughput limits remain separate production gaps.
