# V7-T1 independent repair verification

Independent agent engineering review, not practitioner sign-off. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

**V7-T1 is closed by `5897330ae92e34b5544d94d68fe6aa918e6d88f7`.** The exact original V7 financial/status assertions are unchanged from `e3707a2`. All five independent cases pass, including the previously failing retained retired-voter case. The projection now validates retained pending votes without requiring future quorum; invalid retained authority marks the route stale, so timing becomes unavailable without inventing a completion time. The next real vote still rejects invalid authority. This was a status/metric defect, not a payment defect.

The isolated branch starts at `e3707a2`, replays D's repair as `1a692ac`, and additionally replays the unrelated Increase compatibility patch as `0991683`. Final verification code HEAD is `0991683322c0a8e44ff8f9785d4c164ed256de01`. No production edits were authored by the verifier.

Final selected check: **28/28 PASS = 5 independent + 23 owner tests**. The first restricted run timed out only in the existing loopback HTTP transport case at 5 seconds; a serial 15-second restricted retry had the same timeout. The identical assertions all passed when rerun with loopback listening allowed. Both attempts are retained in `V7-followup-results.json`, rather than silently discarded.

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v7-timing.test.ts tests/ap-system/business-timing-authority.test.ts tests/ap-system-operational-timing.test.ts tests/ap-system/operational-timing.test.ts tests/ap-system-timing-ui.test.tsx tests/ap-system-timing-transport.test.ts --cache=false --configLoader native --maxWorkers=1 --reporter=json --outputFile=/private/tmp/ap97-v7-timing-repair-final.json
```

Root, backend and test TypeScript checks also pass on the combined isolated code. Exact test identities, immutable test hash and raw result hashes are in `V7-followup-results.json`. No shared backend, real identity, credential, provider or practitioner calls were made.
