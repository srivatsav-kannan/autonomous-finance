# Inspecting saved AP worker operations

The `/ap-system` case **History** tab now displays `timeline[].agentTransition`
from PR #113. This frontend continuation is based on
`81dd714f4f8ea49e7795979605c174a6ac954819` and targets
`codex/ap-agent-transition-evidence` while #113 remains open. #113 itself depends
on #109. No backend, shared contract, payment execution, ledger or configuration
code is changed here.

Expand a worker event with Enter or Space to see recorded values before and after
that one operation. Changed fields appear first; unchanged fields remain available
in a second disclosure. The view includes all six status dimensions, seven amounts,
worker status/stage/owner/role/requirements, case and source revisions, snapshot
hash and policy version. Operation IDs and lease information are kept in details.

The saved reason and actor ID are displayed without inventing an executor, model
or real human identity. Amounts use integer arithmetic to preserve every cent,
including `Number.MAX_SAFE_INTEGER`. Null is **Unknown (recorded null)**; zero is
**0.00 (0 cents)**. A current candidate's currency is never applied to old snapshots.

Each operation explicitly identifies the bill, authorization and execution states
already present in its **before** snapshot. Neither an approval nor a bank
settlement first observed there is attributed to the worker. This is not a complete
audit of denied requests. Events without transitions remain readable and have no
invented historical diff.

References identify whether they appear before, after or on both sides. Decisions
link to their existing History entries. Bills, payments and journals open Accounting
only when the scoped current case contains the corresponding record. These links
show current records, not reconstructed historical state. Other references remain
plain identifiers, including provider IDs; they never become guessed external URLs.

## Stored-fixture demonstration

```sh
npm exec tsx scripts/testing/ap-history-fixture-server.ts
```

Open `http://127.0.0.1:5197/ap-system?fixture=missing-receipt`. Set `AP_HISTORY_PORT`
to use a different port. This separate development server mounts the actual app,
including its case queue and History tab. Its banner labels the evidence as stored
fixtures. It supplies a synthetic runtime response and in-memory list/detail
responses; every other fetch fails locally. It does not contact an AP backend.

The selector provides:

| Fixture | Saved observation |
| --- | --- |
| Missing receipt | Operation 1 hands the wait to `receiving_owner`, requiring accepted receiving evidence. |
| Later evidence revision | Operations 2–3 already observe case revision 2 and the added receipt in **before**; no revision change is fabricated within the operation. |
| Independent approvals | Operations 4, 6 and 9 observe the recorded field review, bill approval and payment authorization. |
| One payment proposal | Operation 8 first contains one payment version in **after**; bank execution stays not started. |
| Settled history | Operations 11–12 already observe bank settlement in **before**, then finish the worker stage. |
| Legacy | Prior stored events without transition snapshots. |
| Empty / long | Explicitly synthetic layout edge cases, not saved business events. |

Operation indexes above are zero-based indexes in the stored export. Every normal
worker snapshot comes unchanged from
[`agent-transition-v1/case-transitions.json`](evidence/agent-transition-v1/case-transitions.json).
The surrounding case shell and review decisions come from the prior
[`agent-case-v1/agent-case-flow.json`](evidence/agent-case-v1/agent-case-flow.json).
Final amounts, states, links and journals use the #113 export. This is a transparent
composition for UI inspection, not a claim of another backend execution. The older
fixture's payment is deliberately omitted: its ID differs, and #113's export does
not retain a complete payment detail or beneficiary. Its new payment reference
therefore remains an honest non-actionable identifier in this viewer.

The implementation does not import these fixtures into the production bundle.

## Validation and screenshots

Implementation revision: `1b1c0ae1e840710cb58e64ae4d2791a814cf1dd1`.
Exact source and image hashes are in the
[evidence manifest](evidence/agent-history-ui-v1/manifest.json).

```sh
npm exec vitest run tests/ap-system/agent-history.test.ts tests/ap-system/agent-history.browser.test.ts
npm run typecheck
npm run typecheck:tests
npm run build:console
npm run design:check
npm run design:review -- --url 'http://127.0.0.1:5197/ap-system?fixture=missing-receipt'
```

Eight presentation tests and one mounted browser test pass. Browser checks cover
Enter/Space expansion and collapse, visible keyboard focus, decision anchors,
Accounting navigation and return, refresh, null versus zero, legacy/empty events,
and long reasons, actor IDs and operation IDs. Missing-receipt layouts are checked
at 1280, 1440 and 390 pixels in light and dark mode with reduced motion enabled.
There are no horizontal overflows, uncaught exceptions or API network requests.
Application and test typechecks and the console build pass. No backend tests were
rerun for this frontend change.

Static design lint has no failures or warnings. Rendered review has no failures;
it reports four font weights in the app and the existing waived tall case-queue
button. The build reports the app's large bundle warning. These are recorded rather
than widened into a console redesign.

- [Laptop workspace](evidence/agent-history-ui-v1/missing-receipt-light-1280.png)
- [Desktop dark workspace](evidence/agent-history-ui-v1/missing-receipt-dark-1440.png)
- [Phone workspace](evidence/agent-history-ui-v1/missing-receipt-light-390.png)
- [Missing receipt detail](evidence/agent-history-ui-v1/missing-receipt-light-1280-detail.png)
- [Later evidence revision](evidence/agent-history-ui-v1/evidence-revision.png)
- [Independent approval observations](evidence/agent-history-ui-v1/independent-approval.png)
- [One proposal detail](evidence/agent-history-ui-v1/payment-proposal-detail.png)
- [Settled history detail](evidence/agent-history-ui-v1/settled-history-detail.png)
- [Legacy history](evidence/agent-history-ui-v1/legacy-history.png)
- [Empty history](evidence/agent-history-ui-v1/empty-history.png)
- [Long identifiers on phone](evidence/agent-history-ui-v1/long-ids-phone.png)

## Contract follow-ups, outside this patch

- To label historical currency, retain currency in the versioned transition
  contract. Until then this UI shows a decimal equivalent and exact cents only.
- To show model selection or independently verified human/executor identity,
  retain explicit provenance fields. Actor/lease owner strings alone are insufficient.
- External accounting IDs and provider-specific links need saved, scoped linkage;
  the UI does not invent them from a current setting or a provider-shaped string.
- Dedicated wait-reason fields are absent. This view preserves the event reason
  and the saved stage/requirements instead of reconstructing a before-state reason.

The Mac Studio sandbox, current live case, approval workflows, provider settings
and other chats were not modified or messaged. No deployment or merge was performed.
