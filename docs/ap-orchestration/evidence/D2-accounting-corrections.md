# D2 accounting correction interface

Engineering/UI checkpoint only. All new validation uses local unit/HTTP mocks and explicit synthetic fixtures. No live QuickBooks request, accounting submission, new bank instruction, local posted correction or external record is claimed by this contribution. Master owns external authorization and provider execution. Browser review and independent acceptance are separate.

## Exact authority and user actions

The same-case Accounting view lists immutable correction proposals. A bank-return proposal selects a same-case returned payment and an independently retained **posted** return transaction. The browser sends only case/payment/transaction references and a reason; the backend derives amount, original debit, cash/AP accounts and existing posted return journal. It does not accept caller overrides for those facts.

A later-payment allocation selects an independently settled same-case payment. The human enters the exact gross amount assigned to the ordinary Bill and explicit amounts assigned to previously approved restored payable correction IDs. The UI labels original returned amounts, never presents them as remaining capacity, and never guesses a repayment target from amounts or dates. The backend rechecks actual remaining capacity and exact gross allocation.

Proposals use the separately scoped controller agent. Votes use the request-owned authenticated human, exact proposal hash and current policy route. The HTTP case route is checked both for proposals and for votes: the human-readable proposal inventory for that case must contain the voted ID before invoking the backend vote. No simulated selection token is accepted by external Auth0 mode.

After approval, **QuickBooks accounting sync** includes the correction as an explicit target. `correctionId` is mutually exclusive with `paymentVersionId` and `creditApplicationId`; saved correction receipts retain correction selection ahead of their original payment link. A return plan renders a balanced JournalEntry restoration, not an expense or another payment. A later settlement plan shows gross obligation, restored-payable amount, supplier credits and net cash separately. Approval of authority, approval of an external plan, submission, and external readback remain separate actions.

The root-owned runtime checks current authority and stored correction verification on status without provider requests. Explicit **Verify external record** may request provider readback and refresh current hold status. The UI never clears a hold itself and never treats a past successful receipt as proof that a current remedy is complete. Signed GL cost/discount lines remain visible in the exact payload.

## Routes and composition

- `GET /api/ap-system/cases/:caseId/corrections`: current-human proposal inventory and controller readiness.
- `POST /api/ap-system/cases/:caseId/corrections/propose`: strict typed controller proposal.
- `POST /api/ap-system/cases/:caseId/corrections/vote`: exact proposal/hash with current human authority and selected-case validation.
- Existing accounting preview/submit/verify accepts optional `correctionId` as the sole event selector.

All retain existing subject-bound cookies, Bearer identity, Origin and CSRF rules. Page load and ordinary status do not invoke preview, submit or verify. No JWT input or provider token reaches the UI.

## Validation and reproducible fixture

275 AP-specific tests across 32 files pass. Main/tests/backend typechecks and console build pass; the pre-existing chunk-size advisory remains. Static design check: 0 FAIL, 0 WARN, 1 previously answered rule. New focused tests cover missing-controller denial, caller bank override rejection, request-owned human votes, cross-case vote denial, strict session/identity boundaries, exclusive correction selection, saved-receipt selection precedence, balanced JournalEntry amount rendering and disabled explicit approval.

Own preview5191 fixture path:
`/@fs/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks/docs/ap-orchestration/evidence/D2-browser/fixture.html?case=synthetic-approved&apView=accounting&apFixture=corrections`

This displays one explicitly synthetic approved return correction. Select **Approved return journal**, then **Preview accounting plan** to inspect the synthetic balanced $52.75 JournalEntry. External writes remain disabled. `apFixture=correction-review` shows the pending synthetic correction with disabled vote controls until explicit reason/confirmation. The fixture owns all mocked fetches and never forwards requests. CUA screenshots remain a pending Master-owned review at this commit; these tests are not live provider or practitioner evidence.

## Restored supplier-credit allocation — D completion

The correction editor now supports the final `credit_allocation` contract. A human selects an existing same-case credit receipt, reads its whole authoritative application group, then enters the exact original-bill and restored-payable portions. Those portions must sum to the recorded gross total. Net bank cash is shown as zero; no credit is consumed again and no bank command is created by this flow. A controller proposal, independent human vote, external preview/approval and explicit verification remain distinct steps.

A receipt row is not necessarily the group total. The new read-only `apAccountingCorrections:creditApplication({scope,caseId,creditApplicationId})` query requires the current human, verifies the scoped recognized invoice and reuses `accountingCredits.creditApplication`. The HTTP bridge is `GET /api/ap-system/cases/:caseId/credit-applications/:applicationId`; browser method `apSystemApi.creditApplication`. It returns the exact existing application IDs, total and credited original recognitions. No mapping, provider request, approval or export rule changes during the read.

The immutable proposal review and accounting plan now distinguish restored-credit allocation from a later cash settlement. Receipt verification continues to prefer `correctionId` over the aliased credit application ID. Neither a local approval nor a historical external receipt is presented as verified current synchronization.

Validation: 64 focused UI, HTTP/service, period and cost tests pass, including a real test-backend application of two synthetic recognized credits. Both component IDs read the same $11.00 group; unauthenticated, cross-case, cross-scope and revoked-human reads fail. The read creates no journal, command or correction. Main/tests/backend TypeScript, console build and design checks pass (0 failures / 0 warnings; existing chunk-size advisory). No real provider operation was performed. Browser acceptance remains Master-owned.

Synthetic browser routes at the D `5191` preview:
- `.../D2-browser/fixture.html?case=synthetic-approved&apView=accounting&apFixture=credit-review` shows an immutable pending credit allocation and the new proposal form. Select **Allocate an existing supplier credit application**, then either receipt component: the group is $52.75 ($25.00 + $27.75), with zero cash. An example explicit allocation is $32.75 original plus $20.00 restored.
- `...&apFixture=credit-allocation` provides an approved synthetic allocation selector for a provider-free zero-cash BillPayment preview. All mock requests remain intercepted; this is component/transport demonstration, not integrated or live accounting evidence.

The cost browser fixture was also corrected to match its separate period example: a $20 accrual with no discount or store, $10 still in expense and $10 in inventory. Signed-discount tests now use a separate bill-only fixture and cannot appear as an inconsistent $19 accrual browser example.
