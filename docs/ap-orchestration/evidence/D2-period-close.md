# D2 period close engineering checkpoint

This is the D-owned UI and HTTP/service contribution to B4. It is not practitioner acceptance, a live period-close assertion, external bank execution, or a QuickBooks sync result. The independent accounting core checkpoint supplies the source-capacity, period-lock, accrual and approval invariants. Master owns the isolated multi-human live runtime and its economic data.

## User flow

Open **Period close** and choose an accounting month. The view shows AP GL versus supplier subledger, accrued liabilities versus outstanding accruals, opening cash/AP/accrual balances, owned blockers, supplier movements and unpaid bills carried forward. Recorded zeros are displayed as recorded; the close review starts with blank reviewed amounts and requires exact opening ledger/bank evidence.

Upload statements or opening records as Other or Correction, then retain the selected exact original. The browser sends only source ID/revision/hash. The request-owned human client resolves `apCases:source`; the service verifies the binding before passing the full server-held original to the scoped AP agent's `apClose:retainEvidence`. Arbitrary original bytes, metadata, caller identity and agent credentials are not accepted from this UI route.

A controller proposal can retain a supplier statement, explicitly match each printed line to a recorded bill, credit, payment or return, or leave it unmatched. Finance review binds the statement hash and **reconciliationHash**, with separate evidence and explicit classification for every discrepancy. Arithmetic/date/duplicate-line errors require a corrected proposal; an explanation does not override malformed statement facts.

The treatment form supports accrual, partial reversal, controlled cost reclassification and evidence-backed disposition of an exact current blocker. Accruals name original line, SKU, unit, capacity, accepted quantity, exact quote, cost allocations and accounting date. Reclassification preserves the original journal and cannot change cash/AP/accrued liability through this form. Dispositions bind **reconciliationHash**. Close binds **snapshotHash** plus explicit opening review; reopen binds the latest approved close. Each remains a proposal until a distinct authorized current human completes the configured route.

The invoice business form preserves invoiceDate and permits an explicit accountingDate, with same-period allocations and finance approval enforced by B4. It discovers as-of outstanding supplier/SKU/unit accruals and permits explicit quantities by immutable accrual ID; it does not consume an accrual automatically. This connects late invoice recognition with exact reversal of earlier accrued cost.

## Boundaries

`GET /api/ap-system/close/:period` and `POST /api/ap-system/close/{retainEvidence,proposeStatement,reviewStatement,propose,vote}` retain the established subject-bound session, Origin and CSRF checks. Reads, source resolution, statement review and votes use the request-owned human. Statements and close actions require the separately configured controller agent; missing controller configuration fails closed. Source retention uses the scoped AP agent after current-human source resolution.

Proposals and votes keep a stable idempotency key for the same operation/payload within the mounted workspace. A source, policy, accounting date or snapshot change must be reevaluated by the backend. Approval controls do not alter bank authorization or QuickBooks receipts.

## Verification artifacts

The explicit synthetic fixture at `D2-browser/fixture.html?apWorkspace=close&apPeriod=2026-10` renders the same workspace with entirely mocked transport. Its banner distinguishes synthetic humans, balances, statements, accruals and actions; no request is forwarded. A simulated successful form response is not a real journal or period status change.

Focused source authority/HTTP tests cover exact original resolution, substituted or inaccessible source denial, request-owned votes, missing-controller denial, session enforcement and caller-metadata rejection. Render checks cover nonzero opening balances, owned blockers, current quorum/hash, disabled confirmation and signed-cent precision. Validation after B4 c923b33 plus its d1f747c/ff0172b and QBO fixture43099702 dependencies: all 260 AP-specific tests in 29 files pass, including 9 new close transport/render tests. Main, tests and backend typechecks pass. Console build passes with the existing large-chunk advisory. Static design check: 0 FAIL, 0 WARN, 1 previously answered rule. The synthetic fixture is ready for Master-owned CUA review; responsive screenshots and real multi-human close acceptance are not claimed by this checkpoint.

## Period accounting completion checkpoint

The Period close workspace now offers approved posted accrual/reversal/reclassification actions for QuickBooks status, local preview, explicit plan approval/submission, and separate external verification. Case-less journals retain null case/bill links and their exact close action or accrual-application identity. No fake case ID is created. Status and preview use the root-owned bridge and do not contact QuickBooks. Local FakeBank explicitly reports external period sync as unsupported; configured local mappings permit review only. Historical receipts retain original submission subject/hash/time and never imply current synchronization by themselves.

A narrow, parent-authorized read-only addition to `apClose:view` exposes immutable accrual applications posted in the selected accounting month. It includes exact IDs, date, quantity, amount, optional linked case/action, and current export-authority availability. The existing authoritative export loader is consulted for availability and remains responsible for submission-time authorization. The projection adds no posting or approval, exposes no source bytes or allocation payloads, and does not change period reconciliation or close snapshot hashes. The UI can discover invoice-triggered reversal receipts directly rather than requesting pasted IDs.

Validation: 32 focused period core/runtime/UI tests pass, including the actual invoice-triggered reversal inventory and unchanged snapshot assertions. Main, tests and backend typechecks pass; console build passes with its existing chunk advisory; design check remains 0 FAIL/0 WARN. Synthetic fixture `?apWorkspace=close&apPeriod=2026-10` now includes one approved posted accrual action and a local $20 JournalEntry preview. CUA screenshots and provider/practitioner acceptance remain separate and pending.
