# A3/F general mapping repair on frozen provider results

The same four cached LlamaParse results now produce four complete candidates, compared with zero in the preserved initial run. The repair uses no new provider calls, supplier/file-specific branches, original changes or answer-key inputs. Code checkpoint: `c2201a4` (full SHA in the accompanying JSON). The failed baseline remains at `var/ap97-heldout-20261025` and in the earlier `A3-F-heldout-parser` reports.

The provider had correctly returned the relevant visible content, but the previous mapper failed in four general ways:

1. Header matching recognized only line/pipe beginnings and could swallow a later label into the previous value when columns shared a line.
2. Optional-colon monetary matching treated explanatory freight prose as a competing amount.
3. Table footer handling assumed one fixed label/amount column pair, blank preceding cells and a limited total-label vocabulary. Merged note cells and displaced totals were mistaken for economic lines.
4. A spanning table title was repeated above each column label by the provider, so strict single-row header matching could not recognize the columns.

Independent baseline review also found that a wrapped description used one broad native cell box despite available line boxes. The repair now retains separate native line regions after checking full source-text coverage, ordered disjoint byte spans and separate line positions. A multiline cell without sufficient precise native line data falls back or remains unresolved.

## Supported changes and refusal rules

`document-mapping.ts` separates explicit adjacent labels, reads label/value cells from HTML or Markdown table rows, and accepts monetary statements only at exact known labels. Conflicting header values—including optional due dates—remain holds. Dates must be valid unambiguous ISO dates; invoice date is never inferred from due date. No original amount is inferred from total due, missing adjustments or accounting balances.

Line mapping recognizes a shared spanning title and optional leading title rows, then requires six unique supported columns. Duplicate aliases, changed column order, populated unmapped columns and malformed economic rows remain holds. A summary row requires exactly one known monetary label and one exact amount, with only explicit ancillary note labels before it; it cannot silently consume ordinary line data. Currency/quantity/price character substitutions are not introduced.

Arithmetic uses integer cents and exact decimal quantity multiplication without rounding fractional cents. Sum of line amounts must equal the stated subtotal; subtotal plus stated tax and freight minus stated discount must equal the stated total. Explicit freight/discount allocations use the supplied trusted coding dimensions and stated amounts. Missing coding does not invent accounts. Positive tax still requires the existing explicit reviewed allocation path. These extraction checks grant no business approval, source acceptance, supplier authentication or payment authority.

## Measured replay

| Original | Complete candidate | Field evidence records | Native | Derived | Unresolved |
| --- | --- | ---: | ---: | ---: | ---: |
| Harbor Thread native | Yes | 23 | 23 | 0 | 0 |
| Harbor Thread scan | Yes | 23 | 21 | 2 | 0 |
| Copper Valve native | Yes | 29 | 27 | 1 | 1 |
| Copper Valve scan | Yes | 29 | 27 | 1 | 1 |

All 104 field facts remain in the denominator. These are adapter classifications, not independent accuracy scores. Both unresolved fields are `currency`, with `local_ocr_ambiguous`; no exact currency box is manufactured from repeated USD tokens. Both wrapped Copper Valve descriptions now retain two native regions. Independent original-derived content/geometry scoring is assigned to V and remains separate from this engineering report. A complete candidate may still require geometry review and all downstream AP controls.

The initial provider job identities, configuration and cached state files remain byte-identical. The four repaired intakes were then replayed a second time: all four were byte-identical, with zero POST/GET calls across both repair runs. The accompanying `A3-F-mapping-repair-results.json` retains initial/repaired intake hashes, original/provider/config/token/raster references, source bindings, classifications and replay proof. Raw provider payloads remain private.

Private roots under `/Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/`:

- Initial failures: `var/ap97-heldout-20261025`.
- First repaired output: `var/ap97-heldout-mapping-c2201a4`; per-source `replay.intake.private.json`.
- Determinism check: `var/ap97-heldout-mapping-c2201a4-repeat`; per-source `replay.intake.private.json`.

Only provider `jobs/`, hash-addressed `artifacts/` and immutable comparison intakes were copied to each new private root. The existing acceptance runner was invoked in `--replay` mode, which rejects all network use and never reads the private provider file. For successful extracts, the engineering report reads `candidate.evidence`; the older acceptance runner's summary counts only `extraction.evidence`, which is empty on success. No acceptance labels from that summary were used as accuracy evidence.

## Validation and remaining limits

`vitest run src/ap-system/ingestion tests/ap-system/formats-policy.test.ts`: **93 passed**. This includes 36 new independent mapping/arithmetic tests and three multiline-geometry tests, using separate invented unit scenarios rather than the held-out answers. Existing Golden State extraction/PO/receipt and format-policy checks remain passing. Root, backend and test TypeScript checks pass; whitespace checks pass.

This is still a bounded, explicit-label USD invoice mapper. Unknown columns, ambiguous/malformed labels, unsupported taxes and inconsistent arithmetic remain incomplete. Four synthetic originals and two layouts do not establish production accuracy. No new LlamaParse request was necessary. Docker build/run remains NOT_RUN; the existing pinned Mac OCR configuration was used for exact fallback.
