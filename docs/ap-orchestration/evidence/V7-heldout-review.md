# V7 independent held-out supplier PDF review

Baseline: `7b0f6444bf79ec914c0c7d0a4af1444af092c49c` (A held-out originals `ac43d826`). Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

## Review order and independence

The verifier first opened only the four `input/*.pdf` originals, extracted text with `pdftotext -layout`, inspected page metadata with `pdfinfo`, rendered all four complete pages with Poppler 26.02.0, and visually inspected every rendered page. The two scan PDFs had no native text; their visible facts were independently read from rendered pixels. No `expected-outcomes.json`, authoring facts, generator code or runtime extraction was opened for this derivation.

That transcription was committed **before evaluation-key access** in `769df9f`, file `V7-original-derived.json`, SHA256 `5ebaeb9b6d64e272ba7284b80cb64c0c8adc6839f73617b700a41942e9632f12`. Only then were the manifest, evaluation key, README, runtime contexts and evaluation checker inspected. Authoring facts and generator code remained unread. No runtime parser or provider was invoked by this verifier.

## Independently visible facts

| Economic invoice | Visible lines and arithmetic in cents | Total |
| --- | --- | --- |
| Harbor Thread Textiles LLC / HT-2408 | 1.5 rolls × 12840 = 19260; 3 packs × 2475 = 7425; subtotal26685 + freight1250 − discount535, tax0 | 27400 |
| Copper Valve Maintenance Inc. / CV-9017 | 2.75 hours × 6400 = 17600; 2 kits × 1875 = 3750; 4 each × 1225 = 4900; subtotal26250, tax/freight/discount0 | 26250 |

Harbor dates are 2026-10-22 / 2026-11-21, Net30; Copper dates are 2026-10-23 / 2026-11-06, Net14. Both state USD and bill Project Test Hospitality LLC. The extended transcription retains printed PO references, the Harbor delivery reference, and the Copper work reference even though these are outside the 104 scored facts. Copper's first description wraps across two lines; whitespace collapse preserves its exact words. All lines, totals and synthetic footers are legible in both native and scan variants; no clipping or ambiguous amount was observed.

The PDFs represent **two logical invoices and four presentation files**. Distinct invoice total is53650 cents; summing all four presentations would be107300 and would double-count the same obligations. Harbor is landscape792×612 points; Copper is portrait612×792 points. Every original has one page and rotation0. A landscape page is not a rotated portrait page.

## Key agreement and what was not tested

`V7-original-comparison.json` records agreement on **all104 visible field facts**: Harbor23 facts ×2 presentations=46; Copper29×2=58. The denominator is44 header facts plus60 line facts. All four original SHA256s and byte lengths match the manifest. Exact decimal arithmetic is independently checked; invoice line IDs are not assumed to be parser line IDs.

Key SHA256: `eee935c7805526ff45f7765a8800a34ddb56f25f07329459fe979a9e8ea7bdae`.
Manifest SHA256: `1ddd6649ebfe444f7dda837d221afd5679f5b318015323655fce690a8b61091d`.

The owner evaluation checker also passes all four PDF integrity/page/frame/text-presence/arithmetic checks. System Python lacked `pypdf`; it was rerun successfully with the existing bundled Python, without installing packages or changing sources. Its printed `independentVisualReview: pending V` is a static owner-checker label; this report supplies that separate review rather than rewriting the checker output.

**104/104 key agreement is not104/104 parser accuracy.** This review establishes intended visible outcomes and original integrity. Actual parser content accuracy, exact geometry success/failure, fallback coverage and configuration/version provenance require the separate root parser run. Missing or null candidates and unresolved geometry remain in the denominator. Native/derived/unresolved geometry must be scored separately from content; scan OCR is not native geometry. No exact boxes were inferred from the answer key or visual transcription.

## Business and provenance limits

Every page visibly says it is synthetic and not payable. Printed PO/work/delivery references do not supply actual purchase orders, receiving records, service acceptance, supplier onboarding, human review or bank authority. Parser success alone must not recognize or authorize a payment. Ledger account, store, department, project and supplier master IDs are not printed facts. Runtime contexts provide those separate trusted configuration values and match the visible supplier names; they contain no invoice-specific quantities or amounts.

The project author declares redistribution permission and synthetic authorship; this review verifies those declarations and visible labels, not legal ownership independently. The author had seen the mapper. These are new supplier/layout controls, not blind evaluation, production invoices, representative supplier diversity or practitioner sign-off. The two scan variants are controlled grayscale/blurred/streaked raster proxies, not independently captured archival/camera scans.

## Reproduction

Originals are under `fixtures/ap-system/heldout-suppliers-v1/input/`. Review renders and extracted text were kept only in `/private/tmp/ap97-v7-originals/`.

```
pdftotext -layout INPUT.pdf /private/tmp/ap97-v7-originals/NAME.txt
pdfinfo INPUT.pdf
pdftoppm -scale-to 1600 -png -singlefile INPUT.pdf /private/tmp/ap97-v7-originals/NAME
/Users/junjiexiong/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 fixtures/ap-system/heldout-suppliers-v1/evaluation/verify-originals.py
```

`tests/ap-system/v7-original-key.test.ts` independently preserves key-versus-frozen-transcription and original-byte integrity assertions. It does not feed expected data to any runtime parser. No original, key, runtime implementation, credential, provider state or canonical registry was modified.
