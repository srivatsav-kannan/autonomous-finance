# A3/F actual held-out parser run

The unchanged adapter produced **0 complete candidates out of 4 originals**. All four LlamaParse jobs completed and reported complete one-page coverage, but the local adapter retained `incomplete` extraction and `candidate: null` for every case. This is a measured engineering gap, not an acceptance pass. No parser changes or expectation-key repairs were made after observing these results.

Input fixture commit: `ac43d82602df2e98e403999cc5528693dd56f207`.
Runtime/acceptance-runner commit: `6a0294197208fc891e715ea556d1a9b5e9f40aab` (no ingestion changes from the fixture baseline).
Actual initial run: 2026-10-25 10:23:55–10:25:01 UTC.

| Original | Candidate | Adapter reasons, abridged | Retained field evidence records |
| --- | --- | --- | ---: |
| Harbor Thread native | Null / incomplete | Unparsed rows; missing invoice number/date/currency; ambiguous or missing freight | 17 |
| Harbor Thread scan | Null / incomplete | Unparsed rows; ambiguous or missing freight | 22 |
| Copper Valve native | Null / incomplete | Missing invoice date | 27 |
| Copper Valve scan | Null / incomplete | Missing supported line table | 11 |

The exact reasons, source/intake hashes, provider job IDs, processor/artifact references, page states, and replay receipts are retained in `A3-F-heldout-parser-results.json`. There are 77 adapter-reported field evidence records: 68 provider-native, 7 derived, and 2 unresolved. “Native” is the adapter's provider grounding classification; it does not mean the image-only scans acquired a native PDF text layer. These counts are not independently verified field-accuracy scores and must not replace the frozen 104-fact denominator. V was given the raw result locations for independent original-derived scoring; that review is separate and pending at this checkpoint.

## Execution and provenance

Each original was passed separately to the existing `combineUploads` with one invoice, a unique source ID, revision 1, delivery ID and durable intake key. These are four isolated parser intake bundles; no backend case, accounting entry or payment was created. Only `input/`, `manifest.json` and `runtime-contexts.json` supplied runtime fixture data. The harness does not open `evaluation/` or `authoring/`.

The process loaded only `LLAMA_CLOUD_API_KEY` from the explicitly authorized private provider file, without sourcing it or adding other credentials to its environment. Exactly four POST submissions and 45 provider/artifact reads occurred. No resubmission, repair request or alternate model was used. LlamaParse was configured with `agentic_plus`, pinned parser version `2026-09-28`, and configuration SHA256 `93232df1fdfd28301bb720511892a8d7a6e9f9f28eb4eb4b44c4861827782d84`. The existing adapter records the configured version and `resolvedVersion: null`; do not claim separately attested server model resolution.

Local fallback retained Tesseract 5.5.2, PSM6, 144 DPI, eight-page limit and 20-second subprocess cap. English traineddata SHA256 is `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`. This ran on the existing Mac toolchain, not the unbuilt Docker image. The Docker build/run gate remains **NOT_RUN**.

Private storage root:

`/Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-20261025`

Each source ID has a directory containing:

- `initial.intake.private.json`: immutable initial intake, including retained incomplete extraction evidence.
- `replay.intake.private.json`: the network-disabled replay.
- `http.private.json`: request classification/status and hashed raw response references; no authorization headers are retained.
- `jobs/<original-sha>-<config-sha>/state.json`: original job identity and completed provider cache.
- `artifacts/`: hash-addressed original/provider/configuration/token/OCR/raster artifacts.

The raw provider JSON includes signed download URLs and remains private. It is not copied into this evidence commit. The committed JSON contains only status/reason metadata, references, hashes and job identities. Artifact references are relative to each source directory, not the aggregate root.

## Replay and checks

The four network-disabled replays each produced byte-identical intake JSON: **4/4**, with **0 POST and 0 GET**. All 69 hash-addressed artifacts across the four case directories passed SHA256 verification. All source directories are private; retained intake/HTTP/artifact files have no group/other permission bits. Initial result files were preserved, not overwritten by replay.

The original authorized command was:

```sh
node_modules/.bin/tsx scripts/ap-system/acceptance-heldout.ts --live \
  --storage-root var/ap97-heldout-20261025 \
  --provider-env /Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env
```

The completed offline replay command was:

```sh
node_modules/.bin/tsx scripts/ap-system/acceptance-heldout.ts --replay \
  --storage-root var/ap97-heldout-20261025
```

Both initial and replay intake outputs use exclusive creation to preserve this baseline. A new live run would require separate authorization and a separate storage directory; do not delete the original receipt to rerun it. Local root/backend/test TypeScript checks and `git diff --check` pass. The new harness has no runtime import of answer keys. The remaining acceptance work is independent field/geometry scoring and a separately authorized general parser correction, with this failed baseline retained.
