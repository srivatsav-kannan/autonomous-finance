# C4 B4 accounting bridge and remaining restored-credit handoff

Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Dependencies: B4 core `c923b332e898f2296c4713f650c76fa79b5331e4` and authenticated export `cae720be9033a92b4a670e122cfb8d02fce59509`. This branch applies them as `924ece6` and `247088e`; integration already owns the original commits.

## Implemented bridge

`src/ap-system/quickbooks/close-sync.ts` exposes `QuickBooksCloseDispatcher(load, mappings, journal)`. Its injected server-only loader must call authenticated `apClose:accountingExport({scope,input})`, attach the same request-bound scope, and return `CloseExportEnvelope`. It must never accept an arbitrary browser export or caller assertion of approval. The request is exactly `{actionId}` or `{accrualApplicationId}`; both selectors of one reversal retain the same `kind:journalId` effect identity. `run(request, 'dry-run'|'submit', {expectedPlanHash})` returns a plan, controller-owned hold, or immutable operation receipt.

The bridge preserves the B4 loader's exact approved posted journal date, debit/credit cents, source, supplier and store dimensions. Accrual and reversal use explicit 2010 Other Current Liability mapping. Reclassification rejects cash/AP/accrued-liability substitutions. A reversal requires its original successful accrual JournalEntry; a cost correction requires the successful original Bill or close journal. Dependency discovery is bounded and rejects ambiguity. Existing external history is neither edited nor deleted. Current source authority and authenticated submission subject are reloaded immediately before the first external write.

`Mappings.classes?: Record<localStore,{id,name}>` explicitly maps store dimensions to QBO Class references. Missing mapping holds; dimensions are not dropped. Before an authorized write, the normal mapping check reads Class and checks active status and exact name. Other existing mapping hashes remain frozen: adding mappings later does not silently reassign an old operation. `LocalLinks.caseId` and `billId` now allow null for case-less accruals; new close journal/action/application/original-journal IDs retain audit links without fabricated case IDs.

Dry runs and ordinary status make no provider calls. Root owns runtime/service/UI composition and explicit external verification. Persistent `close-hold-*` records are historical hold evidence; runtime must derive current state from fresh authenticated export/preview and immutable operation receipts rather than treating all old hold files as permanent current holds. Full close UI/provider integration is not claimed by this core checkpoint.

The [official JournalEntryLineDetail reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/62627c63-90a3-c87a-ef9b-8b4b06daee08.htm) documents line AccountRef, Entity, and ClassRef. [Intuit's query documentation](https://help.developer.intuit.com/s/article/SQL-Queries) describes active/inactive Class entities. These support the explicit shape and active-class check; actual company feature settings and live API acceptance remain unproven here.

## Measured local coverage

Authenticated Convex test exports feed independent mock HTTP transport for case-less accrual, exact partial reversal, selector alias replay, unchanged original receipts, missing Class mapping, missing original external journal, retired approval seat, lost response recovery without repost, and exact cost-reclassification planner dimensions. B4's own export tests separately check original approved cost journals and invoice-triggered accrual application. Local tests contain no real credentials or provider calls. This agent did not inspect or change grants/tokens, start services, or write persistent backends.

## Restored-credit allocation follow-up status

The following planned extension is now implemented in the restored-credit checkpoint; see [C4-restored-credit.md](C4-restored-credit.md) for current behavior and measured evidence. The plan is retained here as provenance of the scope, not an outstanding permanent hold:

1. Add strict `credit_allocation` authority alongside `bank_return` and `payment_allocation`: caseId, creditApplicationId, originalBillCents, restoredPayables, reason and idempotencyKey. Resolve the immutable existing `apCreditApplications` plus recognized credit/bill bindings server-side. No bank command or zero-dollar transfer is created.
2. Freeze the exact credit application, current policy/supplier hashes, original/restored allocation and amount route. Reuse current independent human/seat/delegation approvals. Count prior approved cash and credit allocations together against returned principal; exclude the selected current application from original-principal consumption to avoid double counting. Previously exported applications must retain their original payload and cannot be reallocated under a new selector.
3. Build from the existing credit-only `applicationPlan`, replacing the gross Bill allocation with exact Bill/JournalEntry portions and retaining all VendorCredit lines. TotalAmt is zero; AP debit and credit application net exactly. Keep the existing stable CreditApplication identity/requestid, frozen mappings, and immutable-payload conflict behavior.
4. Extend backend lookup and current holds to find the approved credit allocation. Require successful read-verified return JEs and current external Bill/VendorCredit balances plus the bounded restored-principal scan. Resolve only the matching application hold with explicit proof, never a generic clear flag.
5. Independently test zero cash/no bank effect, mixed original/restored principal, duplicate and exhausted allocations, pending/stale authority, changed external credit/JE, lost response, immutable identity under selector aliases, and no implicit provider calls from status. Any actual QBO testing must remain with the explicitly authorized owner workflow.

Other recertification and unsupported bank-return forms remain visible holds pending their own explicit authority, rather than local rebooking or false full-sync status.
