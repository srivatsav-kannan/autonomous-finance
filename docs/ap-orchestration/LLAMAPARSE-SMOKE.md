# LlamaParse provider smoke — 2026-10-25

**Two API jobs completed; extraction quality is PARTIAL. Implementation remains unstarted.** This verifies the existing credential, digital PDF input, a single-page image-only TIFF input, table output and partial source grounding. It does not verify the application adapter, AP bridge, real scanner quality or a payment workflow.

Follow-up: [clean PDF and genuine archival scan controls](LLAMAPARSE-CONTROLS.md) now distinguish content success from persistent missing description geometry. The original results below remain unchanged.

## Inputs and independent expectations

One business document was tested in two formats, not two independent invoices:

- Original `Kao_KAO-202401-001.pdf`, an APEX benchmark fixture: one 612 × 792 pt page, 3,235 bytes, embedded text and no embedded images.
- Derived image-only TIFF: Poppler 200 DPI grayscale, LZW compression, 207,766 bytes. This is a controlled scan proxy, not a genuine independently acquired scan. No artificial noise was added.

Source: [mercor/apex-accounting-harbor](https://huggingface.co/datasets/mercor/apex-accounting-harbor), revision `1662b7e4c3b04b8717f2f723df823e7b6cbe2118`, `worlds/world-9--(world_0645ad7c997c415e8c43f8de7cee2008)/filesystem.tar.gz`, member `contract_attorney_invoices/Kao_KAO-202401-001.pdf`. Local provenance records CC-BY-4.0. This is not an authenticated supplier transaction.

PDF SHA256: `ed7a603ad6de2a84d154e4dcd3e0685e48c2eedf4ab6e9ff95a9ae99fa4dcb6f`.
TIFF SHA256: `997f84013521083f2e7de8f2d4c2de95151212640e4d13bff2dd3441cfe43822`.

Source-derived expected values were written before provider output and independently checked. They are not AP practitioner-reviewed ground truth. The source has overlapping description/numeric text and an arithmetic discrepancy, making this a useful difficult case but not a representative accuracy benchmark.

## Request and observed results

Used the existing Default-project key with `POST /api/v2/parse/upload`, `tier=agentic_plus`, `version=latest`, and `output_options.granular_bboxes=[word,line,cell]`. Requested page screenshots and printed page numbers. Retrieved markdown, structured items, raw text, page metadata and the grounded-items JSONL sidecar.

The response did not expose a resolved parser version in the inspected fields; it is recorded as unknown, not guessed. Pin a supported concrete version for repeatable acceptance runs later.

| Check | Digital PDF | Derived TIFF |
| --- | --- | --- |
| API / page completion | COMPLETED; 1/1 page successful | COMPLETED; 1/1 page successful |
| Nine selected field values present in structured items | 8/9 | 9/9 |
| Invoice number | Missing in markdown/items; present in `text_full` | Present in markdown/items and grounded |
| Table header | Date, Description, Hours, Rate, Amount | Same five columns |
| Detail-row values exactly matching expected | 4/5 | 4/5 |
| Description | Truncated after “Allerton patent” | Unsupported substitution: “[Matter Name] patent litigation” |
| Detail cells with actual cell boxes | 4/5; no description box | 1/5; date only |
| Subtotal and total | Both $4,000.00, within main table | Both $4,000.00, in a separate table |
| Provider latency | 13.32 seconds | 14.12 seconds |
| Local submit-to-observed-completion | 18.35 seconds | 17.81 seconds |

The nine field checks cover invoice number, vendor, bill-to, invoice date, due date, terms, matter reference, subtotal and total. They are value-presence checks, not proof of a canonical invoice schema. The five line-cell checks are exact comparisons with the pre-recorded source values. Do not generalize these tiny counts into production accuracy.

Digital invoice number was grouped into an image labelled `logo: INVOICE`, despite being available in raw text. The PDF raw text also retains the full description with scrambled reading order; TIFF raw text is corrupted in the overlapping row. No bank-account details were invented, and the printed total was not silently corrected in either result.

## Source grounding

Both responses include page dimensions, item boxes and granular sidecars. Selected vendor/date/terms/reference and total geometries correspond to the visually inspected page regions. The TIFF invoice number has its own grounded line. Its three numeric detail cells have no precise cell boxes despite correct-looking extracted values; a table or row box must not be presented as exact field grounding.

Selected header spans in the sidecar were independently checked against UTF-8 markdown bytes. For example, TIFF invoice-number span `[16,30)` recovers `KAO-202401-001`. Do not substitute regular item `bbox.start_index/end_index` for the sidecar span contract; they are not interchangeable in these results. Preserve page dimensions and rotation when mapping geometry.

A local HTML comparison draws the provider coordinates on its returned page screenshots. The source screenshots and coordinates were inspected; browser rendering of the HTML was not verified because the browser tool disallowed local `file:` navigation. The report is an artifact, not an application UI change.

## Implications for the document-to-AP bridge

1. Require critical-field completeness and record the provenance of any raw-text fallback. Do not silently merge representations into one apparently certain answer.
2. Keep raw evidence, parsed values, normalized candidates and reviewed values distinct. A parser result is not an approved bill.
3. Treat unsupported descriptions, missing grounding and conflicting representations as review conditions. Do not invent missing cell boxes from a table rectangle.
4. Separate line items from subtotal/total rows; the same document produced different table grouping in the two formats.
5. Perform numeric checks independently: source hours `24.2` × rate `$165.00` = `$3,993`, while the printed amount/total is `$4,000`. Preserve both facts and route the $7 discrepancy through company policy and an authorized owner. This test does not authorize short-pay.
6. Record explicit missing information: no bank details are present; `$` is printed, but ISO currency `USD` is not explicit.

These are acceptance requirements for future A2/B1/B2 work, not completed implementations. Add a legible control invoice, genuine scans, multipage TIFFs, scanned PDFs, JPEG/PNG and XML/UBL cases later. Prefer schema-aware deterministic parsing for structured XML. Review decisions still need practitioner input; a model judge cannot supply that identity.

## Evidence and scope

Private local evidence lives in `var/ap-environment/llamaparse-smoke-20261025/` (Git ignored): original inputs, hashes/provenance, pre-output `expected.json`, request configuration, job IDs/statuses, raw provider responses, downloaded grounding, screenshots, `comparison.json`, parsed Markdown and `source-grounding-review.html`.

Raw provider responses contain expiring signed asset URLs and must stay private. The one-off runner can resume saved jobs without uploading again; it is a local diagnostic, not production retry or idempotency logic. No new application dependencies, API routes, AP bills, bank funding, transfers or running-service changes were introduced.

Provider references: [REST API](https://developers.llamaindex.ai/llamaparse/parse/guides/api-reference/), [parse configuration](https://developers.llamaindex.ai/llamaparse/parse/guides/configuring-parse/), [result retrieval](https://developers.llamaindex.ai/llamaparse/parse/guides/retrieving-results/), [layout and bounding boxes](https://developers.llamaindex.ai/llamaparse/parse/features/layout-and-bounding-boxes/).
