# Supplier original ingestion

`index.ts` is the server-side adapter. It never imports evaluation expectations, fixture facts or customer net-invoiced totals. The generic label/table mapper currently recognizes a conservative USD invoice layout with SKU, description, quantity, unit, unit price and amount. Missing/ambiguous content returns `candidate: null` with retained source/extraction evidence. Unknown suppliers stay unbound until the extracted name exactly matches a trusted legal name or explicitly supplied alias. Trusted coding is supplied by server policy, never inferred from a document instruction.

```ts
parseUpload({bytes, name, mimeType, storageRoot, idempotencyKey?,
  sourceId?, revision?, deliveryId?, kind?, provenance?, replaces?,
  explicitRevisionOf?, context?, options?}): Promise<APIntake>

combineUploads({uploads: Upload[], storageRoot, idempotencyKey,
  explicitRevisionOf?, context?, options?}): Promise<APIntake>

renderPage({source: SourceDocument, page: number, storageRoot,
  options?}): Promise<{bytes: Uint8Array; mimeType: 'image/png';
  frame: CoordinateFrame; artifact: {ref: string; sha256: string}}>
```

`context` may contain trusted supplier `{supplierId,legalName,aliases?}`, coding policy, existing source documents and purchasing evidence. New uploaded PO/receipt/contract originals are parsed into same-case purchasing evidence using their actual table values and unique invoice SKU/unit matches. No answer labels are read. The adapter does not authenticate a purchaser or receiver from printed text; review/authority is the backend's job.

`Upload` preserves caller-provided `sourceId`, `revision`, `deliveryId`, `replaces` and provenance. Otherwise source/delivery IDs derive from bytes, revision defaults to 1 and provenance is `external_private` with no permission to redistribute inferred. Explicit revision callers must load the current case and pass the intended next invoice revision and source replacement bindings. The candidate revision is the invoice source revision. A durable HTTP intake receipt must retain the exact prepared intake under its idempotency key; provider-job caching alone does not handle a lost HTTP revision response.

Bounds: one invoice, at most 10 uploaded originals, at most 8 MiB total bytes; 20 original pages, 8 OCR pages, 40 million raster pixels, 10,000 pixels per dimension, 20 seconds per render/OCR subprocess by default. Provider requests have a 30-second transport deadline, a 180-second default polling window, at most three read retries and no automatic upload retry. PDF, JPEG, PNG and TIFF are accepted; XML mapping is not implemented. Only identity orientation/transforms are supported. Rotated images/PDFs and nontrivial PDF crop/media boxes return explicit unsupported geometry/rendering rather than a misplaced highlight.

Original bytes and provider artifacts are written privately under `storageRoot`; `originalBase64` remains in the transport so backend chunk storage can reconstruct originals. The renderer verifies the exact source SHA before reading bytes; it can render solely from rehydrated base64 when the local original reference has been stripped. It renders the original locally, never trusts a provider screenshot. Normalized UI positions must use the returned frame, which is points for PDF and original pixels for images.

Grounding order is native word/line/cell, unique exact raw-word sequence, bounded local OCR, then explicit unresolved. HTML line breaks are aligned separately and must be unique on one page in nonoverlapping vertical source order. No fuzzy character substitution is permitted. Derived highlights retain matched token IDs and separate line regions. Broad page/table context never becomes precise field evidence. Source evidence binds source ID, revision and original SHA. Raw/config/token/raster artifacts are content-addressed and engine/data versions are retained. Requested LlamaParse version is concrete `2026-09-28`; a resolved version not exposed by the response remains null.

Provider jobs are cached by original SHA plus canonical request configuration SHA. A known job resumes after polling timeout; a complete job replays immutable artifacts without a key or network request. Unknown upload outcome never resubmits automatically. A process crash can leave a lock; an operator must first establish that no worker remains, inspect the saved job state, and clear only that lock before resuming. Never erase an unknown submission state to force another paid job. Artifact retention/cleanup policy is outside this adapter.

Use `options.ocr=false` to disable local fallback explicitly; unresolved geometry remains visible. For an enabled runtime, configure `AP_TESSDATA_ENG`, `AP_TESSERACT`, `AP_PDFINFO`, `AP_PDFTOPPM` and, for image inputs, `AP_PYTHON` with Pillow. `runtime/lock.json` pins Tesseract 5.5.2 and English data by checksum. The Dockerfile is a dependency image recipe, not an application image. Its build has not been verified on this host because no Docker daemon is running; resolve/pin OS packages and record a tested image digest before deployment. The measured Mac PSM 6 result is a one-scan regression, not representative production accuracy.

Offline checks:

```sh
node_modules/.bin/vitest run src/ap-system/ingestion
node_modules/.bin/tsc --noEmit --pretty false
```

Live/cached packet command (explicit server-only credentials; first use submits four parse jobs):

```sh
AP_TESSDATA_ENG=/opt/homebrew/share/tessdata/eng.traineddata \
AP_PYTHON=/path/to/python-with-pillow \
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env \
  --import tsx scripts/ap-system/parse-packet.ts
```

Set `AP_STORAGE_ROOT` to the intended durable private artifact directory. Raw response files may contain signed URLs and private document text; do not serve or commit them. The committed parser-contract snapshots contain only synthetic document data and strip URL-bearing response fields. Backend auth, durable review, bill posting and payment execution are separate workstreams.
