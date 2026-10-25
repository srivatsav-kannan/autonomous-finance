# Current AP policy cases — C15–C22

> **2026-10-25 scope update:** This is historical practitioner preparation. The user replaced the practitioner delivery gate with [Claude 独立模型评审](CLAUDE-REVIEW.md), to be run by the external recipient using a frozen blind derivation before implementation comparison. A real practitioner is no longer required for this delivery; none is claimed. CI is deferred; actual QuickBooks/Increase acceptance remains unchanged.

Prepared against integration `1a5dc708ef0de26fbd1f2f7f82c33f49a914ae28`, 25 October 2026. Spec SHA-256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. These cases supplement [C01–C14](PRACTITIONER-CASEBOOK.md); they do not overwrite historical observations. All dollar amounts are USD. **Every entry below is an expected result under a declared synthetic policy**, not a new observed journal. Linked reports/tests state what was actually exercised. No practitioner has approved any case.

The user selected USD-only delivery; [multicurrency/FX #104](https://github.com/srivatsav-kannan/autonomous-finance/issues/104) is future work. No tax rule, dimension, supplier channel or provider mapping is activated by this packet.

## C15 — recoverable purchase tax, including partial recovery

Source: a separate synthetic component invoice, net $77.00 and tax $7.70. This is not the $678.60 Golden State PDF. The approved policy must specify jurisdiction, tax-point interval, inclusive/exclusive basis, permitted rates or an explicit stated-amount route, recovery fraction, receivable account, rounding and independent tax approval group. A stated-amount route can retain `rateBps: null`; it must not invent a printed rate.

Numerical facts cite the exact original invoice source/revision/hash and text span. Eligibility cites separately retained independent material. Relabeling the same invoice bytes as Other/Contract/Correction is still invoice self-evidence and is rejected. The approved receivable must be a known noncash asset configured for tax treatment; account 1180 is the passive synthetic example, not an automatically selected real account.

| Synthetic policy / action | Expected debit | Expected credit |
| --- | --- | --- |
| 100% recoverable recognition | 5000 cost $77.00; 1180 receivable $7.70 | 2000 AP $84.70 |
| Separate tax-only credit under that original | 2000 AP $7.70 | 1180 $7.70 |
| Alternative 50% recoverable original | 5000 $80.85; 1180 $3.85 | 2000 $84.70 |
| First half return under 50% original | 2000 $42.35 | 5000 $40.42; 1180 $1.93 |
| Second half return under 50% original | 2000 $42.35 | 5000 $40.43; 1180 $1.92 |

The alternative originals are separate scenarios, never postings in one ledger. Cumulative reversal returns exactly $3.85 receivable and $80.85 cost. No credit recognition creates cash. Expected postings JSON uses the 50% sequence as C15.

**Evidence:** [tax implementation](evidence/E01-recoverable-tax.md), [independent V13 repair](evidence/V13-repair.md), [tax business tests](../../tests/ap-system/tax-business.test.ts). V13's unchanged 99 checks include recognition, credit and adjustment controls; they are isolated synthetic backend checks, not browser, QBO or practitioner acceptance.

**Review:** Is the legal/entity eligibility evidence adequate? Are the selected account, tax point, rate-or-amount route, recovery ratio and cumulative rounding appropriate? Missing policy/evidence, fractional-cent facts, wrong account, self/retired/stale reviewer and over-capacity credits must remain held.

## C16 — freight/discount belong to an explicit tax base

Synthetic original: net $77.00 + freight $10.00 − discount $2.00 = derived base $85.00; stated tax $8.50 and gross $93.50. Policy explicitly includes freight, reduces base for discount, and selects half-up taxable-base-proportion rounding. Original and accepted freight/discount shares are retained for every line; exact global sums must match the headers. The UI must label the base as derived and cite printed net/header/tax facts, not fabricate a printed $85.00 citation.

| Separate action / sequence | Expected debit | Expected credit |
| --- | --- | --- |
| Full recognition | 5000 net $77.00 + freight $10.00; 1180 $8.50 | 5000 discount $2.00; 2000 $93.50 |
| First return after full recognition: net $38.50, freight $1.00, discount $0.50, tax $3.90 | 2000 $42.90; 5000 discount reversal $0.50 | 5000 net $38.50 + freight $1.00; 1180 $3.90 |
| Second return: net $38.50, freight $9.00, discount $1.50, tax $4.60 | 2000 $50.60; 5000 discount reversal $1.50 | 5000 net $38.50 + freight $9.00; 1180 $4.60 |
| Alternative original partial acceptance: one unit with only $1.00 freight and $0.50 discount | 5000 net $38.50 + freight $1.00; 1180 $3.90 | 5000 discount $0.50; 2000 $42.90 |

The two returns exactly exhaust the full original. The alternative partial acceptance is a separate ledger. Its accepted base is $39.00 and tax is $3.90, not the $4.25 obtained by blindly halving total original tax. JSON preserves the signed freight/discount legs rather than collapsing them to net cost.

**Evidence:** [header report](evidence/E01-tax-header-basis.md), [exercised exact cases](../../tests/ap-system/tax-header.test.ts), [V13](evidence/V13-repair.md). Missing line attribution, mismatched header sums, wrong source, quantity-only tax or reused header capacity rejects; no policy defaults are inferred.

**Review:** Should each header be taxable under the chosen policy? Does the original support the exact allocation, and are the accepted shares justified rather than merely arithmetically possible?

## C17 — later eligibility change and coupled supplier credits

Start with C15's separate 100% original. A newly approved synthetic policy permits 50% of remaining tax. A controller proposes exact current tax/cost hashes, every original-line target, bucket movements, date, independent eligibility evidence and reason. Current independent financial/variance/tax stages approve it. It cannot post into a closed period or before included accounting events.

| Sequence | Expected debit | Expected credit |
| --- | --- | --- |
| Original | 5000 $77.00; 1180 $7.70 | 2000 $84.70 |
| Approved remaining-tax reclassification | 5000 $3.85 | 1180 $3.85 |
| First later half return | 2000 $42.35 | 5000 $40.42; 1180 $1.93 |
| Second later half return | 2000 $42.35 | 5000 $40.43; 1180 $1.92 |

The adjustment leaves the invoice, original journal, AP and cash unchanged. Later `credit.taxReversal` explicitly binds the current snapshot and bucket allocation. An explicit empty plan is required for a zero-tax credit after adjustment. Capacity and cumulative rounding are rechecked atomically at the final vote; intermediate destinations cannot reuse the same tax cent.

**Evidence:** [adjustment report](evidence/E01-tax-adjustments.md), [tests](../../tests/ap-system/tax-adjustments.test.ts), [V13](evidence/V13-repair.md). The UI/HTTP editor is implemented with blank decisions/citations and authenticated inventories; its [component report](evidence/E01-tax-adjustment-ui.md) explicitly separates those checks from real browser acceptance.

**Review:** Does the new evidence justify the changed remaining eligibility, date and amount? Should the adjustment be in this open period? Is the tax/cost attribution sufficient without rewriting prior records?

## C18 — eligibility increase after a prior credit and cost reclassification

This sequence starts with its own 50% original. It exercises remaining embedded tax after a prior return and an approved move from expense to inventory.

| Sequence | Expected debit | Expected credit |
| --- | --- | --- |
| Original | 5000 $80.85; 1180 $3.85 | 2000 $84.70 |
| First half return | 2000 $42.35 | 5000 $40.42; 1180 $1.93 |
| Reclassify remaining cost | 1200 inventory $40.43 | 5000 $40.43 |
| Approved increase to 100% remaining recovery | 1180 $1.93 | 1200 $1.93 |
| Final half return | 2000 $42.35 | 1200 $38.50; 1180 $3.85 |

Before the eligibility increase, receivable remaining is $1.92 and inventory contains $1.93 embedded nonrecoverable tax. The initial tax attribution must cover those exact original-line/allocation shares and their approved path to inventory. After it, receivable is $3.85 and inventory $38.50. All listed balances reach zero on final return. Historical journals remain byte-for-byte unchanged.

**Evidence:** the prior-credit/cost-reclassification case in [tax-adjustments.test.ts](../../tests/ap-system/tax-adjustments.test.ts) and [V13](evidence/V13-repair.md). Missing/ambiguous attribution, unreachable cost shares, wrong dimension, stale snapshot, competing exhausted capacity and changed original journal remain held.

**Review:** Does the historical attribution identify the right tax embedded in the corrected cost? A balanced journal alone cannot establish this.

## C19 — exact dimensions through payment, return and replacement

The operator must choose `cost_allocations` or explicit `cost_and_settlement`. The latter requires one homogeneous approved department, including a consistent explicit null, and carries it into AP/cash and return journals. Store and project remain attached to their proper cost shares; a project is not inferred for cash. Reclassification cannot migrate value between original department/project coordinates.

V12's distinct synthetic sequence uses department `ops`, a $77.00 recognized invoice and $38.50 recognized credit. Initial discharge is $41.00 = $13.50 credit + $27.50 cash. Returned cash restores only $27.50; previously consumed credit stays consumed. Then $8.50 additional credit and $19.00 separately authorized cash discharge that restored principal.

| Sequence | Expected debit | Expected credit |
| --- | --- | --- |
| Original recognition | 5000 $77.00 | 2000 $77.00 |
| Credit recognition | 2000 $38.50 | 5000 $38.50 |
| First cash settlement | 2000 $27.50 | 1000 $27.50 |
| Verified cash return | 1000 $27.50 | 2000 $27.50 |
| Replacement cash settlement | 2000 $19.00 | 1000 $19.00 |

All five entries preserve department `ops`; cost lines additionally preserve the original store. The $13.50 and $8.50 credit applications are allocation receipts, not new recognition journals. Bill paid is $41.00, bill outstanding $36.00, recognized credit consumed $22.00 and unused credit $16.50. Net AP is therefore $19.50; net cash paid is $19.00 and net cost $38.50. These are distinct quantities, not conflicting balances.

**Evidence:** [V12](evidence/V12.md), [exact test](../../tests/ap-system/v12-external-settlement.test.ts), [V10](evidence/V10-E02.md) and [V11](evidence/V11-repair.md). V12 combines actual local controls and synthetic bank evidence with HTTP-shaped QBO doubles; it is not a live provider round trip.

QBO department/Location and store/Class need explicit mappings and enabled features. Bill/VendorCredit project/customer/billability require current verified catalog/entitlement and relationship. Unsupported JournalEntry project/Entity combinations stay held. **Review:** Do these local semantics match the organization's reporting dimensions, and can the selected external form represent them without loss?

## C20 — repeated physical receipt lines and cross-period accrual

One exact original records two KALE-24 lines, same unit and $38.50 unit price: north 0.5 case and south 1.5 cases. Positive independent identity review freezes both physical capacities and complete parser-row mapping. SHA-based deduplication means renamed files, reordered rows and reviewed split/merge representations still use these same capacities. A partial merged row must explicitly choose physical shares.

In the exercised cross-period case the invoice is dated 2026-11-02, but the October receipt is accrued on 2026-10-31:

| Physical line | Expected debit | Expected credit |
| --- | --- | --- |
| North 0.5 | 5000 $19.25 | 2010 accrued liabilities $19.25 |
| South 1.5 | 5000 $57.75 | 2010 $57.75 |

With independent opening/reconciliation evidence, accrued GL and subledger both equal $77.00, AP is zero, and October can close. Missing, partly accrued or fully reversed south capacity still blocks closing; a historical accrual's mere existence is insufficient. A different supplier cannot claim this catalog. A mapping/approval itself creates no journal, obligation or bank operation.

**Evidence:** [physical rules](evidence/E04-physical-lines.md), [cross-period regression](../../tests/ap-system/physical-accrual-regressions.test.ts), [V9 repair](evidence/V9-E04-repair.md). Existing untagged historical usage cannot be silently migrated. A standalone ambiguous multi-line receipt requires the supported case/mapping preparation.

**Review:** Do the exact original locators establish distinct physical units and supplier ownership? Are cutoff and quantities sufficient for this accrual, rather than merely inferred from the later invoice?

## C21 — replacement of an unavailable trusted supplier contact

Expected economic postings: **none** for registration, proposal, verification, escalation, decision or case recertification. Existing bill/journal identity stays intact.

Retain an independently acquired new contact with origin/timestamp and source. An invoice/credit original, including a renamed same-hash copy, cannot establish the trusted replacement. A current controller proposes the exact change; a separate current recorder, verifier, escalation reviewer when required, and final approver must satisfy policy without seat aliases. For replacement, declaring the old channel unavailable requires independent reestablishment, retained unavailability evidence and explicit escalation; a contradictory old-channel confirmation is rejected, including retained pre-fix reviews. An explicit `retain_current` restoration instead verifies recovery of the original channel and retains the required escalation when unavailability was declared.

Proposal holds new authority without canceling an existing human-approved payment. Final human approval can cancel provably unsent operations through the existing control. Possible sends keep the original destination/request/key/reservations and are reconciled. Replacement changes the trusted contact pointer, not bank details: a new supplier revision requires separate verification/approval and case recertification. Rejection remains held until an explicit approved superseding replacement or restoration.

**Evidence:** [E03](evidence/E03-trusted-contact-replacement.md), [V8 final](evidence/V8-E03-final.md), [bounded root browser review](evidence/D2-root-browser-review.md). The software did not call or message anyone; `operator_recorded` describes a human's retained attestation, while `simulated` is local-only.

**Review:** Is provenance genuinely independent, is the failed old channel evidenced, are distinct responsible people available, and is the restoration path practical?

## C22 — tax adjustment external replication and historical receipt recovery

Expected local postings: **none beyond C17/C18's already approved adjustment**. The external expected JournalEntry mirrors the exact approved debit/credit legs; it must not update the original Bill or create another local expense, AP or cash effect.

At this code baseline, the adapter supports `tax_reclassification`, exact original `ap_tax_adjustment` binding and already synchronized original Bill, current authority, immutable plan hash, explicit permitted account mappings and preserved store/department. Missing/changed original or mapping, wrong supplier/account/dimensions, unsupported project representation and retired current authority prevent a new write.

After an authorized write may have occurred, retirement of policy does not justify another POST. A current authorized scoped reader may investigate an existing sending/unknown/succeeded receipt with the saved original identity. Only find/verify is allowed; no new operation, remapping, or replacement authorizer. An empty search stays unknown with a hold. Provider-free status can show historical receipt access without claiming current write authority.

**Evidence:** [QBO tax implementation and nine local scenarios](evidence/E01-qbo-tax-reclassification.md), [tests](../../tests/ap-system/quickbooks-tax.test.ts). Owner protocol checks are available; a distinct final adapter review and real sandbox transaction acceptance must be recorded separately. Real tax receivable/extended dimension mappings are not established by the earlier eight reference writes. The business-tax V13 review does not certify QBO adapter behavior.

**Review:** Does the external GL represent the same approved correction, and does the unresolved-write UI keep read-only recovery distinct from permission to send? Filing/TaxCode/TaxLine/refund semantics are outside this GL replication path.

## Recording a real review

For each case retain the actual source hashes, policy/version, human decisions, original/current allocation lineage, period, local journal IDs and any independently read external IDs. If not executed, write **expected only**. Record legal/policy judgment separately from technical pass/fail. Use the [template](PRACTITIONER-RECORD-TEMPLATE.md); all reviewer and sign-off fields remain unfilled.
