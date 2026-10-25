# A2 original ingestion evidence

Owner `/root/p0_inventory`, parent `/root`. Branch `codex/ap-system-evidence`, worktree `/Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks`, run `ap97-20261025-01a1722e-a`. Baseline `ac6285412a3db2948590ca22248737e20f387fcf`; source before C0 `d24f22007a36722831a521d7387ee8f5c92c5803`; spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. Master alone writes `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json`; this work did not edit the registry or start a backend/service.

Implemented direct original PDF/image ingestion, source preservation, same-case PO/receipt/contract mapping, nullable extraction, strict grounding fallback, and a source-bound local page renderer. Public signatures, bounds, configuration and retry semantics are in `src/ap-system/ingestion/README.md`. A1 is separately committed at `bb22b3172d9206f0b793feaaf5d07aa7bd012393`. The prior extraction patch `b1897ee724406f4511b2bf925380f08e15221ff6` was inspected for exact decimal and explicit-field ideas; its customer net-total behavior was not imported or cherry-picked. The mapper preserves printed original total and never substitutes balance/total due.

## Live same-case result

Exactly four original PDFs from the frozen A1 packet were submitted to real LlamaParse. Requested tier `agentic_plus`, concrete version `2026-09-28` (listed by the authenticated official versions endpoint); resolved version is not exposed and remains null. Configuration requests native word/line/cell boxes and raw word output. Complete unmodified provider results, grounded JSONL, raw words, config and originals are privately content-addressed; hashes and job IDs are recorded in `A2-ingestion.json`.

| Original | Job | Result |
| --- | --- | --- |
| Invoice | `pjb-9vuui4sefrqzcaqbxnbhdobp93pt` | 4 lines; printed total 67860 cents |
| PO | `pjb-isalmjsom7w2o1v1g9svihe32x3o` | 4 actual parsed purchase lines |
| Receipt | `pjb-aszl3isyql6pu9p6bfnwvjo2pp3b` | 4 actual parsed receipt lines; printed simulated acceptance |
| Contract | `pjb-cl4jgp2pqw1shv8uy2v7zvabjwej` | 4 actual parsed contract lines |

All four originals have one complete page. Candidate evidence: 33 native fields, 2 unresolved fields (repeated supplier name and USD text), 0 fabricated locations. This is complete content extraction with honest remaining geometry ambiguity, not reviewed business approval. Default supplier binding requires an extracted-name match against trusted server identity. The runtime reads none of A1's frozen facts or evaluator expectations.

The adapter was rerun with a network-forbidden fetcher and no provider credential load. It reused the four saved jobs and produced a byte-identical APIntake. This proves provider-cache replay for the same context/runtime, not durable HTTP response idempotency. The HTTP composition layer must persist the exact prepared intake, especially for explicit revision retries.

## Grounding and renderer

Native geometry takes priority; raw/local OCR accept only unique exact text and retain token refs. A regression derived from the real scan now handles adjacent amount tokens between two description lines by uniquely aligning each line and checking vertical source order. Missing, ambiguous, rotated, wrong-frame and unavailable/failed fallback outputs retain explicit unresolved geometry.

The existing private archival JPEG (SHA256 `0536b1ee4ca22cf618e608b4aa0c8078c2f9f8ecd8eecc1716e13bee92710760`) and previously saved provider job were replayed with **zero new provider calls**. Its native description box is still absent; raw-word exact alignment still fails. Integrated local Tesseract 5.5.2 / pinned English data / PSM 6 returned two derived regions: `(106,529,286,13)` and `(107,556,198,13)` in the original 754 × 1000 pixel frame. Actual tokens, config, raw TSV and raster manifests are hashed. This one private diagnostic is neither an AP candidate nor a production-quality benchmark; the private source and raw provider data were not committed.

The same renderer exported all four original PDF pages from `originalBase64` with the originalRef deliberately unavailable. All frames were 612 × 792 points with identity transform; raster hashes are recorded. The invoice raster was visually inspected with legible values and no clipping. A separate 90° rotated PDF was rejected with `unsupported_source_rotation`. Nontrivial crop/media-box transforms are also rejected explicitly.

## Commands and results

From the assigned worktree:

```sh
node_modules/.bin/vitest run src/ap-system/ingestion
node_modules/.bin/tsc --noEmit --pretty false
```

29 tests in four files passed; TypeScript passed. Coverage includes actual sanitized provider extraction, unknown supplier, missing page/content, unreadable line preservation, exact money overflow, no balance substitution, source revision binding, duplicate/ambiguous and multiline grounding, native/derived/unresolved distinctions, original hash mismatch, unavailable renderer/traineddata, subprocess timeout, wrong frames/rotation, mutable-version rejection, same-job resume and no resend after unknown upload outcome.

Live/cached packet: `AP_PYTHON=<bundled Python with Pillow> node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/parse-packet.ts`. Only the initial four jobs were paid submissions. Offline replay adds `AP_OFFLINE=1`, omits the env-file, then `cmp` of the before/after intake passed.

Renderer: `node --import tsx scripts/ap-system/parse-render-check.ts var/ap97-20261025-01a1722e-a/intake.private.json var/ap97-20261025-01a1722e-a/rotation-control.pdf`. Rotation control was generated privately with pypdf by rotating A1 invoice page 90°.

Private scan: `AP_PYTHON=<bundled Python with Pillow> node --import tsx scripts/ap-system/parse-grounding-diagnostic.ts`; exit 0, local_ocr_exact with two regions. Full private diagnostics remain under `var/ap97-20261025-01a1722e-a/`. The full intake handoff is `var/ap97-20261025-01a1722e-a/intake.private.json`; it is not a committed/public artifact.

## Limits and next acceptance

- Docker dependency recipe pins Tesseract source and English traineddata checksums; container build **NOT_RUN** because no Docker daemon is available. The measured local engine/data match pins. OS package/image digest and deployment build remain unverified.
- PDF originals and one real JPEG OCR regression are measured. Broader TIFF/scanned-PDF/photo-layout coverage remains unverified; XML extraction is not implemented. Conservative unsupported layouts produce a null candidate, not guessed facts.
- The mapper does not allocate nonzero tax or infer purchasing authority. Business gates and exact allocations belong to B. Source rendering supports identity transforms only.
- No bank calls, payments, backend writes, UI/browser acceptance or practitioner sign-off were performed by A. These are Master/independent workstream gates. Master decides acceptance after integration/review.

Official grounding references used: [layout and bounding boxes](https://developers.llamaindex.ai/llamaparse/parse/features/layout-and-bounding-boxes/) and [response format](https://developers.llamaindex.ai/llamaparse/parse/guides/response-format/).
