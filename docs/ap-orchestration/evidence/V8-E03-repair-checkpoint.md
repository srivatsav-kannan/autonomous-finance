# V8 — first repair and retained-review boundary

Runtime `800e299b904f3bac7120ecda6db1d42d21093fd7`: original immutable baseline plus B repair `d4701411c4c1fcab6eaff03130e2fac5ea9deb39`. Both original independent test files have identical hashes to baseline report commit `6cf4dcb`. **Original focused suite: 54/54 pass (18 independent, 36 owner)**. All three TypeScript checks pass. The original V8-F1 new-review reproduction is repaired. Available-channel confirmation and unavailable `retain_current` confirmation plus escalation remain valid.

## V8-F2 — retained pre-repair contradictory review remains usable

P2 upgrade-state/process integrity; no known live affected rows. The original baseline demonstrably accepted an unavailable/replace review with `old_channel_confirmation`. Applying only the new-record guard leaves an already persisted such review eligible for escalation, final approval and future supplier authority. `assertContactChangeParticipants` rechecks people, sources and scope but not the retained review method.

Three new independent upgrade-state probes all fail on the first repair:

1. A pending retained baseline-reachable contradictory verification can receive a new public escalation.
2. A complete retained review containing that verification can receive public final approval.
3. An already approved replacement containing that verification can authorize a newly approved supplier revision.

The probes seed only the specific historical review field/state reachable through the pre-repair public API. They do not assume an attacker can write arbitrary database records, and do not claim affected production data. This is a deployment/retained-state boundary. History should remain immutable; current authority should reject it and require fresh governance. Reported to Master and B before changes. B supplied second repair `53eb10957f8c025d6ccf617324e8f7e65d7776fc`, not yet included in this checkpoint.

Reproduction: the original five focused files use the command in the baseline report with `/private/tmp/ap97-v8-e03-repair.json`; added probes use `node node_modules/vitest/vitest.mjs run tests/ap-system/v8-e03-retained-review.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v8-e03-retained-review.json`. Exact test names, result hashes and independent file hashes are in `V8-E03-repair-checkpoint.json`. No live backend, provider, credential, browser session or practitioner review was used.
