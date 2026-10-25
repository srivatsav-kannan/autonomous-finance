# E01 immutable remaining-tax correction and credit coupling

This is a component implementation using explicit synthetic policy and retained synthetic evidence. It is not tax advice, a real taxpayer eligibility determination, practitioner approval, HTTP/FakeBank verification, or a provider write. No active policy or provider configuration is changed.

## Dependency and owned changes

Follows header-basis checkpoint `8598cc7`, based on root `8cd1923`. Uses existing immutable `apCloseActions` and journal tables, with no schema migration. Adds tax contracts/state helpers; narrow hooks in close approval, cost reconstruction, linked credit allocation, accounting export, and period history. The UI owner authorized only a read-only `tax_adjustment` summary guard in `APSystemClose.tsx` to keep the expanded discriminated union compile-safe. Full forms/transport remain D's work.

## Explicit policy and approval semantics

A recovery policy must opt in with:

```ts
adjustments: {
  mode: 'reviewed_remaining_tax',
  attribution: 'explicit_original_allocation',
  creditRounding: 'half_up_cumulative_latest_adjustment'
}
```

No default enables this. An explicitly configured recovery ratio may now be zero. Each line's remaining recovery target must equal the current policy ratio applied with exact integer half-up arithmetic to its remaining original tax. The current policy must match the original jurisdiction/price basis and be effective on the adjustment date. The engine does not infer eligibility from invoice wording.

A controller proposes an immutable `tax_adjustment` through `apClose:propose`; existing `apClose:vote` requires current independent humans through the amount-band route, the variance group and an additional tax group stage. Current seat identities, delegation principals, source citations, policy/supplier authority, and exact cost/tax snapshots are checked again before posting. An adjustment cannot post into a closed period or predate included accounting events. Existing idempotency receipts prevent a repeated vote from posting twice.

The new journal contains only supported expense/noncash-asset accounts. Every movement preserves supplier, store, department and project coordinates and original line/allocation lineage. AP, cash, invoice face value and prior journals stay unchanged. A single existing tax cent cannot fund multiple movements or be reused through an intermediate destination in the same action.

## Read/write seams

`apClose:taxState({scope, originalEntryId})` requires an authenticated scoped human and returns:

- Original journal, approval, bill and supplier IDs; current cost/tax hashes and latest date.
- Per-line remaining tax, unattributed cost-tax amount, and exact cumulative rounding basis/usage since the latest approved adjustment.
- Current tax buckets with original line/allocation index, current account/treatment, exact dimensions and cents.
- Immutable approved adjustment action/journal IDs and dates.

The `tax_adjustment` action includes `originalEntryId`, `originalApprovalId`, `costSnapshotHash`, `taxSnapshotHash`, `targets`, `movements`, `date`, `eligibilityEvidence` and `reason`. A movement names an exact `from` tax share and explicit `toAccount`/`toTreatment`. `initialAttribution` is required to cover every previously embedded, still-unreversed nonrecoverable tax cent before the first adjustment. It must preserve original allocation lineage, match an approved cost-reclassification path, and fit exact current balances. Missing or ambiguous attribution remains held; an existing original is never rewritten to add it. Later actions cannot replace the original reviewed attribution.

Eligibility evidence uses exact original SHA/revision and page/text spans already retained in `apCaseSources`, with kind `other`, `contract` or `correction`. Invoice self-assertion, missing originals and stale spans are rejected. The full source need not be repeated in a current invoice packet.

After a posted adjustment, `credit.taxReversal = {snapshotHash, allocations: TaxShare[], reason}` is required. Every credited tax cent must reverse a current bucket, conserve the cumulative recovery proportion from the latest approved adjustment, and fit original remaining capacity. The original net/quantity/header tax-base controls still determine the total credit; this plan cannot change invoice tax or invent a credit. Zero-tax credits use an explicit empty tax allocation array. Credit allocations retain `component: 'tax'` even when the tax is now expensed, preventing ordinary cost-correction code from silently moving it. Ordinary cost reclassification reserves current identified tax balances.

`apClose:accountingExport({actionId})` produces `kind: 'tax_reclassification'`, source `ap_tax_adjustment` bound to the original journal, and the exact approved posted lines. It requires current retained approval authority and checks both journal and approval hashes. Export is a separate posting from the original Bill; no original Bill rewrite is authorized. A/QBO must explicitly support this new kind before dispatch; its old unknown-kind guard remains a safe hold.

## Expected and exercised accounting examples (cents)

Full original recovery: Dr cost 7,700, Dr tax receivable 770, Cr AP 8,470. A later explicitly approved 50% remaining recovery posts Dr cost 385 / Cr receivable 385. Two 4,235 supplier credits then reverse cost/receivable as 4,042/193 and 4,043/192, with AP debits of 4,235 each. All three original balances reach zero, with no cash transaction.

Prior-consumption example: original 50% recovery posts Dr cost 8,085, Dr receivable 385, Cr AP 8,470. First credit posts Dr AP 4,235, Cr cost 4,042, Cr receivable 193. Remaining cost 4,043 is independently reclassified to inventory. A new explicit 100% policy plus reviewed original-line attribution moves the remaining embedded tax 193 from inventory to receivable. Final credit reverses inventory 3,850 and receivable 385 against AP 4,235. The prior journals remain byte-for-byte unchanged.

Rounding example: after a reviewed recovery baseline of 257 out of 770 tax cents, three separate one-cent tax credits reverse recovery portions 0, 1, 0. The basis and cumulative usage are retained explicitly; there is no repeated remaining-balance rounding drift.

## Validation and remaining integration work

`tax-adjustments.test.ts`: 19 tests pass, including the above flows, zero recovery, missing opt-in, wrong jurisdiction/target/account/original, stale/missing eligibility evidence, closed period, exact initial attribution, competing final votes, retired reviewer, authenticated inventory, replay, immutable journal tampering, reserved tax cost, wrong reversal proportion and intermediate double consumption.

Full accounting/payment selection (`tests/ap-system`, `tests/payments`, `tests/demo-*.test.ts`, `tests/payment-kernel.test.ts`): **902 pass / 1 fail** across 118 files. The sole failure is the unchanged pre-existing A architecture boundary: `src/payments/{contracts.ts,domain/validation.ts}` import `src/payments/accounting-binding` rather than the domain path. This tax branch does not edit those files; A already owns its separate repair. App, backend and test TypeScript checks pass with the UI owner's narrow guard. `git diff --check` passes.

New-kind QBO dispatch and complete UI/HTTP form support are concrete integration tasks for A/D, not external-practitioner acceptance. No tax filing, tax refund, FX, jurisdiction/rate selection or automatic eligibility determination is added. Actual operator policy and practitioner review remain explicitly pending.
