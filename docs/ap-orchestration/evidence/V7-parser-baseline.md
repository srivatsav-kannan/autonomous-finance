# Independent score of the initial four actual parser jobs

**The initial actual run does not pass end-to-end extraction: 0/4 complete candidates, 0/104 candidate fields.** The provider's returned markdown contains all **104/104** expected facts correctly. The adapter retains **75 correct / 2 wrong / 27 missing** field evidence facts, with **72/104** accepted under the strict geometry contract. These are three separate layers; 104 provider text facts and 77 retained records must not be presented as 104 or 77 successful candidate facts.

## Immutable inputs and method

Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. Original fixture source `ac43d826`; original-first independent derivation commit `769df9f`, hash `5ebaeb9b6d64e272ba7284b80cb64c0c8adc6839f73617b700a41942e9632f12`. That derivation was committed before the first evaluation-key read. Original key review and rendering are preserved in `V7-heldout-review.md`; no original, key or authoring file was changed here.

The actual provider jobs ran at harness/runtime baseline `6a0294197208fc891e715ea556d1a9b5e9f40aab`; A's published run evidence is `0b673abb4836bf615942d2f93c941af2e4fb74ac`. This review reads the existing private results; it starts no provider requests. Provider markdown/HTML was independently read by field and labeled table column, with whitespace normalization for wrapped descriptions and exact decimal/cents arithmetic. `tests/ap-system/v7-score-heldout.py` reproduces the comparison using only the earlier independent original derivation, not the runtime's answer key or authoring generator.

All **69** private artifact files were independently rehashed against their content-addressed filenames. The four `initial.intake.private.json` files equal their earlier offline `replay.intake.private.json` byte for byte. Original source hashes match the four independently frozen originals. `V7-parser-baseline-score.json` records all 104 rows, expected values, provider quotes, candidate/retained values, geometry decisions, source/intake/provider hashes and job IDs; signed URLs and raw provider envelopes remain private.

## Separate scores

| Original presentation | Facts | Provider content | Complete candidate | Retained correct / wrong / missing | Strict geometry |
| --- | ---: | ---: | ---: | --- | ---: |
| Copper Valve native | 29 | 29 | No | 26 / 1 / 2 | 24 |
| Copper Valve scan | 29 | 29 | No | 11 / 0 / 18 | 10 |
| Harbor Thread native | 23 | 23 | No | 16 / 1 / 6 | 16 |
| Harbor Thread scan | 23 | 23 | No | 22 / 0 / 1 | 22 |
| Total | 104 | 104 | 0/4 | 75 / 2 / 27 | 72 |

The frozen 104-fact denominator covers 11 headers per original and six fields per line, matching lines by unique SKU rather than parser line ID. Native and scan versions represent two invoices, not four economic obligations. Correct content remains in the denominator even where geometry is unresolved. Provider presence is diagnostic semantic content, not a claim that LlamaParse supplied a complete AP candidate or that every provider token is error-free.

## Findings retained for repair

**V7-P1 / P2 priority: adapter loses correct provider facts and merges adjacent headers.** Copper native `invoiceNumber` becomes `CV-9017  Due Date: 2026-11-06` and omits invoice/due dates. Harbor native `extractedSupplierName` includes the adjacent `Invoice Number: HT-2408`, with six missing headers. Copper scan's table title/header and spanned cells cause all 18 line facts to be omitted. Both Harbor variants miss the 1,250-cent freight while the returned labeled HTML contains it. All four correctly remain incomplete/null, so no downstream approval authority is inferred. Two wrongly captured values are marked supported; their large rectangles cover the overcaptured text, which does not make them correct invoice-field evidence.

**V7-P2 / P2 priority: multiline native cell collapses two lines into one rectangle.** Copper native `LAB-PL` description has correct content, but the adapter emits a single cell rectangle `[102.36,237.82,156.92,22.27]`. The provider's hashed raw cell contains two `grounding.lines`, and the original visibly prints two lines. `CONTRACTS.md` requires separate regions for multiline evidence. This one fact is not accepted under strict geometry scoring until distinct line/word regions are preserved.

The remaining two geometry failures are Copper currency fields: content USD is correct but the adapter explicitly reports `local_ocr_ambiguous` and no precise regions. Those remain unresolved, not fabricated successes. Together with 27 missing and two wrong-content facts, these account for all 32 facts outside the strict geometry numerator.

## Geometry validation and limits

For every retained field, independently checked exact source ID/revision/hash, one-based page, original point dimensions, rotation, top-left identity transform, bounded region coordinates and hashed raw/config/token/raster references. Native regions must match the correct raw provider word/line/cell; derived rectangles must match identified same-page raw/OCR words and their exact envelope, with no digit substitution. Native cell/line records may have empty tokenRefs but must retain an exact direct raw-region match; this is distinct from deriving an ungrounded rectangle. All four originals were re-inspected with region overlays, confirming the two adjacent-field overcaptures and the multiline collapse.

The status `native` on a scan means the provider's supplied grounding channel. It does not claim a native PDF text layer: both scan PDFs remain image-only. Local Tesseract-derived exact matches remain explicitly derived, with their own hashed raster/config/token provenance. Provider requested version is `2026-09-28`, resolved version remains null; this is not claimed as a reproducibly resolved provider build. The score does not claim pixel-level IoU against a manually authored gold box dataset.

## Reproduction

Private root: `/Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-20261025`. Run from repository root:

```sh
python3 tests/ap-system/v7-score-heldout.py . /Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-20261025 /private/tmp/ap97-v7-parser-score-reproduced.json
```

Scorer default input is `initial.intake.private.json`; optional final argument chooses a separate replay filename without replacing baseline data. Review overlay PNGs are private intermediates in `/private/tmp/ap97-v7-originals/*-overlay.png`. Future mapper repair must be scored separately on the same cached provider artifacts with new code/replay hashes, preserving this baseline and all 104 facts.

This is an independent agent engineering review of two project-authored supplier/layout controls. The author saw the mapper; the sample is not blind, not production supplier evidence and not a representative accuracy benchmark. No supporting PO/receipt/contract or human accounting review is supplied. No payment authority or practitioner sign-off is inferred.
