# B4 authoritative accounting export

Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Follow-up to B4 core `c923b33`; no external provider calls or acceptance claim.

`apClose:accountingExport` is a query requiring the currently authenticated configured human. Arguments: `{scope,input:{actionId}}` or `{scope,input:{accrualApplicationId}}`, exactly one. Returns `{authorizedSubject,exportedAt,accounting:CloseAccountingExport}`. Internal composition helper: `loadApprovedCloseExport(ctx,scope,request)` in `convex/lib/apSystem/closeExport.ts`.

The typed `CloseAccountingExport` in `src/ap-system/close-contracts.ts` contains:

- `version: ap-close-accounting-v1`, stable `exportId: kind:journalId`, `kind: accrual | accrual_reversal | cost_reclassification`, `amountCents`.
- Nullable exact `actionId`, `accrualApplicationId`, `caseId`, `billId`, `accrualId`, `originalEntryId`, `supplierId`.
- `approval:{id,kind:close|business,hash,policyHash,approvedAt,votes}`. Each vote retains subject/principal IDs, original human seat IDs, group/stage/deadline/time and delegation ID.
- `journal:{id,hash,date,memo,source:{kind,ref},lines:[{account,debit,credit,store,supplierId}]}`. The accounting date is the actual posted journal date; no new bill candidate recalculation.

For invoice-triggered accrual reversal, the loader locates the original approved business proposal that explicitly named that accrual/application quantity and recognized the same bill. For manual reversals it locates the exact approved close action/application. For accruals and cost reclassifications it binds the immutable close action, original journal and original cost dimensions. Action and journal hashes are recomputed, expected source kinds/references and exact journal lines are compared, and debit/credit cents must balance.

Export requires the same current policy and retained human-seat/delegation authority; retired/rebound voters or changed policy yield an explicit export hold. Reauthorization of external replication must not rebook the local financial entry. A/C4 owns that external authority/dispatch path and account mappings; this loader never calls QBO, infers approval from journal existence, or creates another local accounting effect.

Cost reclassification also rejects mixed supplier or unsupported original dimensions instead of assigning aggregate cost to the first supplier. Missing 2010 or cost mappings remain external-configuration holds owned by C4.

Evidence: 21 close tests pass (17 core + 4 export tests). All three TypeScript checks pass. New cases cover pending-action and unauthenticated denial; exact accrual approval/seat export; identical effect identity via reversal action/application aliases; invoice-triggered reversal binding without a second posting; original bill links for cost correction; changed journal hash; and retired retained voter. Core full-suite baseline before this readonly export addition remains 1,120 passed / 4 skipped. No broader suite was repeated after the focused export and type checks passed.
