# Governed corrected-cost credits and accrual reversals

Spec: b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565. Parent-authorized B3/B4 follow-up, separate from independent frozen V5 review. No acceptance claim, live backend/provider calls, funds, or registry changes.

## Behavior

A later linked supplier credit after cost reclassification still holds unless its request includes an explicit correction plan. The server reconstructs remaining cost from the original immutable journal, approved reclassification journals, linked credit journals and accrual application journals. It checks journal hashes, exact source/allocation linkage, supplier/store identity and signed remaining capacity. Correction journals cannot be used as fresh capacity roots. Further reclassifications reference the original root and may move only cost still remaining there, including amounts previously transferred into a corrected account.

Each corrected credit allocation identifies its original line and allocation index. Its signed side, exact remaining proportional cent share, original store, cumulative net/tax and return-unit controls remain unchanged. Replacement accounts must be configured noncash cost accounts and reachable through an approved correction path. Signed discount reversal remains explicit; it cannot be converted into extra cost credit. The final mutation re-evaluates the cost snapshot and current independent approval route, including the variance group. Concurrent credit, reclassification or reversal invalidates an earlier snapshot. Original journals remain untouched; the existing single vendor-credit recognition debits AP exactly once. There is no extra bill or cash command.

Accrued cost can now be reclassified through the same independent close-action route. Later manual reversals and invoice-triggered accrual applications require explicit corrected allocations when any correction exists. Stable `originalAllocationIndex` is retained on application allocations so a split original share is counted once in later cent allocation. The exact reversal posts against the corrected cost accounts; invoice recognition and its accrual reversal remain atomic. Missing plans, unsupported dimensions/accounts, stale snapshots, prior-period backdating, unposted/tampered journals, duplicate allocation identities and exhausted capacity remain holds.

## Typed review/API seam

New `src/ap-system/cost-contracts.ts` exports `CostCorrection`, `CorrectedCostAllocation`, `CostState` and schemas.

`apClose:costState` query accepts `{scope, originalEntryId}` and requires a current configured human plus active business policy. It returns root `billId`/`accrualId`, `supplierId`, `latestDate`, `snapshotHash`, exact signed account/store `positions`, immutable `corrections` (action/journal/from/to/date/cents), and `originalShares` (original line/index/account/treatment/store/period/signed side/original and remaining cents). No original source bytes, references or credentials are returned.

`CostCorrection` is `{snapshotHash, evidence: SourceBinding[], reason, allocations}`. Each allocation is `{originalLineId, allocationIndex, account, store, treatment, side: "credit"|"debit", amountCents}`. Every amount is explicit positive safe integer cents. For accrued cost, `originalLineId` is exactly `"accrual"`, with its original allocation array index. Invoice line IDs and reserved header IDs `freight` / `discount` retain the existing original-allocation convention; ambiguous identities hold.

The same optional `correction` input is accepted at:
- `DomainRequest.credit.correction` (existing `apBusiness:propose` / independent `vote`);
- `DomainRequest.accrualApplications[].correction` (invoice recognition);
- `CloseAction` kind `reverse_accrual`, at `.correction`.

Existing close `adjustment` requests keep their shape. They now bind the current entire cost snapshot in the proposal context, revalidated at every vote and final posting. Existing clients omitting a needed correction continue to receive an explicit hold.

## Export seam

`RecognizedBusinessExport.allocations` now includes required exact `store: string | null` with its existing account and signed amount. Invoice and credit allocations are still checked against the original posted journal; no current candidate recosting. A owns explicit QBO Class mappings/holds and external replication. Credit application IDs/shapes are unchanged.

`apClose:accountingExport` retains its existing shape. Correction-chain exports resolve supplier from the original noncash cost dimensions, including when the current from-account was introduced by an earlier correction. Accrual reversal exports use the stored exact corrected application allocations. No external export action rebooks local accounting.

## Validation

Full local suite: **1,138 passed / 4 skipped**, 104 passed files / 1 skipped. Root, backend and test TypeScript checks all passed. `tests/ap-system/cost-corrections.test.ts` adds 11 public-flow/adversarial tests covering:

- exact corrected return credits, current variance route, replay, original-journal preservation and zero extra cash/bill;
- missing/stale/unmapped/overdrawn/wrong-side/wrong-index/wrong-store/wrong-treatment/backdated plans;
- competing credit and reclassification changes between first and final votes;
- approved account correction chains without fresh capacity from correction journals;
- original nonrecoverable tax and successive exact rounding (2118/2117 then 2117/2118);
- signed discount reversal (6930 AP, gross 7700 cost less 770 discount), with exact store export;
- corrected accrued cost, explicit partial/manual and invoice-triggered reversals;
- split-original allocation identity across later reversals (1926/1924 then 1925/1925);
- retired retained voter and tampered immutable journal rejection.

The preceding standalone receipt capacity fix is separate commit 354cb36 with independent-regression evidence in B4-V5-capacity-correction.md. UI composition and QBO integration are parent/A/D-owned next steps; independent verification of this follow-up remains outstanding.
