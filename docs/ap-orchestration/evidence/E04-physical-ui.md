# E04 physical-line HTTP and UI checkpoint

Base: integrated `9593e0e`, which includes the physical-line backend from `3242bf6`. This checkpoint owns transport, browser forms, component fixtures and focused tests. It does not alter schemas, posting authority, provider configuration or the canonical registry.

## Review and claim workflow

Matching now presents **Physical source line identity**. A controller proposal binds the current case/revision/snapshot and an explicitly selected current source. The form shows the complete retained parser line set. An initial catalog requires manually entered physical IDs, SKU/unit/capacity, price if stated, page, exact global text offsets and quote. An existing source catalog must be explicitly selected for a subsequent split/merge/rename mapping; it cannot be redefined. Every link quantity is entered explicitly.

The immutable review shows the original binding, parser-to-physical quantity map, exact quotes and locators, proposal/parser/policy hashes and recorded decision. A separate human chooses approve/reject, supplies a reason and confirms the comparison. These start blank. A pending decision is hidden if its case revision, snapshot or current policy hash changed. The server repeats current seat/group, source and conservation checks. A saved approved decision is historical evidence, not a promise that its reviewer still has authority today.

The capacity table displays frozen original quantity, posted consumption, outstanding accrual and remaining quantity separately. Remaining is an observation, not a reservation. Text offsets are zero-based UTF-16 positions in retained extracted text, with an exclusive end. They are not represented as native PDF coordinates or evidence that software observed goods delivery. Exact original downloads use the existing authenticated source path.

Acceptance agreement/receipt claims and supplier-return credit claims can select a recorded approved mapping for the exact case/revision/snapshot/source. Selecting it creates no physical allocation: every physical quantity starts blank. The UI checks positive unique quantities, each reviewed parser-to-physical link limit and the exact claimed total, including partial merged rows. Return rows must also match the explicitly selected return originals and credited quantity. Final backend posting remains the authority for total shared capacity and current reviewer status; UI remaining values are not used to guess whether an explicit accrual reversal makes room.

Accruals offer the same approved receipt/service mappings from current loaded cases. Explicitly selecting a line supplies the frozen SKU, unit, capacity, parser row and stated unit price. The immutable physical ID is sent separately in `identity`. Quantity to accrue and evidence quote remain blank. Changing supplier/source/physical selection clears those fields and invalidates confirmation. A standalone retained original with no reviewed case mapping does not get an invented physical identity. Its preexisting legacy path remains available only when no catalog exists, subject to backend checks.

Policy & suppliers exposes the optional `receiptIdentityApprovalGroup`; no group or membership is created automatically.

## Transport

- `GET /api/ap-system/physical-lines?caseId=<optional>` uses the current human and server-owned scope; the optional case filters review history.
- `POST /api/ap-system/physical-lines/propose` accepts only `{idempotencyKey,proposal}` and injects the configured controller credentials on the server.
- `POST /api/ap-system/physical-lines/decide` accepts only `{reviewId,expectedHash,outcome,reason}` and calls the backend with the current human, never the controller.
- Missing controller and missing service capability fail explicitly. Existing subject-bound cookie/session, bearer authentication, origin/CSRF enforcement and exact operation parsing apply. Browser-supplied scope, subject and seat credentials are rejected.

## Verification

- 27 focused tests passed: 8 UI/helper tests, 2 HTTP/service tests and the existing 17 backend physical-line tests.
- Related UI/business/close/auth/contact regression selection: 9 files, 69 tests passed.
- Main, backend and full-tests TypeScript checks passed.
- Console production build passed. Existing bundle-size advisory remains.
- Design check passed with no failures; existing answered container finding remains. No new visual system is introduced.
- Browser verification is delegated to Master through CUA. It is not claimed by this checkpoint.

Tests cover exact synthetic source hash/locator slices; blank confirmations and allocations; stale policy/revision decisions; explicit partial merge allocation; wrong/duplicate/over-limit physical IDs; declared return evidence; parser versus physical accrual IDs; controller/current-human separation; expired/missing/not-allowed authentication; cross-user cookie rejection; origin/CSRF and authority injection; absent capabilities.

## Synthetic browser reproduction

Use the existing isolated Vite preview on 5191:

`/@fs/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks/docs/ap-orchestration/evidence/D2-browser/fixture.html?apFixture=physical&case=synthetic-pending&apView=matching`

- `apFixture=physical`: already-approved **synthetic** two-bin mapping, blank business allocations. Select receipt `merged-receipt`, choose the map, claim `1` and enter `0.4`/`0.6`; the exact total passes. `0.4`/`0.5` does not.
- `apFixture=physical-review`: pending synthetic reparse review against the immutable catalog. Decision, reason and confirmation are blank.
- `apFixture=physical-initial`: proposed synthetic initial catalog and no existing capacity inventory. Compare source text, physical locators and complete map.
- Period close / accrue: select the synthetic receiving original and supplier, then one exact physical line. Parser row and frozen source facts appear, but quantity and quote remain blank.
- Use the fixture palette control for light/dark and CUA viewport controls for desktop/mobile.

All these originals, identities, decisions and capacities are explicitly synthetic. Physical proposal/decision submission returns a fixture-only rejection; it never manufactures successful approval or makes a backend/provider request. Other fixture modes get an explicit empty physical inventory for compatibility. No live backend, goods receipt, human identity review, bank action or external accounting acceptance is claimed.
