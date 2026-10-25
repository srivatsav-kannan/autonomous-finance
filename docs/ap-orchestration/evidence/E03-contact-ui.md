# E03 supplier contact HTTP and UI

Prerequisite: B production checkpoint `b1a8979` (local cherry-pick `2a151fa`). This D checkpoint adds the authenticated transport and UI only; Master should integrate the D commit after B, not cherry-pick the duplicate prerequisite.

## Request authority

- `GET /api/ap-system/supplier-contacts` returns the authenticated safe contact/proposal/review inventory plus server-derived `controllerProposalAvailable`.
- `POST /api/ap-system/supplier-contacts/{propose,verify,escalate,decide}` validates the strict shared operation schema. Browser identity, scope and agent credentials are not accepted.
- Proposal uses the configured controller agent and server scope. Missing controller capability fails closed; it never substitutes the AP agent or human.
- History, verification, escalation and final decision use the request-owned authenticated human client. `decide` maps to the backend's nested `input`; the other operations preserve their exact documented shape. Normal Auth0/session handling, subject-bound cookies, origin and CSRF checks apply; there is no manual-token path.
- Existing contact registration remains on `business/registerTrustedContact`; optional origin metadata is validated by B's updated schema.

## Forms and values

**Source registration:** phone, supplier, origin kind/acquisition time/description and supporting originals are entered or explicitly selected. The default legacy option omits origin, preserves earlier onboarding compatibility and says that it cannot establish a replacement. No source or confirmation is preselected. Known invoice/credit original hashes, including renamed copies, are removed from the evidence picker; authoritative source checks remain on the backend.

**Controller proposal:** existing supplier revision and governed old contact come from the authenticated inventory, approved supplier revision and contact-authority pointer. The user chooses replacement versus restoration, a separately retained new contact when replacing, old-channel status, exact evidence, reasons and explicit supersession confirmation. Restoration binds the same old/new contact by the user's explicit resolution choice. The backend still rechecks current hashes and participant authority. An unavailable old channel requires an explicitly configured contact escalation group in the policy editor.

**Human review:** method, performed time, evidence, reason and confirmation start empty. Available-channel verification and restoration use old-channel confirmation; the unavailable-channel path uses independent reestablishment. Escalation appears only after recorded verification. Final approval remains disabled until required reviews are present; rejection is a separate explicit choice and retains the hold. No identity/group membership is inferred as approval by the frontend.

**History and consequences:** original bindings, provenance, proposal hashes, supersession IDs, review modes/times/people/seats and immutable decisions remain inspectable. Exact loaded originals can be downloaded through the existing authenticated hash-checked path. Missing historical originals are identified without substituting a newer revision. Approved replacement explicitly requires supplier and case recertification; it is not a bank destination change or transfer approval. Final human approval can cancel provably unsent proposals through B's existing rule; possibly sent payments retain their reconciliation path. The interface never places calls or sends messages and labels simulated versus operator-recorded evidence.

## Validation

The focused D tests cover strict current-human/controller routing; absent controller capability; missing/expired/unapproved/cross-user sessions; origin rejection; forged scope/subject/credentials; unknown operations and absent capability; explicit proposal supersession; current supplier/contact binding; invoice-original relabeling; initially empty attestations and confirmations; sequential verification/escalation/final approval; rejection/recertification consequences; and exact synthetic original hashes.

Eight focused D tests pass. The broader AP UI/auth/transport set plus E03 backend and V7 regression checks passes 162 tests. Application, backend and full test typechecks, console build, design check and diff check pass. The existing large-bundle advisory remains. No actual supplier contact, identity enrollment, live backend mutation, provider action or practitioner signoff was performed.

## Root CUA fixtures

The existing isolated D2 fixture remains explicitly synthetic and never forwards requests:

`http://127.0.0.1:5191/@fs/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks/docs/ap-orchestration/evidence/D2-browser/fixture.html?apWorkspace=governance&apFixture=contacts`

Within **Trusted supplier contact changes**, inspect source registration, exact proposal/restoration choices and the immutable proposal. Compare these fixed review stages by changing `apFixture`:

- `contacts`: blank verification controls; final approval disabled.
- `contacts-escalation`: recorded synthetic verification; separate escalation controls.
- `contacts-decision`: recorded synthetic verification and escalation; explicit final decision and confirmation.
- `contacts-rejected`: rejection retains the hold and the controller draft requires explicit supersession/restoration.

Use the fixture palette for light/dark and the root-owned CUA viewport for desktop/mobile. The synthetic agreement contains the exact displayed phone numbers and has a tested SHA-256; its download is mocked locally. Contact submissions deliberately return an explanatory fixture error rather than pretending to record a real decision. These are presentation fixtures, not an end-to-end supplier communication or acceptance result. Root CUA verification remains pending at this checkpoint.
