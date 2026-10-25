# AP practitioner review packet

> **2026-10-25 scope update:** This is historical practitioner preparation. The user replaced the practitioner delivery gate with [Claude 独立模型评审](CLAUDE-REVIEW.md), to be run by the external recipient using a frozen blind derivation before implementation comparison. A real practitioner is no longer required for this delivery; none is claimed. CI is deferred; actual QuickBooks/Increase acceptance remains unchanged.

**Practitioner review and sign-off: pending.** This packet prepares a real AP/accounting reviewer to assess the declared company policy and observed behavior. Independent agent verification, software tests and workflow approvals are not practitioner approval. No reviewer conclusion is filled in on their behalf.

Refreshed against integration `1a5dc708ef0de26fbd1f2f7f82c33f49a914ae28`, 25 October 2026. Adopted issue #97 SHA-256: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Preparing this refresh involved source/report inspection and document/arithmetic checks, not an application, provider or payment run.

## Agreed scope and how to use this packet

The user selected **USD only for this delivery**. Other currencies remain explicit unsupported holds; multicurrency/FX is moved to [follow-up #104](https://github.com/srivatsav-kannan/autonomous-finance/issues/104). This is an explicit scope decision, not a claim that FX is implemented. Acceptance targets laptop/desktop web browsers. Future hosting is separate; no current production deployment or real-money operation is included.

1. Read the original documents and provenance before consulting expected results.
2. Read the [historical casebook, C01–C14](PRACTITIONER-CASEBOOK.md) and [current policy cases, C15–C22](PRACTITIONER-CURRENT-CASES.md). Each distinguishes expected effects from the linked execution evidence.
3. Use [expected postings](PRACTITIONER-EXPECTED-POSTINGS.json) for exact integer-cent arithmetic. These are **EXPECTED_ONLY**, never substitute journal IDs or external receipts.
4. Record the actual review in the [unfilled review template](PRACTITIONER-RECORD-TEMPLATE.md). The [engineering/status audit](PRACTITIONER-ENGINEERING-AUDIT.md) separates remaining software validation from external acceptance.

The current extensions are opt-in capabilities. Their synthetic tax rules, dimensions and approval groups were used in tests; they were not automatically installed as the operator's active policy. The reviewer must decide which rules are appropriate for the intended entity. Nothing here infers statutory eligibility from the mere presence of tax on an invoice.

## Originals and evidence classes

The initial packet is synthetic Golden State Produce Co. invoice INV-1001, dated 2026-10-19, due 2026-11-02, USD, Net 14. The [manifest](../../fixtures/ap-system/golden-state-v1/manifest.json) freezes original invoice, PO, receipt and contract PDFs, plus the separate quantity-discrepancy original. Source inputs and evaluator answer keys are separate. Supplier contacts, local identities and company data are synthetic; no supplier callback or notification was performed by this software.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| [V1](evidence/V1.md) | Independent agent derivation from initial originals | Practitioner judgment |
| [I1](evidence/I1-integrated.md) / [actual IDs and hashes](evidence/I1-integrated.json) | Actual local HTTP/source review/bill/FakeBank/settlement path at its recorded revision | Increase payment or live QBO accounting |
| [I2](evidence/I2-business-flow.md) / [actual IDs](evidence/I2-business-flow.json) | Persisted partial recognition and cash settlement with simulated humans | Real operator or practitioner acceptance |
| [V8](evidence/V8-E03-final.md), [V9](evidence/V9-E04-repair.md), [V10](evidence/V10-E02.md), [V11](evidence/V11-repair.md), [V12](evidence/V12.md), [V13](evidence/V13-repair.md) | Bounded independent engineering checks of contact, physical identity, dimensions and tax controls, with retained earlier failures | One combined end-to-end run or unique additive test population |
| [Actual QBO mappings](evidence/C4-live-mappings.json) | Eight reference records created/read back; replay created zero | Bill, VendorCredit, JournalEntry or BillPayment transaction acceptance |
| [Tax QBO protocol](evidence/E01-qbo-tax-reclassification.md) | Implemented current-authority export and durable read-only recovery under local protocol doubles | Real QBO tenant acceptance |

The earlier QBO read-only check observed 89 accounts and 26 vendors with zero writes; the later eight reference writes are a separate event. [Real Auth0 browser login and explicit scoped binding](evidence/C2-auth0-live.md) are now verified; actual user field/bill/payment decisions and external economic transactions remain separate gates. Do not describe Auth0 as unconfigured or reference mappings as accounting transactions.

## Rules to assess

| Condition or action | Enforced outcome and responsible decision |
| --- | --- |
| Incomplete content/pages, unknown supplier/SKU/unit, missing receipt/service evidence, price/quantity discrepancy | Owned AP/receiving/purchasing hold. Corrected evidence or explicit policy-authorized resolution is required. No invented receipt or automatic short-pay. |
| Supported content with unresolved geometry | Explicit review of the exact original and retained reason can establish field review. A highlight never grants business/payment authority. |
| Field review, bill recognition, payment | Separate decisions. Recognition posts only the explicitly accepted amount once; disputed invoice remainder stays visible. Payment needs an exact current amount/destination/date authorization. |
| Repeated delivery, revised source, stale authority | Deduplicate obligation/effects; retain source history. Material change invalidates new authority. Provably unsent cancellation and possible-send reconciliation remain distinct. |
| Supplier onboarding/bank change | Independent previously held channel, current verifier and separate approver. Invoice bank text cannot update the destination. |
| Replacement of that trusted channel | Independently acquired source, separate recorder/verifier/approver, and unavailable-old-channel escalation where required. Proposal holds new authority but does not cancel human-authorized payments; human approval uses governed unsent cancellation. Rejected changes require explicit reviewed restoration/supersession. See C21. |
| Repeated physical receipt lines | Positive independent mapping to one original-hash catalog before use; exact physical and aggregate capacity, explicit partial allocation. Rename/reorder/split/merge cannot manufacture capacity. See C20. |
| Coding and dimensions | Explicit account/treatment and permitted store/department/project allocations. Corrections preserve original lineage and exact coordinates. `cost_and_settlement` additionally requires a homogeneous approved department; legacy cost-only coding does not invent an AP/cash department. See C19. |
| Recoverable purchase tax | Explicit approved jurisdiction/date/basis/rate-or-stated-amount/recovery/rounding policy, appropriate noncash receivable account and additional independent tax review. Invoice facts and independent eligibility evidence are distinct. See C15. |
| Freight/discount tax basis | Exact original and accepted line shares plus current source citations. Derived base is labeled derived; no fabricated printed base. Cumulative header and tax capacity bound later credits. See C16. |
| Later eligibility change | Separate approved noncash tax adjustment, current cost/tax snapshots, exact original attribution and current remaining buckets. No rewriting original invoice/journal, AP or cash. Subsequent credits reverse those buckets once. See C17–C18. |
| Accrual, close and reopening | Received-but-not-invoiced/disputed items remain visible; supplier statements, AP/GL, opening balances and bank exceptions require explicit reconciliation/disposition. Unpaid recognized AP may carry forward. Closed periods reject prohibited posts; reopening/adjustment needs exact reviewed authority. |

Current human/principal seat identity, group membership, required stages and applicable policy are checked again when authority is used. A model recommendation, source annotation, old vote or alias of the same person cannot substitute for an independent current decision.

## Anchored amounts: keep original and component cases separate

INV-1001 contains Kale 5 × 3,850, Romaine 4 × 4,275, Avocado 3 × 6,890 and Tomato 2 × 5,420 cents: **67,860 cents** with no tax/freight/discount. I1 observed recognition Dr expense 5000 $678.60 / Cr AP 2000 $678.60, then settlement Dr AP 2000 $678.60 / Cr cash 1000 $678.60. Its recognition retains four expense lines. One transfer, one posted debit and two journals were observed; payment did not expense the purchase again.

I2 separately observed explicit acceptance **$285.60**, disputed remainder **$393.00**, and authorized cash **$100.00**. Recognition Dr 5000 $285.60 / Cr 2000 $285.60; settlement Dr 2000 $100 / Cr 1000 $100; approved AP remaining **$185.60**. The prior future-date proposal sent nothing before its date and was canceled before any attempt. These are actual local results, not the smaller $77/$84.70 component tax cases.

The first Golden State rule accepted only a fully validated amount. The broader route now supports explicit partial acceptance and credits under separately configured rules. For a bank payment, cash equals selected gross discharge less recognized selected credits and must be positive. A zero-cash credit application is its own authorized operation and does not book the credit twice. Initiation is 00:00 UTC on the chosen date, not a promised bank arrival time; rescheduling cannot replace an uncertain prior send.

## External accounting and supported boundaries

QuickBooks Online US sandbox is the selected external accounting connector; Increase executes payments. The local scoped ledger/approvals remain authoritative for what may be exported. QBO operations require exact mappings, current authorization and preview hash; ambiguous writes retain the original identity. Settlement exports must never initiate QBO merchant processing.

Tax adjustments now have a separate QBO JournalEntry adapter linked to the already synchronized original Bill. This implements GL replication, not QBO statutory tax codes, a return, refund or filing. Missing/mismatched receivable mapping, changed original Bill, changed dimensions or authority causes a hold. A saved ambiguous/succeeded tax operation can be investigated through a narrowly authenticated read-only historical receipt path after policy retirement; that path cannot create/repost, remap, or authorize a new transaction. See C22.

Store maps explicitly to Class. Department maps to Location only under the reviewed mapping and homogeneous-authority rules. Project cost mapping requires current catalog/customer/entitlement evidence and explicit billability; supported local project coding does not imply every QBO JournalEntry project/Entity combination works. Unsupported JournalEntry project combinations and project cash dimensions remain held, never silently dropped. No new tax receivable, department or project mapping is claimed live merely because local tests pass.

Declared limits include USD only; configured accounts/dimensions; one supported tax treatment/rate per line; no automatic eligibility/rate selection, compound tax, withholding, reverse-charge, tax filing/refund or inferred recoverability on pre-invoice accruals. Unsupported currency, extraction/normalization and ambiguous historical tax/physical attribution stay held. Upload/format and external discovery bounds remain explicit in the current capability matrix. These limits are not universal accounting conclusions.

## Questions and still-unfilled decisions

- For the intended entity, when should produce/services be expensed, inventoried, prepaid or capitalized? Which account, store, department/project and accounting date establish the correct result?
- What independently retained evidence establishes receipt/service acceptance, supplier contact provenance and tax eligibility? Are the current recorder/verifier/escalator/approver roles sufficient?
- Which allowed rates or stated-amount rules, tax point dates, inclusive/exclusive bases, recovery ratios and rounding rules are appropriate? How should freight/discount and changed eligibility be approved?
- Do the exact signed credit/reclassification/accrual reversals conserve the right remaining amounts and dimensions? Are the controlled holds understandable and recoverable?
- Are statement/AP-GL/bank reconciliations, opening evidence, cutoff, unpaid carryforward, period locks and reopening rules adequate?
- Are QBO account/Class/Location/Project mappings and returned-payment representations appropriate? Assess business meaning separately from API type/ID matching.

Remaining acceptance is explicit: current integrated desktop workflows and final regression evidence; actual operator decisions and configured policy/mapping choices; authorized QBO accounting transaction round trip and Increase execution/recovery; and real practitioner review. Individual component and browser-fixture results do not replace these gates. Earlier independent defects and repairs remain in their revision-bound reports; do not sum overlapping test counts.

Reviewer identity/experience, review date, exact reviewed revisions, findings, accepted limits and sign-off/rejection are all **unfilled** in the separate template. This packet neither approves a policy nor authorizes a payment.

Preparation checks for this refresh: 111 relative document/source links resolve; all five original PDF hashes match the frozen manifest; all 13 prior machine-readable scenarios are preserved unchanged; 22 current scenarios contain 58 balanced integer-cent expected entries. Full-reversal balances and the C19 net AP/cash/cost balances were recomputed. These are document and arithmetic checks, not new application execution or business approval.
