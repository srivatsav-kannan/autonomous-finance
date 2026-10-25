# LlamaParse controls: clean PDF and genuine archival scan

Tested 2026-10-25, America/Los_Angeles. **Provider verification only; no application implementation or workflow was started.**

The clean digital invoice passes the selected content and grounding checks. The genuine scanned invoice preserves the selected printed content but still lacks exact description-cell geometry. Therefore the previous malformed fixture is not sufficient to explain every observed limitation.

## Inputs and method

| Input | Provenance | Source review |
| --- | --- | --- |
| Clean digital PDF | [Filedone sample invoice](https://filedone.ai/sample-files/sample-invoice-pdf), explicitly fictional, CC0 1.0 | One A4 page, 1,123 embedded text characters, no embedded images. Six rows × five columns; all legible with no overlap. Line arithmetic, subtotal, GST and total agree. |
| Genuine archival scan | [RVL-CDIP mini](https://huggingface.co/datasets/dvgodoy/rvl_cdip_mini), revision `74de67da4e027265262a22d2550fd27072156d44`, train row 1405 | Borriston Laboratories invoice 1571-2 dated February 1, 1984. Actual decoded JPEG is 754 × 1000, grayscale. Printed content is legible, with scan noise, handwriting and an archive mark. |

The scan is a dataset derivative of a real archival scan, not a newly rendered synthetic invoice or the original full-resolution TIFF. Scanner model and original capture date are unknown. The [RVL-CDIP author page](https://adamharley.com/rvl-cdip/) traces the corpus to IIT-CDIP; [TREC 2007 Legal Track §2.1](https://terpconnect.umd.edu/~oard/pdf/trecov07.pdf) describes the source collection of scanned images. The mini dataset's width/height metadata is transposed for this example; use the decoded image dimensions.

The scan's rights are listed as `other` and refer to [UCSF's source terms](https://www.industrydocuments.ucsf.edu/help/copyright/). This private research/evaluation copy is not claimed to be CC0 or freely redistributable. It should not automatically become the product's published demo corpus. The clean PDF is a reusable fictional control; the scan checks real capture artifacts. Neither is a linked Golden State AP case.

Expected values were recorded **before provider results**, using independent agent visual/source review. Digital labels were also checked against the publisher's answer key. Dataset EasyOCR output was not used as truth for the scan. These are source-content checks, not human AP practitioner review or business authorization.

Both jobs used the previous configuration unchanged: `agentic_plus`, `version=latest`, word/line/cell bounding boxes, page screenshots and printed-page-number extraction. Only the input changed. Exactly two new jobs were submitted; the completed digital result was reused while the scan ran. The provider response did not expose a resolved parser version. Because documents differ in layout/content/capture and each was run once, this is a diagnostic comparison, not a controlled causal study or an accuracy benchmark.

## Results

| Check | Clean digital PDF | Genuine archival scan |
| --- | --- | --- |
| API completion | COMPLETED, one successful page | COMPLETED, one successful page |
| Selected field values, literal strings | 9/9 | 8/9; amount has an extra space after `$` |
| Selected field values, allowed formatting normalization | 9/9 | 9/9 |
| Detail-cell contents, literal strings | 30/30 | 0/2; HTML line break and currency spacing differ |
| Detail-cell contents, allowed formatting normalization | 30/30 | 2/2 |
| Detail cells with precise cell boxes | 30/30 | 1/2; description has none |
| Selected fields with direct line/cell locations | 9/9 | 8/9; installment is in the ungrounded description |
| Cell UTF-8 full-text spans | 30/30 recover returned cell text | 2/2 recover returned cell text; spans alone are not geometry |
| Provider latency | 12.79 seconds | 18.39 seconds |
| Submit-to-observed-completion | 18.36 seconds | 23.97 seconds |

Formatting normalization converts `<br/>` into a line break, removes whitespace between currency symbol and digits, normalizes Unicode NFC and collapses whitespace. It does not change words, identifiers, dates or numeric values. The raw and normalized counts are kept separate. The scan's prewritten scoring notes permitted formatting normalization; the original expected values were not changed to match the output.

The clean PDF preserves all six descriptions and the invoice number, with all 30 cells grounded. Its nine fields include vendor, bill-to, invoice number, invoice/due dates, PO reference, subtotal, GST and total. No content normalization was needed for its literal pass.

The scan preserves its invoice number, date, vendor/customer, PO reference, BLI reference, installment, remittance postcode and billed amount. The billed `$15,000.00` remains in the AMOUNT column; `$153,900.00` remains separate project context. No absent due date, payment terms, tax, quantity, unit price or ISO currency was added. This is preserved document structure, not proof that an application has selected or approved the correct payable.

## Persistent grounding limitation

The scanned description is readable and transcribed correctly, but its grounding object contains only a byte span `[0,78)`—no cell box, line boxes or word boxes. The amount cell has all three. The body-row box covers only the amount. Treating that row box as a full-row highlight would be misleading.

The provider also emits `layout_lvm_disagreement` and `possible_merged_columns` concerns for this table. Its page confidence is `0.394`; that is a provider score, not a measured 39.4% accuracy. The independently reviewed printed values are correct despite this score. Preserve both concerns and verification evidence rather than using confidence alone as a pass/fail rule.

The scan's returned coordinate frame is 180.96 × 240 points, whereas the image is 754 × 1000 pixels. Use returned page dimensions when mapping boxes. Never assume all invoices have the prior PDF's 612 × 792 point frame or use the mirror's transposed width/height metadata.

Handwritten signature/accounting annotations were not scored for transcription accuracy. OCR text is not a verified approver identity or authorization record.

## What can be concluded

- The earlier overlap-heavy fixture likely contributed to description corruption and missing numeric-cell grounding: the clean PDF reproduces none of those content failures, and the real scan retains its printed content.
- This does **not** prove every earlier error was caused by the fixture. The earlier digital invoice number was visibly readable but lost from structured items while remaining in raw text; that is still a failure of that parsing result.
- Fine-grained grounding remains incomplete even on this legible genuine scan. The observed content/geometry mismatch is a provider-result limitation the adapter must represent explicitly.
- Two successful content checks do not establish general reliability. No new software/provider choice or production-readiness claim follows from this tiny sample.

Follow-up: [configuration and fallback verification](LLAMAPARSE-GROUNDING.md) reran this same scan with raw word output. Native description geometry remained absent; a separately attributed local OCR fallback uniquely located both lines. This does not retroactively change the native-box counts above.

## Consequences for future implementation

Keep LlamaParse as the planned parser candidate, with separate acceptance gates for content fidelity and source-location coverage. The adapter must retain original bytes, raw representations, provider concerns, field provenance and missing geometry. A correct-looking field with no box must not receive a fabricated precise highlight. Any later fallback should record its method and be independently verified.

Continue to require canonical invoice validation, policy/authority checks, review and idempotent AP handoff. No need for another API key was discovered. Real scanned PDF/TIFF variants, multipage files, rotations, low quality captures, XML/UBL and linked Golden State cases still need coverage. All 18 implementation tasks remain pending.

## Reproducibility

Private local directory: `var/ap-environment/llamaparse-controls-20261025/` (Git ignored). Contains unmodified inputs, source provenance, pre-output expectations, configuration, job status, raw results, grounding JSONL, page screenshots, parsed Markdown, independent scan review and `comparison.json`. Raw results/source asset records may contain signed URLs; do not publish them.

| File | SHA256 |
| --- | --- |
| `invoice-digital.pdf` | `545655fc231453aaf2a6c60b44b3b137d506db0d1d79bff12eeef86044aedb86` |
| `invoice-real-scan.jpg` | `0536b1ee4ca22cf618e608b4aa0c8078c2f9f8ecd8eecc1716e13bee92710760` |

`compare.py` reads saved artifacts without calling any provider. The isolated diagnostic scripts are not production adapters. No app dependencies, services, configuration switches, AP bills, funding or payments were changed.

See also [the first malformed-source test](LLAMAPARSE-SMOKE.md), [API readiness](API-READINESS.md), and [provider grounding documentation](https://developers.llamaindex.ai/llamaparse/parse/features/layout-and-bounding-boxes/).
