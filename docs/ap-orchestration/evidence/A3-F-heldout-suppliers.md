# A3/F held-out suppliers and OCR packaging gate

Date: 2026-10-25. Source baseline: `3f41c68b149a97be7aee3ad4f5a98de9473bb258`. Scope: new fixture/evaluation files and an offline packaging smoke script. No ingestion, accounting, authentication, provider credentials, registry or live service was modified.

## Coverage and frozen inputs

The existing `formats-v1` native PDF, scanned PDF, PNG, JPEG and multipage TIFF use Golden State. Its separate supplier is a direct UBL XML control. No prior unseen PDF supplier/layout test was found. `fixtures/ap-system/heldout-suppliers-v1` adds two invented suppliers and two different PDF layouts, each with a native and image-only scan original. These are project-authored controlled scan proxies, not archival captures. The author had read the existing mapper; do not call this a blind benchmark.

| Original | SHA256 | Bytes |
| --- | --- | ---: |
| `input/harbor-thread-native.pdf` | `0d8993129e04f666f715018040106dc518c1a42f41f77587293180b4ed4df1c5` | 2789 |
| `input/harbor-thread-scan.pdf` | `fa814b53d96635afc6c7fc08e02eec91df5a656c9024d72b2a5949b4248090a5` | 107517 |
| `input/copper-valve-native.pdf` | `dc323890c0c20082c1f6bcfd402b0365009d4e0147b36299835129cf39c96791` | 3442 |
| `input/copper-valve-scan.pdf` | `741c0bc7adfcb6fccffe404f8dc4096a31e55fbe8f76b18fef5f5807586495f6` | 118476 |

The generator reads `authoring/facts.json` only; `evaluation/expected-outcomes.json` is a separate, author-derived expectation key frozen before parser execution. Runtime contexts supply only matching supplier identity and coding dimensions. The key scores 104 visible content facts and the corresponding geometry separately. Missing/failed/unresolved outputs remain in the denominator. The scanned copies are alternative originals of the same two economic documents, intended for separate extraction cases.

Evaluation key SHA256: `eee935c7805526ff45f7765a8800a34ddb56f25f07329459fe979a9e8ea7bdae`.
Generator SHA256: `cc75dede3f4ed8f1765f5025204010f5aaf47f41da57c8e235e0de448bd2ee66`.

## Completed offline checks

- Regenerated into a separate temporary directory: all four PDF files, manifest and runtime contexts are byte-identical (6 files).
- Evaluation-only verifier: 4 original hashes/sizes and one-page frames pass; 2 native originals contain the expected visible facts; 2 image-only originals have no native text and one embedded image each; exact decimal line/header arithmetic and the 104-fact denominator pass.
- Rendered all four pages at 100 DPI and visually inspected values, column layout, wrapped descriptions, totals and synthetic labels; no clipping, overlaps or unreadable fields found.
- Packaging script `--check-inputs-only`: 4 originals/2 scans pass, no OCR executed.
- Packaging input rejection probes: modified original bytes rejected, a path outside `input/` rejected, unapproved PSM configuration rejected. These are local input checks, not container tests.
- `git diff --check` passes.

Actual parser calls: **NOT_RUN**. Provider files: **NOT_READ**. Accuracy rates: **UNMEASURED**. Master owns the next actual-parser run; V owns independent review of the originals and expectation key. No candidate is forced from expected facts.

## Docker availability and reproducible gate

Read-only host checks found `/opt/homebrew/bin/docker`, Docker CLI 29.9.2/API 1.56 on darwin/arm64, and the default context `unix:///var/run/docker.sock`. `docker version` returned no server and failed because that socket does not exist. No daemon was started; no image was pulled/built; no container was created, stopped or modified. Image build/run: **NOT_RUN**, blocked by unavailable daemon.

The existing `src/ap-system/ingestion/runtime/Dockerfile` is an OCR/rendering dependency image, not the full AP service. Tesseract 5.5.2 source and English traineddata are SHA256-pinned in `lock.json`; the Debian bookworm tag/packages are resolved at build time. A successful source pin check alone does not prove a reproducible complete image. Record the resulting image ID, architecture and installed package versions for the actual build used.

Once an owner makes a Docker daemon available, the bounded gate is:

```sh
# Context contains only the runtime packaging files, not credentials or private artifacts.
docker build --tag ap97-ocr-smoke \
  --file src/ap-system/ingestion/runtime/Dockerfile \
  src/ap-system/ingestion/runtime

docker image inspect ap97-ocr-smoke --format '{{.Id}} {{.Architecture}}'
# Use the exact recorded sha256 image ID below, not a mutable tag.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 512m --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --mount type=bind,source="$PWD/fixtures/ap-system/heldout-suppliers-v1",target=/fixtures,readonly \
  --mount type=bind,source="$PWD/src/ap-system/ingestion/runtime/lock.json",target=/runtime-lock.json,readonly \
  --mount type=bind,source="$PWD/scripts/ap-system/ocr-packaging-smoke.py",target=/smoke.py,readonly \
  --entrypoint python3 sha256:RECORDED_IMAGE_ID /smoke.py /fixtures /runtime-lock.json
```

`ocr-packaging-smoke.py` verifies original hashes, pinned Tesseract version/traineddata, one-page dimensions/rotation, scan text-layer absence, 144 DPI raster frames, nonempty TSV tokens and in-frame word boxes under the pinned PSM6 configuration, with a 20-second cap per subprocess. Output contains original/raster/TSV hashes and word counts, not OCR text. It never opens `authoring/` or `evaluation/`, and does not call a provider. The optional `--check-inputs-only` mode checks hashes/configuration without rendering or OCR.

A successful container run will establish that the packaged renderer/OCR can execute these two controlled scans under those resource limits. It will not establish extraction accuracy, correct exact-word grounding, multipage/rotation behavior, the application integration, or production readiness. Those retain their separate existing tests and acceptance gates. Do not convert this unrun gate into a pass until the image and two measured result records exist.
