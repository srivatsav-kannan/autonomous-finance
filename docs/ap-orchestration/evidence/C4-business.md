# C4 business accounting expansion — local evidence

Source baseline: `d6e8ee2751ed2d16a8b5f1ff33f75ce736edb42a`. Branch: `codex/ap-system-qbo-business`. First increment: `39f72bd7b7d61629773890a6d5f65a640aa4be99`. Frozen spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Shared contracts, schema, generated API, runtime bridge, service/UI, setup guide and canonical registry are outside this change. Content hashes accompany this report in `C4-business.json`.

## Behavior

- The authenticated `apAccountingExport:current` query consumes B3's original approved revision, accepted allocations and independently checked posted journal. A 7700-cent invoice accepted at 3850 exports a 3850-cent Bill while preserving the original candidate. Current extraction changes never recost recognition.
- Linked approved credits export as VendorCredit, with original Bill, approval, revision, snapshot and reversal-journal identity. Vendor and account mappings are explicit and frozen per operation. Unsupported negative discount cost allocations produce an owned hold; they are not silently netted into another account.
- A selected matched Increase sandbox settlement can pay part of one Bill. Its actual cash is distinct from gross payable application. Cash 3850 plus credit 3850 against a 7700 Bill yields BillPayment TotalAmt 38.50, Bill linked amount 77.00 and VendorCredit linked amount 38.50. All existing command/hash/observation/posted-debit/journal tests remain enforced. Multi-bill payment export remains unsupported.
- Explicit `creditApplicationId` exports the existing human-authorized, scoped B3 application receipt. Multiple per-credit rows share one immutable request key; all are checked against consumed same-vendor credits and the durable operation receipt. Credit-only application produces a zero-total BillPayment linking the target Bill and exact external VendorCredit IDs. It creates no bank command or local settlement journal.
- Before a first external POST, dependencies must be successful in the same realm and mappings, exact external payload/SyncToken must match, and Bill/VendorCredit balances must cover application amounts. Same-host writes are serialized per realm, including distinct operation keys, so dependency checks cannot race another local write. Authority is reloaded after network waits.
- `Operation.submissionAuthorization` records authenticated export subject, approved plan hash and server decision time before the first POST. A changed prewrite subject is rejected. Existing recovery/readers preserve the original approval; historical receipts without this field are not relabeled. Payloads, request IDs and external identities remain immutable. Empty or ambiguous responses remain unknown and are never automatically reposted.
- Historical returned versions, returned/late commands, returned observations and return transactions produce `SyncHold` even on bill-only requests. Submit persists a private hold record; successful original operations remain unchanged. Holds are controller-owned and require an explicit correction representation before clearing.

## Verification

```sh
node_modules/.bin/vitest run tests/ap-system/quickbooks-business.test.ts tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/quickbooks-protocol.test.ts tests/ap-system/quickbooks-export.test.ts tests/ap-system/quickbooks-runtime.test.ts tests/ap-system/business-credits.test.ts tests/ap-system/business.test.ts tests/ap-case-payments.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
```

Result: **61/61 tests in eight files passed; all three TypeScript checks passed.** Tests use authenticated Convex-test queries, synthetic bank evidence in test-owned memory, private temporary files and independent mock HTTP responses. Covered new cases include partial recognition/cash; exact cash+credit and zero-net links; corrupted original journals/application receipts; missing external credit; insufficient balance and durable conflict; unknown zero-net recovery without repost; returned observation hold preserving both successful Bill and BillPayment; changed requester rejection; original approval preservation on another authorized reader's retry; and same-realm serialization.

An earlier existing test expected a returned observation query to throw. It was updated to assert the new explicit hold and that plan construction still refuses it. This is the intended state representation change, not a relaxed write gate.

## Primary sources and external gate

Checked 2026-10-25. The official [BillPayment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) documents Bill, VendorCredit and JournalEntry links, nonnegative TotalAmt, Check/CreditCard pay type and CheckPayment. The [billing tutorial](https://developer.intuit.com/app/developer/qbo/docs/develop/basic-implementations/basic-billing-implementation) supplies account-based VendorCredit examples. The official [VendorCredit SDK schema](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/VendorCredit.html) exposes Balance. Missing balances fail closed.

Zero-net creation follows the nonnegative-amount rule and linked-transaction model; this is an implementation inference, **not measured live sandbox acceptance**. An empty/normalized response cannot count as success. The strict expected entity and full payload must be returned or subsequently reconciled with the same marker. No fresh request identity is generated.

For future immutable return remediation, the [JournalEntry line schema](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/JournalEntryLineDetail.html) includes debit/credit, account and Vendor entity information, and BillPayment permits JournalEntry links. Dr Bank / Cr AP and a replacement payment linked to that restored payable are a candidate design only. They require B4 approved local correction authority and independent accounting/API validation. No void/delete of original external history is implemented; the interim hold is not a claim that return handling is complete.

Live Intuit requests, grants, external Bill/VendorCredit/BillPayment IDs and provider writes for this increment: **NOT_RUN**. Owner setup is progressing separately under Master; this work loaded no credentials and started no service. Runtime/UI hold handling and authenticated route wiring remain Master/D integration work. Narrow USD account-based support, conservative SyncToken/provider normalization conflicts, multi-bill export, signed discount allocation representation, correction/return sync and actual sandbox acceptance remain explicit limits. Acceptance remains Master-owned.
