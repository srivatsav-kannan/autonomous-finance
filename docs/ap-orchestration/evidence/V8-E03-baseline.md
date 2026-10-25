# V8 — independent E03 baseline

Independent agent engineering review, not AP practitioner sign-off. Immutable code baseline `c12bb64befc99e12496a8ead86bfb8a1a3aa86b4` combines backend `b1a8979e5c3815633173f5527a8380e801e54688` (local `03b15bb`) and UI/transport `575b47d931b04a56f4fbb60143dfe771344c8f4a` (local `c12bb64`). Prior V7 original-derived evaluations and baseline artifacts are preserved. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

## Independent expectations and result

Derived from the original contact-change process and frozen payment authority contract: a source registration is not replacement authority; current independent people must authorize exact current scope/proposal/contact/provenance; unavailable old channels require independent reestablishment plus a separate escalation; retained-current restoration must freshly confirm the original channel, and retain escalation when declared unavailable. A rejected/superseded review must not authorize another proposal. A controller proposal may stop a new send but cannot release a possible send. A human decision can cancel a proven unsent operation. A possible send must recover its original key, command, destination and reservation, then post one settlement from actual evidence.

**Baseline: 52/53 pass; 1 confirmed defect.** Independent tests: 17/18 pass (15 backend/recovery + 3 HTTP/UI). Owner regressions: 35/35 (27 backend, 6 UI, 2 transport). All three TypeScript checks pass. This is a bounded E03 review, not a new integrated/full-roadmap acceptance. Assertions and source hashes are preserved in `V8-E03-baseline-results.json`.

## V8-F1 — contradictory verification accepted for an unavailable old channel

Priority P2, backend process/evidence integrity. `convex/apSupplierContacts.ts`, verification-method guard around lines 264–277.

1. Retain a valid independent replacement contact, with a distinct active source recorder.
2. Controller proposes `resolution: replace`, `oldChannel.status: unavailable` and valid exact supporting originals.
3. Current verification-group human submits `method: old_channel_confirmation` at a valid post-proposal time.
4. Baseline accepts and stores that review. The independent assertion expects refusal. UI already offers only `independent_reestablishment` for this combination, so direct API use bypasses the UI's process constraint.

Owner confirmed intended semantics: unavailable replacement requires `independent_reestablishment`; `retain_current` intentionally uses `old_channel_confirmation` to show recovery, with separate escalation still required when declared unavailable. A separate escalation and final human decision remain required on the faulty baseline. No unilateral payment authorization or transfer bypass is claimed. Reported to Master and B before any production change; B supplied repair `d4701411c4c1fcab6eaff03130e2fac5ea9deb39` for later unchanged-test replay. This baseline report does not claim that repair passed.

## Tested boundaries

- Underlying human-seat aliases cannot provide recorder/verifier or verifier/escalator separation; retained recorder, verifier and escalator retirement blocks final approval atomically. Recorder retirement after supplier and case recertification blocks a future payment request without rewriting approved history or accounting entries.
- Wrong scope/hash/cross-supplier contact and foreign-scoped provenance are rejected; a failed proposal insertion leaves no replacement authority. Current policy supersession requires a fresh proposal and fresh reviews. An exact old review replay does not populate its successor.
- A newly approved contact becomes the next proposal's old contact even before supplier recertification. `retain_current` preserves that authority and still requires supplier recertification. Unavailable restoration requires old-channel confirmation and a separate escalation.
- A preexisting unapproved payment cannot become authorized under a pending contact change, while its snapshot/reservation remain. A queued unsent payment makes zero FakeBank transfers, becomes a held no-attempt exception, and is cancelled/released only after a fresh human-approved restoration. A subsequent request is a new version, with no automatic send.
- Full isolated original-engine recovery: 7,700 cents recognized; FakeBank accepts a transfer but loses the response; unavailable contact replacement is independently approved; original command, destination, request/key, bill and reservation remain byte-equivalent through the change. Recovery finds the existing transfer. Exactly one `createTransfer`, one transfer and one settlement remain; paid amount 7,700, exactly two journals (recognition and settlement). Repeated observations/worker ticks add no journal.
- HTTP → actual workspace service → actual isolated Convex mutations: request-bound synthetic human identities and cookies; wrong group, switched identity/cookie and forged browser scope denied; independent verifier and final approver recorded correctly; exact decision replay adds no economic effect. Safe contact view excludes credentials and raw/private originals.
- Static UI/helper checks: all four resolution/channel combinations offer the appropriate method with empty confirmation; stale policy/supplier/status prevents review controls; explicit supersession is necessary and retained-current cannot smuggle another contact. Source/effect invalidation hooks and response scope were also inspected. No dynamic browser interaction claim is made.

## Reproduction and limits

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v8-e03.test.ts tests/ap-system/v8-e03-transport.test.ts tests/ap-system/supplier-contact-changes.test.ts tests/ap-system-contact-ui.test.tsx tests/ap-system-contact-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v8-e03-baseline-final.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

Assigned verifier worktree only, integration dependencies via temporary read-only symlink. HTTP tests use temporary loopback port 0; FakeBank uses memory. No live backend, external provider, private credentials, registry change, actual phone contact or practitioner review. Test scaffolding was corrected before this frozen run: Convex-test's monotonic mutation time requires retained proposal time for attestations; worker lease tokens have a minimum length; UI mutation hashes must differ from fixture hashes. An initial recovery probe used an unopened November period and correctly remained unposted; moving the synthetic scenario into its configured October open period resolved it. That observation was reported as fixture setup, not a product defect.
