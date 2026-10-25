# C4 restored-payable credit-only application

Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Authority checkpoint `3f9a3fc0d1c4d0c2605ddd031a0a8a888920d88b`; the separately reviewed query-envelope correction is `78532b33f0c5752525c7a2f9c148c92887bf6387`.

## Implemented workflow

The local application remains the existing authenticated `apBusiness:applyCredits` operation. It consumes already recognized supplier credit and updates the bill application balance, retaining original recognition journals; it creates no bank command, version, transaction or additional journal. The new controller proposal then binds that exact immutable application receipt, recognized credit export, original Bill and restored-payable portions. It does not consume credit a second time.

New strict correction request:

```ts
{
  kind: "credit_allocation",
  caseId,
  creditApplicationId,
  originalBillCents,
  restoredPayables: [{ correctionId, amountCents }],
  idempotencyKey,
  reason
}
```

`apAccountingCorrections.propose/vote/current` reuse current explicit policy amount routes, finance/variance authority, distinct retained human seats and delegation checks. Application identity is canonicalized to its original immutable group; aliases cannot create a second correction identity. The exact application amount must equal original plus restored principal. Cash and credit allocations share the same returned-principal budget. The selected application is excluded from its own original-principal consumption; other approved credit allocations contribute their explicit original portion once, rather than treating every credit row as a second Bill application.

`apAccountingExport.current` supports either the approved `correctionId` or an original `creditApplicationId` alias. The returned `credit_allocation` contains the same immutable application and recognized credits. `allocatedPaymentPlan` handles both cash and credit allocation shapes. The external BillPayment has `TotalAmt:0`, positive exact linked original Bill and/or restored JournalEntry portions, and exact linked VendorCredit amounts. It uses the existing CreditApplication effect identity and stable requestid; changing selectors does not change its financial effect or submission actor. An existing differently allocated operation conflicts instead of being rewritten.

## Verification and hold semantics

The dispatcher verifies all required return JournalEntries, the original Bill and VendorCredits, exact external balances, and the bounded vendor BillPayment history for restored principal before an authorized first write. The application hold is preserved through preview, a successful return JE, and an unknown BillPayment result. It resolves only when that exact allocation operation has succeeded and a fresh read matches its immutable payload/SyncToken. Resolution retains both return-JE and application receipt proofs. Failed application readback creates a durable controller-owned `restored_application_verification_required` hold; it cannot disappear on the next provider-free status read.

Runtime integration must call `checkHolds(selectedRequest,{verify:true})` after explicit allocation verification, retaining the payment/credit/correction selector. A caseId-only check can verify return journals but cannot resolve a specific application hold. Default `checkHolds(request)` and dry-run still make no provider calls. Root owns request-bound runtime/UI composition.

## Measured local evidence

The independent local protocol exercises $38.50 credit applied as $18.50 original Bill plus $20 restored JE, with zero cash, and a pure $20 restored-JE application. Tests cover canonical selector replay, unchanged submission approval, preserved local bank/journal history, pending/changed/seat-conflicted authority, wrong sums/case, shared cash-credit principal exhaustion, changed application receipt, lost response with fixed identity/no repost, and saved hold release only after exact readback. Local B4/QBO regression commands and all TypeScript checks are recorded in the checkpoint report.

This extends the [official BillPayment linked transaction representation](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) already cited in C4-return-corrections.md. It is local/mocked evidence, not proof that this exact zero-cash JE+VendorCredit payload has been accepted by a real QBO company. This agent made no live provider calls and did not inspect or modify grants/tokens.

## Independent V5-F2 correction

`QboClient.find` and `journalAppliedCents` now require a valid object QueryResponse, correct entity-array shape, valid row identities and coherent pagination metadata. Missing/malformed HTTP 200 envelopes are errors rather than evidence of no duplicate or no applied principal. Valid Intuit `QueryResponse:{}` remains an empty result. Dedicated regression tests cover these shapes; the independent verifier retains its original full-protocol reproducer.
