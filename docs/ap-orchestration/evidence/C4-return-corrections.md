# C4 approved bank-return correction and restored payable

Scope: credential-independent code and local mock transport. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; integration baseline `f8516492e41744f1290ece5b097a6484402184b8`, with B current-seat authority correction `d1f747ceb0bdb6effdb2e81746ef8db5e94c8a6e` applied locally as `0bfdf9c`.

## Authority and accounting behavior

A controller proposes a `bank_return` correction using case, original payment version and return transaction IDs. The backend resolves and binds the original recognized invoice, frozen command, negative posted debit and settlement journal, current returned observation, positive posted return and return journal, supplier, accounts, USD amount and date. It requires an open period and a current supplier/business policy. Sequential amount-band approval plus the explicit finance/variance group uses current authenticated human seats, delegation, quorum, and proposer/case-creator independence. It creates no new local cash/AP journal.

The external operation creates a balanced JournalEntry: debit the explicitly mapped bank account; credit the explicitly mapped AP account with Vendor entity. It requires the successful original external BillPayment bound to the exact local payment command/debit/journal. The original external payment and its submission approval stay unchanged. Its operation identity is derived from organization/run/return transaction, with immutable payload/mappings and stable requestid. Lost responses enter unknown and reconcile by the same marker; absence does not permit reposting.

A later `payment_allocation` separately authorizes how one verified settled payment applies to the original Bill and each restored JournalEntry. The backend checks exact gross=original+restored, cash+credits=gross, same bill/vendor, distinct correction IDs, available restored principal and original Bill principal. Its BillPayment links exact Bill/JournalEntry/VendorCredit IDs; `TotalAmt` remains verified cash. It does not initiate a bank transfer. Before a write, the dispatcher verifies dependencies and reads external Bill/VendorCredit balances. JournalEntry principal is checked against a bounded vendor BillPayment query, including externally created payments; duplicate, incomplete or ambiguous rows fail closed.

## Hold and verification seam

`dispatcher.checkHolds(request)` makes **no provider calls**. It loads authenticated backend authority and compares a private durable verification receipt against the correction proposal hash, mapping hash, operation hash, externalId and SyncToken. Missing/stale authority or proof yields a controller-owned hold. Ordinary status must use this default.

Only explicit `checkHolds(request, {verify:true})` or the dependency checks of an approved submit read QBO. Read verification stores a success/failure receipt. A failed read invalidates the local proof. Verified matching correction receipts resolve only covered historical return hold IDs, retaining the original hold plus explicit resolution proof. They do not resolve unrelated or late-activity holds. Successful POST response alone does not release a return hold. Status presents the receipt as historical verification, not a live provider assertion.

Selectors: `correctionId` is mutually exclusive with `paymentVersionId` and `creditApplicationId`. Controller `propose`, authenticated human `vote`, `proposals`, and `current` are exposed by `apAccountingCorrections`. The authority table is isolated in `apAccountingSchema.ts` with a narrow root schema import/spread.

## Primary-source basis and limits

The [official BillPayment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) documents Bill, VendorCredit and JournalEntry links, filterable VendorRef, and Check/BankAccountRef payment accounting. The [official JournalEntryLineDetail schema](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/JournalEntryLineDetail.html) defines PostingType, AccountRef and Entity. The [official JournalEntry definition](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/124adc26-3988-e8ee-c447-c1ada39393fe.htm) describes balanced debit/credit journals. Docs were rechecked on 2026-10-25; the dynamic API page sometimes returns a sign-in shell, while official indexed reference content supplied the linked-transaction detail.

These documents support the schema representation. They do **not** prove acceptance of this exact operation by an actual sandbox. No credentials, grants, provider API calls, bank calls, browser actions or persistent backend writes were used in this work. Real QBO acceptance remains NOT_RUN. Existing grant/token state was untouched.

Explicit remaining holds: bank returns without an already successful original external BillPayment; partial/multiple returns, missing/unposted/closed return evidence, unresolved late transfers; credit-only application to restored payables (needs a separate allocation authority); changed policy/supplier requiring recertification; B4 cost/accrual adjustments pending its authoritative export. These are not silently labeled fully synchronized. No update, void or delete API was added.

## Local evidence

The local protocol suite exercises original Bill/partial BillPayment → verified returned bank evidence → independent approval → return JournalEntry → read-verification → exact split replacement BillPayment. It checks original operation preservation, durable hold resolution, no-provider-call status, changed external journal detection, lost response/no repost, external restored-principal consumption, sequential approval, seat independence, stale evidence, closed/unposted return, duplicate allocation, wrong sums and exhausted allocation capacity. All originals/provider rows in these tests are synthetic test-owned data.

Commands:

- `node_modules/.bin/vitest run tests/ap-system/quickbooks*.test.ts`
- `node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false`
- `node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false`

Exact results are recorded with the implementation commit report. Root owns runtime/UI composition; no claim is made that these selectors are deployed before that integration and independent review.
