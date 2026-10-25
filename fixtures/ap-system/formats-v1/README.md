# Controlled synthetic format corpus v1

All originals are project-authored engineering controls. They are not real supplier invoices or a representative production accuracy benchmark. `manifest.json` binds eight inputs by SHA256. Independent expected profiles live in `evaluation/`; only the verification harness reads them, never runtime ingestion. Expected amounts/profile outcomes were frozen before the new provider requests.

| Control | Provenance | Expected content |
| --- | --- | --- |
| Native PDF | Existing A1 original reused by hash, no duplicate file | INV-1001, 4 lines, USD 678.60 |
| Scanned PDF | Image-only PDF derived from the A1 raster | Same printed original fields |
| PNG | Grayscale, mild blur/contrast scan proxy | Same printed original fields |
| JPEG | Lossy quality-70 encoding of that scan proxy | Same printed original fields |
| Multipage TIFF | Two separately authored pages; ordered line halves and page markers; deflate compression | FMT-MULTI-1001, 4 lines, USD 678.60 |
| Unreadable PNG | Deliberately omitted invoice content | Null candidate; visible missing-content reasons |
| UBL positive tax | Independently authored XML profile instance | USD 17.50 + USD 1.40 stated tax = USD 18.90 |
| UBL unknown profile | Same XML with unknown ProfileID | Null candidate; unsupported-profile reason |

`multipage-layout.pdf` is the reproducible source for the TIFF, not an extra evaluated provider input. The two pages contain different SKUs and `FORMAT-PAGE-1` / `FORMAT-PAGE-2`, so page-order checks do not rely on indistinguishable duplicate pages. The scanned PDF has no text layer. No private archival scan is included.

Regenerate with Python containing ReportLab and Pillow, plus `pdftoppm` on PATH:

```sh
python3 fixtures/ap-system/formats-v1/generate.py
```

Measured generator environment: Python 3.12.14, ReportLab 4.4.9, Pillow 12.3.0. A separate private regeneration produced identical manifest hashes and evaluator JSON. The original scan proxy and both multipage PDF pages were rendered and visually inspected; values/columns/footers are readable without clipping. These tests demonstrate controlled format behavior and refusal of the negative samples, not robust accuracy across unseen supplier layouts or genuine camera/archival captures.

The XML uses project-owned IDs:

- CustomizationID `urn:autonomous-finance:ap:ubl-2.1:invoice:v1`
- ProfileID `urn:autonomous-finance:ap:invoice:usd-explicit-tax:v1`
- UBLVersionID `2.1`; InvoiceTypeCode `380`; DocumentCurrencyCode `USD`.

This is a deliberately narrow UBL 2.1 subset. It is not Peppol, general UBL XSD validation, XML-signature authentication or a tax-jurisdiction decision. See `src/ap-system/ingestion/XML-PROFILE.md` for exact accepted structure and refusal rules. XML unit codes remain their original codes; the adapter does not guess a company catalog mapping.
