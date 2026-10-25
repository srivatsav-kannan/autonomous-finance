# Description grounding: configuration and fallback verification

Verified 2026-10-25, America/Los_Angeles. **Isolated diagnostics only; no application implementation or `/goal` was started.**

The missing description can be located on this scan using a separately attributed local OCR fallback. Adding LlamaParse raw word output alone did **not** restore its native description-cell box. Keep those two conclusions separate.

## Controlled provider rerun

Reused the unchanged archival invoice from [the prior control test](LLAMAPARSE-CONTROLS.md): 754 × 1000 JPEG, SHA256 `0536b1ee4ca22cf618e608b4aa0c8078c2f9f8ecd8eecc1716e13bee92710760`. This is a real scanned-document derivative, not a newly rasterized PDF. The prior report contains provenance and reuse restrictions. It remains a private evaluation sample, not a freely redistributable demo fixture.

Exactly one new provider job was submitted. The sole request change was adding `additional_outputs`:

```json
{
  "tier": "agentic_plus",
  "version": "latest",
  "output_options": {
    "granular_bboxes": ["word", "line", "cell"],
    "images_to_save": ["screenshot"],
    "extract_printed_page_number": true,
    "additional_outputs": ["word_bbox"]
  }
}
```

The [official layout documentation](https://developers.llamaindex.ai/llamaparse/parse/features/layout-and-bounding-boxes/) distinguishes granular grounding from raw OCR words. The [retrieval documentation](https://developers.llamaindex.ai/llamaparse/parse/guides/retrieving-results/) requires `word_bbox` at job creation to retrieve `raw_words_content_metadata`; asking an older job to expand that field does not generate the missing output. No prompt, OCR language setting, preprocessing or tier was changed. The resolved parser version was not exposed in the inspected response; `latest` is not a reproducible version pin.

Job `pjb-lfpn3gr0obrww7nvdat73o0z2z9h` completed: provider latency 22.125 seconds, submission-to-observed-completion 28.656 seconds. Existing independent expectations were copied unchanged before submission.

| Check | Result |
| --- | --- |
| Selected fields | 9/9 after the previously defined formatting normalization; 8/9 literal |
| Detail-cell content | 2/2 normalized; 0/2 literal because of HTML line breaks/currency spacing |
| Native detail-cell boxes | 1/2: amount present, description still absent |
| Raw OCR output | 142 word records, including both description lines |
| Exact description alignment against raw OCR | 0/2 lines: one transcription mismatch in each |

The raw OCR layer says `Paintinq` where the structured description says `Painting`, and `I1` where it says `11`. Both raw sequences have coordinates, but a strict matcher must reject them. The saved diagnostic records nearest candidates as **not accepted**, without silently correcting letters or numbers. This difference is consistent with a failure to align corrected structured text to the underlying OCR, but does not prove the provider's internal cause.

Native `layout_lvm_disagreement` and `possible_merged_columns` concerns persist. The native body-row box still covers only the amount; it must not be reused as a description or whole-row highlight. A byte span is not a visual location.

## Independent local OCR fallback

Used the already-installed Tesseract 5.5.2 with English data on the original image; no new provider/key, installation or image preprocessing. Query text came from the provider's description cell, not expected-answer labels. Geometry came only from actual OCR word rectangles.

| Mode | Description matching | Decision |
| --- | --- | --- |
| PSM 3, automatic page segmentation | First line exact; second contains `InstalIments` | Reject complete description grounding |
| PSM 6, single text block | Both lines uniquely match, 13/13 tokens, in correct vertical order | Accept derived line regions for this sample |

The matcher uses HTML decoding, Unicode NFC, whitespace tokenization and case folding. It does not substitute letters/numbers or use fuzzy matching. The successful sample also passes a separate literal, case-sensitive text check. Missing-token and duplicated-text diagnostics return `unmatched` and `ambiguous`, respectively. These small negative diagnostics test rejection behavior, not general OCR reliability.

Computed positions, using a top-left origin:

| Description line | Original image pixels: x, y, width, height | Provider page points: x, y, width, height |
| --- | --- | --- |
| Mouse Skin Painting Study With D-6 and D-17 | 106, 529, 286, 13 | 25.44, 126.96, 68.64, 3.12 |
| 2nd of 11 Monthly Installments | 107, 556, 198, 13 | 25.68, 133.44, 47.52, 3.12 |

The returned page frame is 180.96 × 240 points, so this image maps at 0.24 points per pixel. Both line boxes and all matched word boxes are within image bounds. Two agents visually inspected the overlay: the boxes enclose the printed description and exclude the amount. This is agent source review, not human AP review or payment authorization.

These are **derived text regions**, not native cell boundaries. Preserve two line regions instead of filling a rectangular cell around whitespace. Tesseract PSM 6 has other full-page transcription errors; use this output only to locate matching provider text, not to replace the invoice's extracted values. PSM 6 was tried after PSM 3 failed on this one sample. It has not been established as the best mode for arbitrary invoices.

## Proposed adapter behavior, not yet implemented

1. Use valid native word/line/cell grounding when available, preserving its source, granularity and coordinate frame.
2. If missing, attempt unique exact text alignment against LlamaParse raw words. Keep original token references and reject uncertain or duplicate matches. Account for raw output ordering and rotation; do not assume every raw word stream is in reading order.
3. If unresolved, a bounded local OCR fallback may supply derived regions when text matches uniquely, boxes are valid and spatial ordering is consistent. Record engine/model version, segmentation mode, source hash, page, token references, normalization and coordinate transformation. Package/pin that dependency in the future runtime; its presence on this Mac does not establish deployment support.
4. If unresolved or ambiguous, keep `location_unresolved` and offer review with a clearly labeled page/table context. Never fabricate precise geometry. Whether absent geometry blocks a workflow step must be an explicit evidence policy; geometry cannot itself authorize posting or payment.

Do not start a series of prompts merely to obtain a box. OCR language settings and photo correction address different input problems and were not tested here. [Custom prompts](https://developers.llamaindex.ai/llamaparse/parse/features/custom-instructions/) and [tier selection](https://developers.llamaindex.ai/llamaparse/parse/guides/tiers/) can affect parsing behavior; they are not a documented guarantee of complete cell grounding.

## `/goal` readiness

No additional API signup/key is required for the first implementation wave. The geometry uncertainty now has a demonstrated fallback for this specific source, but A2 remains unimplemented.

- **First authorized work: P0**, reconfirm and pin main/spec, preserve the dirty Desktop checkout, and isolate checkout/backend/ports/run ownership. Current remote main was not re-fetched during this experiment; previous recorded SHAs are observations, not permanent launch targets.
- **Then C0**, freeze shared contracts, including native versus derived geometry, missing locations, parser concerns, reviewer evidence and idempotent AP handoff.
- Load private provider configuration explicitly into the selected server runtime and select invoice-specific live/provider switches. Existing previews were not switched to live mode.
- Golden State linked documents and independent expected outcomes, parser/fallback integration, controls, accounting and document-to-AP/payment flow belong to the implementation plan. Genuine scanned PDF/TIFF variants, rotations, multipage files and XML/UBL still require coverage. AP practitioner review remains outstanding.
- Increase is an API sandbox without a required dashboard signup. Its zero balance only blocks a later funded outbound scenario. Funding, webhook verification and recovery tests were not performed here. ERP access is a later connector gate; a separate Judge/Decision API is optional.

All 18 tasks remain `pending`, with mode `prepared_not_started`. No application code, runtime switches, services, funding or transfers were changed.

## Local evidence and reproducibility

Private, Git-ignored directory: `var/ap-environment/llamaparse-grounding-20261025/`. It contains the original input, copied pre-output expectations, request configuration, job/result artifacts, raw words, native grounding, content comparison, `grounding-analysis.json`, and the isolated scripts. `local-ocr/` contains raw TSV/text, strict alignment results and `psm6-grounding-review.png`. The original source hash remains unchanged.

`compare.py` and `inspect-grounding.py` inspect saved artifacts without provider requests. Local OCR analysis likewise uses saved TSV output. Raw provider responses contain signed URLs and must remain private. The test scripts are diagnostics, not production adapters.

See [API readiness](API-READINESS.md), [control test](LLAMAPARSE-CONTROLS.md) and [initial malformed-source test](LLAMAPARSE-SMOKE.md).
