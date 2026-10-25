# A3 structured XML and controlled format evidence

Owner `/root/p0_inventory`, parent `/root`. Branch `codex/ap-system-formats`; worktree `/Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks`; baseline `3b6baad02b012b1d850e3581b2d0092282367cee`; spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. Private storage is `var/ap97-20261025-01a1722e-a3`. Master-only registry `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json` was not edited. No backend/service/system changes were made.

## Implementation and compatibility

Added a bounded direct XML parser and declared project-owned UBL 2.1 invoice subset. It verifies expanded OASIS namespaces, explicit version/customization/profile IDs, strict allowed element/attribute structure, cardinality and order. Unknown profiles/structures and conflicting/incomplete content retain originals with null candidates and explicit reasons. UTF-8/XML 1.0 only; DTD/entity/processing-instruction rejection; byte/node/depth/time/output bounds; no remote schemas or network entity resolution. Runtime uses existing Python standard-library Expat through AP_PYTHON; no dependency manifests changed.

Positive stated taxes are mapped exactly: source subtotal1750 + line taxes80/60 = tax140, payable1890 cents; trusted coding allocations1080/810 include line tax. Fractional quantity2.5 is preserved. BigInt checks stated line amounts, unit-price base, tax sum and document totals. No jurisdiction/rate inference. Original supplier names must match trusted names/aliases to bind an ID. The fixture's C62 unit code is preserved, not guessed into a company SKU unit.

XML evidence is native+xml_path with namespace-qualified absolute element/attribute paths, source ID/revision/SHA, null page/frame and no rectangles. One logical SourceDocument completeness slot is not a physical PDF-page claim. The existing original download route can retain bytes; renderPage does not invent an XML raster. Valid XML structure does not approve a bill, establish a supplier or bypass purchasing/human/payment gates; same-backend policy verification remains a root integration check.

Raster formats retain the public API. Provider pages must match original count, unique identities and order. Native/raw artifacts are separately checked against provider page dimensions. Image coordinates are explicitly scaled into the same original pixel frame returned by renderPage; PDF coordinates stay in original points. Original A2 PDF fixtures and targeted tests still pass. See `src/ap-system/ingestion/XML-PROFILE.md` for the exact supported subset and `fixtures/ap-system/formats-v1/README.md` for provenance.

## Measured controls

All eight controlled inputs remain in the denominator: six positives passed their frozen expected content/frame checks; two negatives correctly retained null candidates. This corpus is synthetic and project-authored. Rasterized scan proxies are not genuine archival scans or a broad production reliability benchmark.

| Input | Content outcome | Location outcome |
| --- | --- | --- |
| Native PDF, prior source hash reused | 4 lines / 67860 cents / 1 page | 33 native, 2 unresolved |
| Image-only scanned PDF | 4 lines / 67860 cents / 1 page | 34 native, 1 unresolved |
| Grayscale PNG | 4 lines / 67860 cents / 1 frame | 34 native, 1 unresolved |
| Lossy JPEG quality70 | 4 lines / 67860 cents / 1 frame | 34 native, 1 unresolved |
| Two-page deflate TIFF | 4 lines / 67860 cents / both ordered markers | 29 native, 6 unresolved |
| Intentionally unreadable PNG | Incomplete, null candidate; 11 explicit reasons | 0 extracted fields; not omitted from input denominator |
| Declared UBL positive-tax profile | 2 lines / 1890 cents incl140 tax | 29 XML paths; no raster regions |
| Unknown UBL profile | Incomplete, null candidate | 29 inspectable actual XML paths; no claim of profile acceptance |

Repeated header/currency text remains unresolved rather than selecting arbitrary copies. Across the five positive raster inputs, 164/175 fields have native precise regions and 11/175 remain unresolved. Geometry and content are separate outcomes. The XML paths are not included in a raster-box success rate.

Exactly five new LlamaParse jobs were submitted. Native PDF reused the A2 job; XML made no provider requests. All hosted jobs requested agentic_plus version2026-09-28; resolved version remains null. Job IDs, source hashes, frame/raster hashes and every outcome are in `A3-formats.json`; actual config/raw/token/result artifact hashes are in `A3-artifacts.json`. Full private provider responses can contain signed URLs and were not committed. XML run measured Python3.12.14 / Expat2.8.3.

## Reproduction and checks

- `node_modules/.bin/vitest run src/ap-system/ingestion`: **53 passed**, six files. Includes the prior29 regressions, 20 XML cases and four page/frame cases. Unknown namespaces/profile, duplicates, tax/amount/currency/price-base mismatch, incomplete fields, overflow, DTD, processing instruction, malformed/oversized XML, source binding and no double entity/HTML decoding are covered.
- `node_modules/.bin/tsc --noEmit --pretty false`: **passed**.
- `AP_PYTHON=<bundled Python> node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/verify-formats.ts --live`: six positive and two negative controls passed; 5 uploads, 51 provider reads.
- Same command without env-file or `--live`: network-forbidden replay, **0 provider calls**, all eight intakes byte-identical. Recorded in `A3-replay.json`, linked to the live report hash.
- `generate.py` rerun in a separate private folder: manifest hashes and expected-profiles JSON byte-identical. All frozen originals remain unchanged after provider evaluation.
- Scanned PDF and both source pages for TIFF rendered through Poppler and visually inspected: readable tables/labels/footers, no clipping. `pdftotext` on scanned PDF returned only the page break, confirming no text layer. Fontconfig emitted its existing default-config warning; the render outputs were usable.

The full intakes are under `var/ap97-20261025-01a1722e-a3/intakes/*.private.json`. Isolated artifacts/jobs can be replayed from that storage without new submissions. Expected profiles are read only by the verifier; runtime ingestion imports no fixture/evaluation values.

## Remaining boundaries

This local component result awaits Master review and integration acceptance. It does not establish general UBL/Peppol conformance, XML-signature trust, unseen supplier-layout robustness, arbitrary TIFF compressions, rotated/skewed photos, or AP practitioner approval. Unknown profiles and unsupported tax/charge structures are explicit holds. Docker image build remains NOT_RUN as assigned; no Docker/system service was launched. Backend business-policy, browser XML source presentation and end-to-end authorization remain root-owned integration checks.
