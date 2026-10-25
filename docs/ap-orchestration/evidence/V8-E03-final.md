# V8 — E03 final independent verification

**59/59 focused checks pass: 21 independent, 38 owner regressions.** Root, backend and test TypeScript checks pass. No independent assertion was altered for either repair; all three independent test-file hashes match their preserved baseline/checkpoint. Scope is independent agent engineering verification, not actual supplier contact, real Auth0 identity verification, external provider acceptance or AP practitioner sign-off.

Verified immutable runtime `ae7026643c306e12c0b322a92f5c07fa2291855a`: original E03 baseline `c12bb64befc99e12496a8ead86bfb8a1a3aa86b4`, then repairs `d4701411c4c1fcab6eaff03130e2fac5ea9deb39` and `53eb10957f8c025d6ccf617324e8f7e65d7776fc` (local replay commits `800e299`, `ae70266`). Evidence-only baseline commit `6cf4dcb` preserves the original 52/53 result. Evidence-only checkpoint `bcdbdff` preserves the 54/54 first repair result and three failing historical-review probes.

Both findings are repaired in this bounded scope:

- **V8-F1:** newly recorded verification for `replace` plus `oldChannel: unavailable` cannot use old-channel confirmation. It requires independent reestablishment. `retain_current` still confirms recovery of the original channel and retains its separate escalation requirement when declared unavailable.
- **V8-F2:** retained pre-repair contradictory verification is rejected when attempting escalation, final decision and future supplier authority. Validation preserves historical records and requires fresh governance rather than silently adopting those records. This upgrade-state test makes no claim that a real affected record existed.

Payment and identity regressions remain green: current distinct underlying people, stale scope/contact/policy/provenance, explicit supersession/restoration, no automatic authorization, preservation of awaiting/queued reservations, zero sends for an unsent hold, human-only cancellation of proven unsent commands, and recovery after a possible send. The in-memory FakeBank test retains the original command/key/destination, performs one transfer, pays exactly 7,700 cents and posts one recognition plus one settlement; duplicate observation adds no journal. The actual loopback HTTP → service → isolated Convex backend test records the correct request-bound synthetic verifier/approver, denies stale cookies/wrong groups/forged scope, and returns no private originals or credentials.

Static UI checks cover method choices, unchecked initial confirmations, stale proposal controls and explicit supersession. Actual interactive browser behavior was not part of this verifier checkpoint; Master owns browser checks. Exact review predicates, before/after results, limitations and fixture setup corrections remain in the immutable baseline/checkpoint reports. `V8-E03-final-results.json` records all assertion identities and hashes.

Final command, run in the assigned verifier worktree:

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v8-e03.test.ts tests/ap-system/v8-e03-transport.test.ts tests/ap-system/v8-e03-retained-review.test.ts tests/ap-system/supplier-contact-changes.test.ts tests/ap-system-contact-ui.test.tsx tests/ap-system-contact-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v8-e03-repair-final.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

No live backend, external provider, private credentials, shared registry or other owner's source was changed. Only upstream patches were replayed for verification; verifier-authored changes are tests/evidence. The temporary dependency symlink is removed after the final checks. Real practitioner sign-off remains an external acceptance item.
