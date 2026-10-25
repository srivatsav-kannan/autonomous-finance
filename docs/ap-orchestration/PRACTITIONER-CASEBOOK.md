# AP practitioner casebook — 25 October 2026

Current reading note: C01–C14 below preserve the original `1cd4cc5` review baseline and its evidence boundaries. For integration `1a5dc70`, read the [updated overview](PRACTITIONER-REVIEW.md), [C15–C22 current policy cases](PRACTITIONER-CURRENT-CASES.md) and current addendum in the [engineering audit](PRACTITIONER-ENGINEERING-AUDIT.md). Recoverable tax, explicit taxable headers, governed eligibility adjustments, extended dimensions and reviewed contact/physical identity are now implemented within their declared opt-in scope. The user chose USD-only delivery; [multicurrency #104](https://github.com/srivatsav-kannan/autonomous-finance/issues/104) is future scope. Historical pending statements below are not the current status registry.

**Practitioner review has not occurred.** This is a prepared review packet, not a sign-off. The examples below state the implemented synthetic company policy and its expected entries. “Observed” refers only to the linked engineering evidence, with its original code revision and execution mode. It does not establish that the policy is appropriate for a real entity.

Prepared by the accounting implementation agent against integration `1cd4cc59e172a8ef1a7f9dd8f69e8a1a4764d12b`, including the corrected-cost UI and the period accrual-application inventory. Adopted issue #97 spec SHA-256: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Contracts: `ap-evidence-v1`, `ap-business-v1`. No application, provider or payment was run in preparing this packet.

Machine-readable [expected postings](PRACTITIONER-EXPECTED-POSTINGS.json) accompany the examples; they are an expected-result artifact, not observed journal records. Use the [review record template](PRACTITIONER-RECORD-TEMPLATE.md) to record actual practitioner judgments. Review the [engineering gap audit](PRACTITIONER-ENGINEERING-AUDIT.md) before describing any remaining work as solely external acceptance. The [existing review overview](PRACTITIONER-REVIEW.md) and historical evidence remain intact.

## What the evidence establishes

| Evidence class | Meaning here | Examples and boundary |
| --- | --- | --- |
| Expected policy result | Exact result selected before/for an engineering test | An expected-outcome file is not an observed result or practitioner judgment. |
| Component execution | Actual isolated backend mutations, in-memory database, simulated humans; provider may be mocked | B3/B4 and cost-correction tests execute the controls and journals; they do not demonstrate a browser upload or real bank. |
| Local bank integration | Actual payment engine against FakeBank with recorded transactions/replay | V2/V3 and parts of V5 test recovery. FakeBank is a simulator. |
| HTTP/browser integration | A persisted case passes actual local HTTP, browser, backend and FakeBank steps | I1 and I2 below. Their synthetic original files and humans remain explicitly synthetic. |
| External observation | Recorded operation against the named external service | LlamaParse source jobs; QBO OAuth/read-only inspection and eight reference-record creations. These do not establish an external accounting transaction or Increase payment. |
| Practitioner judgment | A real domain reviewer names scope, evidence, conclusions and required changes | **None recorded.** Agent review and workflow approval are separate from this judgment. |

Evidence checkpoints are not additive test populations. V3/V4/V5 suites overlap and use different baselines. A later repair does not rewrite an earlier failing result.

- [V1](evidence/V1.md) derives the first packet's outcomes from originals; [I1](evidence/I1-integrated.md) / [JSON](evidence/I1-integrated.json) record actual local HTTP/source/bill/payment results at `a13b131`.
- [I2 business flow](evidence/I2-business-flow.md) / [JSON](evidence/I2-business-flow.json) record the actual partial-recognition/browser/FakeBank run at `4ff9be5`.
- [B3](evidence/B3-domain.md), [B4](evidence/B4-close.md), [corrected-cost implementation](evidence/B4-cost-corrections.md) and their named tests are component evidence. The latter records 1,138 passed / 4 skipped at the author's branch, not a rerun of this packet's integration revision.
- [V4](evidence/V4.md) preserves three original defects and their repair history. [V5 repair](evidence/V5-repair.md) records 84 distinct passing bounded tests for standalone receipt capacity and QBO query proof. [V5 extension](evidence/V5-extension.md) records 64 distinct passing bounded tests for corrected costs, period export authority and cancellation reconciliation. [V5 QBO repair](evidence/V5-qbo-repair.md) records 47/47 after the exact Class readback fix. These are independent agent engineering reviews.
- [D2 period and corrected-cost UI](evidence/D2-period-close.md) records component/transport/render checks; it explicitly does not claim a real multi-human period-close browser journey. I2's real browser partial-payment journey does not fill that gap.

## Originals and scope

Open the [invoice](../../fixtures/ap-system/golden-state-v1/input/invoice.pdf), [PO](../../fixtures/ap-system/golden-state-v1/input/purchase-order.pdf), [receipt](../../fixtures/ap-system/golden-state-v1/input/receipt.pdf) and [contract](../../fixtures/ap-system/golden-state-v1/input/contract.pdf) before consulting the [evaluation-only expected outcomes](../../fixtures/ap-system/golden-state-v1/evaluation/expected-outcomes.json). The runtime must not load that answer key. [Facts and provenance](../../fixtures/ap-system/golden-state-v1/input/facts.json) and the [manifest](../../fixtures/ap-system/golden-state-v1/manifest.json) identify a seed-97 simulator export, not supplier or Sweetgreen books. The rendered PO is explicitly authored synthetic evidence. All people and supplier contact details in this packet are synthetic.

| Original, revision 1 | SHA-256 |
| --- | --- |
| `gs-invoice` | `a6c745ac1f33d32ab142f8da420ba82af3590eb36a3897c39d7537d1c0a1eb83` |
| `gs-purchase-order` | `180bd875e03024fafe18732710e829f43e5ce06dcb7c4eb9e6115c627f1cc7e7` |
| `gs-receipt` | `a585c8f5e45a2ff962e94b56280d35ce0af9d078ba44f5acd971e6cba29a2ff2` |
| `gs-contract` | `63539752792e6afbdd2fcecc4444a3710d7fa17341c77c5a482e089a5604f883` |
| Separate quantity-discrepancy invoice | `59b5344281b0a7202c924f4ace515667f34bcf45816826252cecc3b0c6df967a` |

INV-1001 is dated 2026-10-19, due 2026-11-02, Net 14, USD, store `sf-hayes-valley`. Its four quantities/prices are 5 × 3,850, 4 × 4,275, 3 × 6,890 and 2 × 5,420 cents, totaling 67,860 cents. Tax, freight and discount are zero. The first policy treats this produce as immediately consumed expense; that is a deliberate review question, not an accounting conclusion implied by the document.

Later 7,700-cent / 8,470-cent test cases use the separate [backend fixture](../../tests/ap-system/business-fixture.ts) and text stand-ins. Their small amounts must not be confused with the original 67,860-cent PDF or with actual I2 IDs.

## Rules and accountable decisions

| Rule under review | Enforced outcome and responsible role | Practitioner decision needed |
| --- | --- | --- |
| Evidence and field review | Preserve original bytes/revision/hash. Failed pages or unsupported content hold for AP/receiving repair. A human may review supported text with unresolved geometry; geometry never authorizes an obligation. | Are mandatory fields, manual-review evidence and page completeness sufficient? |
| PO / non-PO support | PO+receipt or contract+service acceptance must bind supplier, SKU, unit and exact quantities. Unknown identities and unexplained mismatches hold for purchasing/receiving. | Which service acceptance, quantity and price-variance evidence is acceptable? |
| Partial acceptance | Explicit accepted quantities, net/tax and coding; retain invoiced and disputed amounts. No automatic short-pay. | When is the disputed remainder an obligation, accrual or documented non-obligation? |
| Coding / recognition | Supported expense, inventory, prepayment or fixed-asset cost with exact store and period. USD/nonrecoverable tax only in current policy; unsupported treatments hold. | Select actual recognition timing, tax treatment and account/dimension policy. See engineering gaps. |
| Independent approval | Current subject-to-seat binding; distinct underlying people across quorum, delegation and stages. Requester cannot approve its own proposal. Policy bands and variance route are explicit. | Approve role membership, thresholds, escalation, delegation and recertification rules. No university threshold is imported implicitly. |
| Supplier / bank change | Retained independent contact, explicit callback attestation and different approver; active immutable supplier revision revalidated for new payment. An invoice cannot establish bank authority. | Define verification evidence, legitimate contact replacement and emergency process. Software did not make a phone call. |
| Payment | Independently authorize exact gross/credit/cash, destination and initiation date. New installments need new authorization. | Approve funding controls, dates, working-day/cutoff expectations and payment-run authority. |
| Unknown outcome | Treasury observes original operation; possible prior send keeps key/request/reservations. Only provably unattempted work can be canceled and released. | Define escalation and acceptable bank proof before replacement. |
| Credit / correction | Link original approved quantities, tax and cost shares. Corrected costs require explicit current snapshot-bound shares and variance approval. Preserve original journals. | Approve return evidence, signed discounts and correction allocation methods. |
| Close | Reconcile supplier statements, AP/GL and bank evidence separately. Explain all receipt capacity and disputes. Unpaid recognized AP may carry forward. | Approve opening evidence, cutoff, accrual estimates, materiality, permitted dispositions and reopening authority. |
| Communication | “Recorded” or “simulated” is not “sent/delivered.” | Specify actual supplier communication process and evidence if it is required. |

## Casebook: exact expected entries and observed evidence

All numbers below are **integer USD cents**. `Dr` and `Cr` denote ledger sides. Accounts are the synthetic configured chart: cash `1000`, inventory `1200`, prepayment `1300`, fixed asset `1500`, AP `2000`, accrued liabilities `2010`, expense `5000`. Cost lines retain the configured store; liability lines identify the supplier. No foreign-currency conversion or tax rule is inferred. Each numbered posting balances separately.

### C01 — clean original PDF, full recognition and payment

**Expected:** recognition dated 2026-10-19: Dr5000 19,250 + 17,100 + 20,670 + 10,840; Cr2000 67,860. Settlement dated 2026-10-25: Dr2000 67,860; Cr1000 67,860. Final approved AP 0; two journals, one bank debit. Payment must not expense the purchase again.

**Observed HTTP/browser/FakeBank:** I1 reports those exact entries, one transfer and one posted debit after replay. Run `ap97-20261025-01a1722e`, case `js7dsh0qwptbgg2ngm9vgbt6bs8gy13s`, bill `ks74ffsbn080a1wvxhtjks018h8gz3zv`; recognition `px76qn00zd681czahsp6svz2h98gzjcx`, settlement `px78rpe73jxyh7dm80g20qd1h98gyae7`, linked to `txn_b0471d416cde760f0011255c`. Use the linked JSON as the identifier authority.

I1 preserved 35 fields: 33 native locations and two unresolved; field review was distinct from bill acceptance. Renaming the four originals under a new request retained four additional delivery records without another obligation; reusing a key for changed input returned 409. Initial HTTP parsing reused four previously completed genuine LlamaParse jobs; I1 did not make a new parser request. Requested parser version was 2026-09-28; resolved version was unavailable.

**Review:** confirm immediate-expense policy and receipt timing; assess unresolved-field review; inspect both journals back to their source. These are local simulated humans and FakeBank, not Increase.

### C02 — mismatched quantity is not an automatically reduced bill

**Expected:** separate invoice claims six kale cases while PO/receipt support five; total 71,710 versus supported clean-packet 67,860. First-wave policy holds `po_mismatch` / `receipt_mismatch`; accepted amount, new bill and transfer remain absent. No 3,850-cent write-off or short-payment is inferred.

**Observed component/independent:** V1 verifies source arithmetic; V2 negative paths verify holds. This is a separate fixture, not a revision silently applied to settled C01.

**Review:** purchasing/receiving must determine corrected invoice, additional receipt, authorized partial acceptance or an explicit remaining dispute. A note is not supplier notification.

### C03 — actual I2 partial acceptance and separate cash authorization

**Expected:** accept quantities 2/2/1/1, giving cost lines 7,700 + 8,550 + 6,890 + 5,420 = 28,560. Dr5000 those four amounts; Cr2000 28,560. Original remains 67,860; disputed remainder 39,300. Then Dr2000 10,000; Cr1000 10,000. Approved outstanding AP is 18,560, not zero.

**Observed HTTP/browser/FakeBank:** [I2 JSON](evidence/I2-business-flow.json) reports these exact amounts/entries. Run `ap97-b3-live-20261025`, case `k175gds0dypbgeknejs2henw5h8gysw8`, bill `n577wxmcdgn3t9ygpa1yd4jgc18gzzpz`; recognition `r979g69xn1zq8a6yfryaybst3s8gzvw1`, settlement `r9749h5e6zshqqz13mmywdtwqn8gzbrf`, bank transaction `txn_c2e7742b05dbb4841839d6a8`. Policy `ap97-b3-quorum2-finance-v1` required two distinct owner seats then finance. One transfer/debit remained after worker replay.

A separately authorized future 2026-11-02 initiation produced zero transfers before that date and was canceled before any attempt. A later independently authorized 2026-10-25 snapshot paid 10,000. Canceled records remain in history. `Settled/Matched` describes that cash operation; the bill remains partially paid and its dispute is still unresolved.

**Review:** adjudicate the 39,300-cent remainder and cutoff. A future initiation date means 00:00 UTC in current policy, not guaranteed arrival or local banking cutoff.

### C04 — small partial receipt and non-PO alternative

**Expected under B3:** original 7,700 for two units, explicit acceptance of one 3,850 unit gives Dr configured cost 3,850; Cr2000 3,850. Original/disputed/accepted remain 7,700/3,850/3,850. Missing PO is acceptable only through the supported contract+service-acceptance route; missing acceptance holds.

**Observed component:** B3 tests exercise these actual backend decisions; root's cross-layer FakeBank test separately pays 2,000 of the accepted 3,850, leaving 1,850. The separate non-PO component fixture recognizes the full 7,700: Dr5000 7,700 / Cr2000 7,700 under contract/service-acceptance evidence. Neither component test is the original PDF/browser I2 journey. Review non-PO proof and each selected account.

### C05 — taxed credit, rounding and zero-cash application

1. Original: Dr5000 4,235; Dr1200 4,235; Cr2000 8,470 (net 7,700 + declared nonrecoverable tax 770).
2. First 4,235 return credit: Dr2000 4,235; Cr5000 2,118; Cr1200 2,117.
3. Second 4,235 return credit: Dr2000 4,235; Cr5000 2,117; Cr1200 2,118.

**Expected/observed component:** [B3 credit tests](../../tests/ap-system/business-credits.test.ts) consume remaining exact allocation cents and original returned units. Both credits together reverse exactly 4,235 per cost account and 770 tax. Reused original return bytes cannot gain capacity from renamed source/parser IDs.

Applying the first already recognized credit to the bill creates an immutable application receipt but **no new journal and no bank command**. Bill-level allocation becomes 4,235 paid by credit and 4,235 outstanding. Before application, the unapplied supplier credit already reduces supplier net AP; application changes the link, not expense or AP recognition again. Review tax classification, return evidence and the distinction between bill gross outstanding and supplier net AP.

### C06 — partial cash plus credit, then returned cash

**Expected component sequence from V3:** original bill 7,700; credit 1,200; first discharge 5,000 = credit 1,200 + cash 3,800; second cash 2,700; first cash returns 3,800; replacement cash 3,800.

| Posting | Debit | Credit |
| --- | --- | --- |
| Invoice | Cost 7,700 | AP 7,700 |
| Recognized credit | AP 1,200 | Original cost 1,200 |
| First cash settlement | AP 3,800 | Cash 3,800 |
| Second cash settlement | AP 2,700 | Cash 2,700 |
| Verified returned cash | Cash 3,800 | AP 3,800 |
| Authorized replacement settlement | AP 3,800 | Cash 3,800 |

[V3](evidence/V3.md) records six journals, final AP 0 and net cash paid 6,500, with the credit consumed once. Unknown outcome is not a return; it cannot authorize these corrective entries or a new operation. QBO return/replacement tests use in-memory protocol and explicitly seeded Increase-shaped evidence where stated; those are not actual Increase observations.

### C07 — credit after two cost reclassifications

**Expected/observed independent component, V5 extension:** (1) Dr5000 7,700 / Cr2000 7,700. (2) Dr1200 3,000 / Cr5000 3,000. (3) Dr1300 500 / Cr1200 500. (4) Explicit corrected credit: Dr2000 3,850 / Cr5000 850 / Cr1200 2,500 / Cr1300 500. (5) Second credit: Dr2000 3,850 / Cr5000 3,850. Final cost and AP zero; five journals, one original bill, zero payment commands.

Each credit binds original line/allocation index, exact signed cents, store and immutable current cost snapshot; configured variance approval is required. Original journals stay unchanged. A one-cent reclassification followed by its exact reverse still changes history and invalidates an earlier approval snapshot, even when balances match again. Review the economic basis for reallocating credit shares; numerical balance alone does not establish that basis.

### C08 — explicit signed discount reversal

**Expected/observed owner component:** original gross cost 7,700 less discount 770: Dr5000 7,700 / Cr5000 770 / Cr2000 6,930. Reclassify: Dr1200 1,000 / Cr5000 1,000. Full corrected credit: Dr2000 6,930 + Dr5000 770 / Cr1200 1,000 + Cr5000 6,700. The last entry balances at 7,700 on each side; the credit's signed cost export is 1,000 + 6,700 − 770 = 6,930. See [cost tests](../../tests/ap-system/cost-corrections.test.ts).

The 770 debit is an explicit reversal of the original discount credit, not additional cash or a second AP obligation. Account/store/sign must survive external replication. Review discount presentation and evidence.

### C09 — period accrual followed by late invoice

**Expected/observed B4 component:** October accrual Dr5000 7,700 / Cr2010 7,700. November invoice Dr5000 7,700 / Cr2000 7,700, plus exact accrual reversal Dr2010 7,700 / Cr5000 7,700 in the same transaction. Final cumulative cost 7,700, AP 7,700, accrued liability zero. October's as-of report still shows its original 7,700 accrual; November's cost movement from the invoice/reversal pair nets zero.

Original invoice date remains visible; explicit accounting date and same-period allocations require the applicable review. Missing, excessive or mismatched receipt-linked accrual applications hold. Review receipt cutoff, estimate, invoice date versus posting date and reversal convention; do not assume the synthetic dates are appropriate for a real close.

### C10 — corrected accrued cost and split partial reversals

**Expected/observed independent component, V5 extension:** accrue 7,700 to expense; reclassify 3,000 to inventory then 1,000 of inventory to prepayment. First manual reversal: Dr2010 3,850 / Cr5000 850 / Cr1200 2,000 / Cr1300 1,000. Later recognize the full 7,700 invoice to expense/AP and reverse only residual accrual Dr2010 3,850 / Cr5000 3,850. Six journals; final expense/AP 7,700; inventory/prepayment/accrued zero; no bank command.

One original allocation split across three corrected accounts remains the same original allocation identity. Owner tests additionally verify two original shares 3,851/3,849 reverse as 1,926/1,924 then 1,925/1,925. Missing correction plans and stale/excess applications hold. Review the corrected cost basis and the matching of accrued versus invoiced units.

### C11 — a historical accrual does not discharge a standalone receipt

**Expected:** a standalone receipt documents two units × 3,850. Accruing only one unit (Dr5000 3,850 / Cr2010 3,850) leaves one unit/3,850 unaccounted for and blocks close. Accruing both (7,700) then reversing both (Dr2010 7,700 / Cr5000 7,700) leaves all two units unaccounted for and also blocks close, absent supported disposition or invoice recognition.

**Observed independent defect and repair:** V5's original public close attempts incorrectly succeeded. [Repair evidence](evidence/V5-repair.md) preserves that baseline and shows the same attempts now reject; fully covered receipt plus legitimate unpaid AP can close. A reversal itself is not a declaration that the received goods cease to be an obligation. Owner: receiving/AP for facts; controller for accounting/disposition.

### C12 — statement, AP/GL and bank reconciliation are separate

A supplier statement ending 7,800 versus known AP 7,700 leaves a 100 discrepancy for documented resolution; it does not automatically generate a 100 journal or permit an unrecorded write-off. Malformed statement arithmetic, duplicate or out-of-period lines require correction. Equal statement totals can hide omitted offsetting bill/credit lines and are insufficient.

A 100 unexplained AP credit in the GL blocks AP-to-subledger reconciliation even if all journals balance. Verified bank movements must match separate cash entries. A recorded 1,000,000-cent prior cash balance must appear in reviewed openings; zero cannot be substituted. Initial FakeBank liquidity is not opening cash-ledger evidence.

**Observed component:** B4 tests cover each control and legitimate unpaid 7,700 AP carryforward. Closing/reopening records a governed status/history change, not a journal that clears unpaid AP. New bank evidence after lock creates an owned exception/stale close snapshot; reopening under control permits the original settlement posting once, without another transfer. Practitioner: adjudicate statement exceptions, opening evidence, cutoff and reopening policy.

### C13 — supplier identity, quorum and replay controls

Supplier verification/bank revision, source review, proposal and payment authorization are different records; these decisions produce **no cost/AP/cash journal merely by being approved**. Recertifying unchanged bill economics reuses its original journal.

**Observed independent defects/repairs:** V4 shows original capacity reuse through renamed IDs, retired supplier verifier accepted at activation, and two subjects sharing one seat filling quorum. Repairs bind original semantic capacity and current underlying seats, including delegated principals and retained verifier authority. A new source/supplier/policy invalidates unattempted authority; possible prior sends retain original keys and reservations. Review approved group membership, evidence retention and independent verification practice. The still-missing trusted-contact replacement workflow is an engineering item in the audit.

### C14 — QBO replication and external evidence boundary

Internal approved invoice/credit/close journals are the source for immutable external plans. Intended QBO objects are Bill, VendorCredit, BillPayment or JournalEntry with explicit account/vendor/store-Class mappings. Submission requires current human authority and exact preview hash; rereads compare identities, signed amounts and dimensions. Local journals must not be posted again because a QBO response was lost. QBO does not execute the bank transfer; Increase is the selected external execution provider.

**Actually external at the packet baseline:** [OAuth/read-only](evidence/C4-live-connection.md) verified 89 accounts and 26 vendors with zero writes at that time. Later authorized [mapping setup](evidence/C4-live-mappings.md) created one synthetic vendor, six dedicated accounts and one Class; all eight were read back and replay created zero. Existing AP account 33 was retained; store Class 739762 and Vendor 200000001 are reference IDs. This is **not** a Bill/VendorCredit/BillPayment/JournalEntry round trip, and no Increase transfer is recorded by I1/I2.

**Observed independent in-memory protocol:** V5 rejects malformed/incomplete QBO query proof and unexpected/changed Class dimensions. Local restored-credit and period export protocols have tests. Practitioner must assess account/mapping semantics and return/replacement presentation; external IDs and actual readback for accounting transactions remain separate acceptance records.

## Walkthrough vocabulary checklist

| Term | Evidence-backed review moment |
| --- | --- |
| System of record | C01 originals versus C13 verified supplier destination versus C14 external replica. |
| Subledger | C05 unapplied/applied credit and C12 supplier/bill detail. |
| Chart of accounts | C01 expense choice; C07/C10 corrected account choices. |
| Journal entry | Open both C01 dated journals and the exact source links. |
| Double-entry bookkeeping | Balance every posting above; then separately assess account/date correctness. |
| General ledger | C12 AP/2010/cash account totals versus detail. |
| Materiality | Discuss explicit variance/disposition policy; matching tolerance is not general audit materiality. |
| Internal controls | C02 hold, C11 receipt capacity, C13 stale/alias rejection. |
| Segregation of duties | C03 owner quorum then finance, followed by separate payment authorization. |
| Controller | Human accountability for C09–C12; controller agent proposes but cannot supply its own human judgment. |
| Reconciliation | Distinguish source matching, supplier statements, AP/GL, bank/cash and external QBO readback. |
| Period close | C11/C12 cutoff, unpaid carryforward, lock/reopen; not a complete enterprise close claim. |
| Audit trail | C01/C03 source → approval → bill → command → bank → journal and back; preserve original/repair evidence. |

No boxes in this packet are pre-checked for the practitioner. Each case may be accepted, conditionally accepted, rejected or left unreviewed only by recording the actual review and its scope.
