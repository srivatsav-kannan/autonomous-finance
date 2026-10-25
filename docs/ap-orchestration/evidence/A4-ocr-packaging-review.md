# OCR packaging runtime gate — PASS

The user requested this independent Docker/OCR task and separately authorized Master to record only this gate on issue97. Source and results were inspected on 25 October2026; no source changes were required. This review retains the whole original 91-file evidence bundle (516,480 bytes), including the initial mount failure and the successful retry.

## Integrity and actual execution

Root independently rehashed all90 entries in [EVIDENCE-SHA256SUMS](A4-ocr-packaging-20261025/EVIDENCE-SHA256SUMS). Manifest SHA256: `d709a5d4e0c585d384b7515a99832c7e767e553097a0f4dce9a1a42fddd624fc`. A separate agent also verified all12 source files against fixed commit `ed372a40570d714b5b893c6e4e86e25f2427bc80`, the frozen snapshot, actual mounted copy and current source tree, plus a read-only inspection of the retained image. Its audit did not start or alter containers or the daemon.

Original Dockerfile build exit0,102.012 seconds. Docker Client29.9.2 / Server29.5.2 via existing Colima0.10.3, per-command endpoint, unchanged global context. Image `sha256:09c398f49cc16a60d0e7888b3939505d60f5482264ea0e86bb4374034352d9c7`, linux/arm64,93,834,958 bytes. Tesseract5.5.2 and pinned English traineddata checks passed. Moving Debian tags/apt versions mean this is an identified actual build, not a guarantee of byte-identical future builds.

The original smoke ran with network disabled, read-only root and three mounts, all capabilities dropped, no-new-privileges,64 PIDs,1 CPU,512MiB RAM and128MiB tmpfs. Docker recorded1GiB memory-plus-swap and default root user. Original script limits were20 seconds per child process,144DPI andPSM6.

| Controlled scan | Raster | Nonempty words | Result |
| --- | --- | ---: | --- |
| Harbor Thread |1584×1224|123|PASS|
| Copper Valve |1224×1584|135|PASS|

The single smoke invocation and container exited0 in1.204 seconds; no timeout or OOM. Single-page/zero-rotation/no-native-text/raster bounds and all word boxes within the page were checked. `accuracyEvaluated=false`, `providerCalls=0`. Raw generated PNG/TSV files were deleted by the original script; their logged hashes and counts are recorded observations and cannot now be recomputed independently. This caveat does not alter verified source or log integrity.

## Separate acceptance states

Only **OCR packaging runtime gate = PASS**. This smoke does not establish extraction accuracy, exact-word grounding correctness, complete AP/parseUpload integration, multipage/rotation coverage, real provider acceptance, production readiness or overall issue completion. Those capabilities retain their own existing evidence/status. The existing held-out parser accuracy/geometry evaluation is not changed by this report.

[Original report](A4-ocr-packaging-20261025/REPORT.txt), [acceptance summary](A4-ocr-packaging-20261025/acceptance.json), [actual measurements](A4-ocr-packaging-20261025/gate-result.json), [source manifest](A4-ocr-packaging-20261025/source-manifest.json), [runtime configuration](A4-ocr-packaging-20261025/logs/smoke-configuration-2.stdout), and [build log](A4-ocr-packaging-20261025/logs/image-build.stderr) retain the exact commands and outputs. The convenience reproduce.py was not run; run-smoke-2.py captured the actual successful execution.
