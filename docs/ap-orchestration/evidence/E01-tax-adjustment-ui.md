# E01 explicit tax adjustment and adjusted-credit UI

Backend prerequisite: B `a5aaa71` (local cherry-pick `e827078`), following `8598cc7`. This checkpoint adds desktop UI and transport only. It does not change a live policy, backend economic record, provider, real eligibility decision, or approval.

## Authority and source of values

`GET /api/ap-system/close/tax-state/:originalEntryId` invokes `apClose:taxState` through the current request human and the server-owned scope. It uses the existing protected HTTP session. The browser cannot provide scope or an acting identity. Tax proposals use the existing controller `close/propose` route; votes still use the current independent human `close/vote` route.

The operator explicitly selects a recognized original invoice. Tax and cost reads must bind the same original journal and current cost snapshot before the editor opens. Read failure remains visible and blocks review. Tax balances, original approval ID, line identity, exact allocation lineage, dimensions, cumulative credit basis, event history and snapshot hashes come from these authenticated read models.

The policy editor leaves `recovery.adjustments` absent by default. Its explicit choice names reviewed remaining tax, original allocation attribution and cumulative latest-adjustment credit rounding. A supported explicit 0% policy remains possible. The UI does not infer a tax rate or change eligibility by itself.

The adjustment form begins with blank date, targets, attribution, movements, reason, citations and confirmation. The current policy-derived target is displayed as a calculation; the operator enters the reviewed target. Each original tax line needs an exact target. Nonrecoverable cents without an established bucket require explicit attribution to reachable original cost shares. Store, department and project remain attached to those shares. Movements select existing buckets and approved noncash accounts, cannot consume a bucket twice or reuse an intermediate destination, and must achieve all declared targets without exceeding current posted dimension balances.

Eligibility support is selected from exact current uploaded originals that were retained for close, limited to Other, Contract and Correction. Every citation preserves source revision/hash, page, complete text span, quote and raw value. No citation, claim or checkbox is filled automatically. This initial UI discovery subset is narrower than backend retained-source authority; an otherwise supported source can be made discoverable through current upload/retention.

The existing close approval history shows the immutable tax action and independent tax route. The proposal creates no automatic approval. It is a noncash reclassification and does not alter original invoice totals, AP, settlement or bank authorization.

## Credits after a posted tax adjustment

A credit against an original recoverable-tax claim loads current tax state. Before any posted adjustment, existing original-tax behavior remains usable. After an adjustment, the operator reviews explicit current bucket shares. Their total must equal each credited tax amount, the recoverable portion must match cumulative rounding, and each bucket must have capacity. A zero-tax credit requires an explicitly reviewed empty plan. Changing the original, credit lines or posting date invalidates that review. Refresh reloads current tax history. The resulting `credit.taxReversal` binds the exact current tax snapshot and is sent with the separate business proposal.

## Verification

- 116 focused tests passed across new tax UI/HTTP tests, existing tax policy/header/adjustment backend tests, close, cost and authenticated HTTP regression suites.
- Eight new focused tests cover blank controls, exact snapshots and dates, wrong source material, required policy opt-in, duplicate bucket consumption, cross-dimension capacity, original cost attribution, current-credit cumulative rounding, zero-tax review, and controller/current-human transport separation.
- Main, backend and full-test TypeScript checks passed.
- The synthetic browser fixture entry also passed an isolated TypeScript check.
- Console production build passed; the existing bundle-size advisory remains.
- Design check reported zero failures and warnings, with one existing answered finding.
- No browser, practitioner or real-provider acceptance is claimed in this checkpoint. Master performs desktop CUA.

## Desktop component fixture

Use the isolated experience preview's `D2-browser/fixture.html?apFixture=tax-adjustment` URL. The page is explicitly synthetic and renders only the tax adjustment component; it does not imply an end-to-end economic case. Open “Propose a reviewed tax eligibility adjustment,” select the synthetic original invoice, and inspect exact $8.50 remaining tax. The explicitly synthetic current rule is 50%, so a 2026-10-31 date displays a $4.25 target without entering it. The original recognition was 100%; a distinct retained synthetic eligibility-change document supports the separate proposed change.

All controls and confirmation begin blank. To exercise local validation, explicitly enter $4.25 as target, add a movement of $4.25 from the exact 1180 bucket to its supported cost account, and enter a citation against `synthetic-tax-change-support`. The fixture never forwards HTTP to a backend or provider and does not report proposal/approval success. Light and dark desktop checks are pending Master CUA.

## Historical accounting receipt UI follow-up

Prerequisite type seam: A `d33c7dd` (local `773a6b8`). Approved posted `tax_adjustment` actions are selectable by original action ID in period QuickBooks synchronization. Tax journal plans use the tax eligibility title rather than bank-return wording.

When status supplies `authority: historical_receipt_only`, the UI explicitly says current write authority is unavailable. New preview and submission are disabled even if a contradictory write flag were present. Readback requires explicit `externalReadsAllowed` in this mode. Succeeded receipts retain ordinary verification; sending/unknown receipts get an opt-in “Recover existing external request” control. Prepared requests cannot use this path. Ordinary case receipt controls are unchanged because recovery is enabled only by the period caller.

This follow-up consumes the runtime's permission flags; the provider-free historical status fallback and GET-only recovery implementation remain A's separate checkpoint. No actual provider call or historical recovery was performed here. Three new focused tests cover tax action selection/title, historical read/write separation and sent/unknown/prepared recovery controls. All 25 focused UI/close transport tests, three TypeScript checks, console build and design check passed.
