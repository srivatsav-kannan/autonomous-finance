# Independent cached replay verification of the mapper repair

**`c2201a42f13368e9a9e0028363f9193c9120569e` closes V7-P1 and V7-P2 in this held-out control.** Four complete candidates contain all **104/104** original-derived facts correctly. Strict geometry is **102/104**; the two Copper currency fields remain explicitly unresolved with `local_ocr_ambiguous`, not falsely precise. This score preserves the full denominator and is not a claim of general production accuracy.

| Layer | Initial actual run | Repair on same cached jobs |
| --- | ---: | ---: |
| Correct provider content present | 104/104 | 104/104 |
| Complete candidates | 0/4 | 4/4 |
| Correct candidate fields | 0/104 | 104/104 |
| Correct retained evidence fields | 75/104 | 104/104 |
| Wrong / missing retained fields | 2 / 27 | 0 / 0 |
| Strict accepted geometry | 72/104 | 102/104 |

Original derivation is the pre-key V7 freeze; spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`, contract `ap-evidence-v1`. Initial actual-run score remains immutable in commit `9d10e56`. The successful extraction stores evidence in `candidate.evidence`; the scorer was changed only to select that documented envelope when a candidate exists, and to accept the inspected runtime SHA as a CLI argument. The entire old score reproduces identically, except the scorer's own changed hash. No original, expected value, comparison rule or geometry criterion changed.

The verifier cherry-picked only the supplied mapper patch onto the isolated verification branch, as `0206806`. Relevant ingestion code before and after exactly matches the supplied patch's parent and result. The independent harness copies original cached artifacts and job state into a fresh `/private/tmp/ap97-v7-cached-*` directory, reads only original PDFs/manifest/trusted runtime context, and invokes real `combineUploads` with a fetcher that throws on any network attempt. It does not read evaluation keys, authoring or scores. **Four independent outputs match A's supplied repair outputs byte for byte; network calls = 0.** Scoring these newly produced outputs also equals the supplied-replay score exactly except for the chosen intake filename.

All 69 artifact hashes and unchanged provider-result/source identities were checked again. All four repaired region overlays were visually inspected against the originals. Both Copper multiline descriptions now use two exact line regions. Correct invoice numbers, supplier names, dates and freight replace the initial omissions/overcaptures. The two unresolved currencies have no forced rectangle. Native provider geometry on a scan still does not imply a native PDF text layer.

Separate regression evidence: **93/93 selected existing owner ingestion/format tests pass** (92 ingestion + 1 formats-policy). Root, backend and tests TypeScript checks pass. These are regression tests, not 93 additional independent cases. The four cached invocations and 104-field scoring are the independent repair verification. Initial tsx CLI invocation could not open its IPC pipe under the sandbox; `node --import tsx` ran without that IPC requirement. The first regression filter misspelled the formats path and ran 92 ingestion tests; the actual `tests/ap-system/formats-policy.test.ts` was then run separately and passed. No failed assertion is concealed by the combined count.

```sh
node --import tsx tests/ap-system/v7-cached-parser-replay.ts /Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-20261025 /Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-mapping-c2201a4
python3 tests/ap-system/v7-score-heldout.py . /Users/junjiexiong/.codex/worktrees/ap-system-evidence/calhacks/var/ap97-heldout-mapping-c2201a4 /private/tmp/ap97-v7-repair-score.json replay.intake.private.json c2201a42f13368e9a9e0028363f9193c9120569e
node node_modules/vitest/vitest.mjs run src/ap-system/ingestion --cache=false --configLoader native --maxWorkers=1
node node_modules/vitest/vitest.mjs run tests/ap-system/formats-policy.test.ts --cache=false --configLoader native
```

`V7-parser-repair-score.json` contains all 104 independently scored rows. `V7-parser-repair-results.json` retains exact invocation/output hashes, test identities and comparison proof. Raw signed URLs remain private. This is independent agent engineering review, not practitioner sign-off, real business approval or payment authorization. The supplier/layout samples remain project-authored non-blind controls; no real provider request was made by the verifier.
