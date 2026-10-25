# AP practitioner review packet

**External business review: pending.** No AP/accounting practitioner is currently available. The user directed all engineering, automated tests and independent agent verification to continue. This packet records expectations and measured engineering evidence; it contains no practitioner sign-off.

## Review material and provenance

First case: synthetic Golden State Produce Co. invoice INV-1001, invoice date2026-10-19, due2026-11-02, USD, Net14. Four original invoice/PO/receipt/contract PDFs are in `fixtures/ap-system/golden-state-v1/input/`. The [manifest](../../fixtures/ap-system/golden-state-v1/manifest.json) freezes each original hash and provenance. Source fields and expected results are kept separate; runtime ingestion cannot load the answer key.

The [V1 independent review](evidence/V1.md) derives values from originals before examining the expected-result file. It is an independent agent engineering review. The [I1 integrated report](evidence/I1-integrated.md) records the observed same-case workflow at code a13b131, contract ap-evidence-v1, policy golden-state-ap-v1 and run ap97-20261025-01a1722e. The requested parser is LlamaParse agentic_plus, version2026-09-28; the provider did not expose its resolved version. Original hashes, native/unresolved counts and exact bill/payment/bank/journal IDs are in [I1 JSON](evidence/I1-integrated.json).

All supplier contacts, source documents, local identities and FakeBank effects in this case are synthetic. Private parser/raw artifacts and credentials are excluded from this review packet. QuickBooks US sandbox is configured and its actual OAuth callback is fixed; owner consent is pending. External accounting IDs and practitioner findings remain empty until observed.

## Business rules for review

| Condition | Current decision and owner | Required release evidence |
| --- | --- | --- |
| Missing receipt or incomplete pages/content | Hold; receiving or AP owner | New receipt/corrected original and renewed source-bound review; an agent's estimate is insufficient. |
| Invoice versus PO/receipt price or quantity differs | Hold; purchasing/receiving owner | Corrected invoice/credit or an explicitly authorized resolution under the applicable policy. No automatic short-pay. |
| Unknown supplier/SKU/unit | Hold; AP or purchasing owner | Trusted supplier/catalog mapping and corrected evidence. Parsed bank text does not establish a beneficiary. |
| Content supported, location unresolved | Explicit field review required | Reviewer inspects the exact original revision/text and retains reason; missing geometry grants no business authority. |
| Field review approved | Document reviewed only | Bill approval remains a separate business decision. |
| Bill approved and recognized | One linked payable and balanced journal | A separate exact payment proposal and independent human authorization are still required. |
| Material source revision | Invalidate affected review; preserve history | Cancel/release provably unsent operations; possible prior sends retain original request/key and reservations pending bank resolution. |
| Repeat/renamed invoice delivery | Associate to existing obligation | Retain delivery provenance; no second bill or economic posting. Changed facts require explicit revision. |
| Suggested vendor bank change | Never substitute into payment from invoice text | Trusted independent verification and authorized destination configuration; current configured beneficiary is immutable for the run. |
| Vendor notification | No delivery claim from a memory note | Actual communication evidence is needed; this implementation has not sent a supplier communication. |

The first-wave Golden State policy accepts only the full validated amount; zero unexplained price/quantity variance is the versioned company choice. These limits require business review, not implicit adoption from a cited external policy. B3 now provides explicit expanded policies; its implemented rules and synthetic evidence follow below and still require practitioner review.

## Cases, amounts and expected accounting

| Case | Source facts and expected outcome | Evidence status |
| --- | --- | --- |
| Clean INV-1001 | Kale5×3850=19250; Romaine4×4275=17100; Avocado3×6890=20670; Tomato2×5420=10840. Total67860 cents, zero tax/freight/discount. After independent decisions, recognize67860 and pay67860. | V1 original derivation; I1 local integrated PASS. |
| Quantity discrepancy INV-1001-QTY | Invoice Kale6, PO/receipt5; invoice total71710. Expected `po_mismatch` and `receipt_mismatch`, no accepted amount, bill or transfer. | V1 independently checked expected rule/output; V2 integrated negative cases PASS; no payable/payment released. |
| Two unresolved locations | Supplier name and currency content retained; precision not invented. Review exact original/text before bill approval. | I1 33 native +2 unresolved out of35 fields; actual local review retained. |
| Upload retry after restart | Return original saved response and case identity. | I1 live HTTP PASS. |
| Renamed original under new request key | Retain four additional delivery records; one obligation and unchanged economic effects. | I1 live HTTP PASS. |
| Changed request with reused key | Reject409 intake_key_conflict. | I1 live HTTP PASS. |
| Possible send / lost response / interrupted posting | Reconcile original operation; no replacement key while uncertain, no duplicate economic effect. | C1 and independent V2 recovery tests PASS; original operation recovered without duplicate effects. |

For the clean case, expected recognition is **Dr expense5000 $678.60 / Cr AP2000 $678.60**. The actual journal retains four expense lines ($192.50, $171.00, $206.70, $108.40) and one AP credit. Expected settlement is **Dr AP2000 $678.60 / Cr cash1000 $678.60**. Payment does not recognize expense again. I1 observed one transfer, one posted bank debit, one recognition entry and one settlement entry; outstanding AP is$0.00 after two worker cycles.

This immediate expense treatment is the deliberately limited first policy. Inventory, fixed assets, prepayments, tax treatment, posting-period selection and corrections need explicit reviewed policy; they are not inferred merely from the word invoice. B3/B4 must expand this packet with exact supported treatments and exceptions.

## Expanded business policy cases awaiting practitioner review

B3 uses versioned authenticated-human groups, amount thresholds, sequential quorum, escalation deadlines and bounded delegation. The source/proposal creator cannot approve the same proposal; one person or delegated principal cannot fill two required positions. Expired/revoked delegation or a changed supplier/policy invalidates authority for new payment release. Supplier onboarding and bank changes require a previously held independent contact, recorded callback attestation and a different approver. `operator_recorded` means an operator recorded evidence, not that this software placed a call; local tests use explicit `simulated` labels.

| Case | Expected accounting and control | Current evidence |
| --- | --- | --- |
| Partial receipt | Original invoice$77.00 for2units; explicitly accept1unit$38.50. Dr configuredcost$38.50 / CrAP$38.50; retain$38.50disputed. No inferred short-pay or bank command. | B3 component and root business-payment integration tests. |
| Partial cash on approved portion | Independently authorize$20.00 against approved$38.50. DrAP$20 / Crcash$20; outstanding$18.50, original invoice stays$77.00. | Root scheduled FakeBank test; different verified supplier destination. |
| Non-PO service | Contract and service-acceptance lines support exact supplier, quantity, unit and amount. Missing PO alone grants no authority; missing acceptance holds. | B3 typed backend tests; browser integration pending. |
| Credit with nonrecoverable tax | Original$77net+$7.70tax=$84.70, expense/inventory split$42.35each. Two$42.35returncredits reverse$21.18/$21.17 then$21.17/$21.18. DrAP for eachcredit; cumulative cost reversal exactlymatchesoriginal. | B3 credit tests; original quantities and retained return capacity bounded. |
| Credit-only application | Apply recognized$42.35credit to approved$84.70bill: grosspaid$42.35, cash$0, outstanding$42.35; noadditionaljournal and nobankcommand. | B3 application/replay tests. |
| Verified bank change | Cancel only provably unsent proposal; recertify samebill againstnewverifiedrevision, preservingoriginalrecognition. Possibleprior send keepsoriginaldestination/keyuntilresolved. | Root payment integration plusB3 boundaries. |

Configured policies support USD, selected expense/inventory/prepayment/fixedasset accounts, stores and nonrecoverabletax. Othercurrencies retainoriginalvalues withownedholds; recoverabletax, unconfiguredaccounts/stores, department/projectdimensions and unsupportedperiods are held. These are explicit currentpolicy limits forreview, not assertions of universal accounting/tax treatment. Proposed changes to recognizedamounts/coding require linkedcredits/corrections; originaljournals cannot be rewritten.

## Scheduling, partial payment and payment-run rules awaiting business review

The C3 engineering policy treats an initiation date as **00:00 UTC on the selected business date**, not a promised arrival date. It is frozen in the authorization hash. Retry timing is separate. Rescheduling requires cancellation of a provably unsent payment and a new exact authorization; an operation that may have been sent must retain its original request and key while the bank outcome is resolved.

A reviewer explicitly chooses the gross payable amount and any recognized available credits. Cash equals gross less credits and must be positive for a bank payment. A full-credit, zero-cash application is a distinct B3 business operation. No unexplained short-pay or credit is inferred from the difference. A later installment requires a new proposal and authorization against the then-outstanding balance. Payment runs hold one immutable payment identity per case; one stale or unavailable member causes atomic preparation/authorization/cancellation to roll back. Cancellation cannot erase a possible bank send.

The C3 automated FakeBank case starts with a $100.00 recognized bill and a $20.00 recognized supplier credit. First discharge $60.00 = $20.00 credit + $40.00 cash; the bill balance becomes $40.00. Second authorized cash payment $40.00 clears it. Expected postings are Dr cost $100 / Cr AP $100; Dr AP $20 / Cr original cost $20; Dr AP $40 / Cr cash $40 twice. Final AP is $0, expense net $80 and cash paid $80. The component test observes two transfers, two posted debits and four journals, with no extra effects on replay. This is synthetic automated evidence, not external bank acceptance or practitioner validation. Independent V3 confirms a second sequence: bill$77, credit$12, first gross$50 with cash$38, second cash$27, first cash returned$38, then replacementcash$38. Expected finalAP$0 and netcash$65; exactly6journals including the return and replacement, with the$12credit consumed once. See evidence/V3.md.

The corresponding QuickBooks connector has local tests for exact recognized partial bills, supplier credits, partial cash/credit settlements and zero-cash credit applications. Current returned-payment and signed-cost cases produce controller-owned holds; their external correction representation is still incomplete. Historical successful receipts remain visible separately from these current holds. A successful local journal must not be described as an external QuickBooks record. Browser login is implemented with Auth0, but the development tenant and approved real human have not yet been configured.

## Current independent engineering findings

V4 on immutable a8ea9ef found three unresolved implementation defects: renamed source/parser line identifiers can reuse original receipt capacity; a retired verification actor can leave a supplier verification accepted at approval; two subjects sharing one human seat can satisfy a quorum. The intended rules above are not accepted as satisfied until the owner fixes these cases and the independent verifier reruns the exact reproductions. No practitioner conclusion is inferred.

## Reviewer questions and completion gaps

1. Are recognition timing, account5000, store allocation and period appropriate for this synthetic grocery receipt scenario? What policy changes are required for inventory or prepayments?
2. Are the discrepancy owners, allowed resolutions and full-amount first-wave rule adequate? Which partial receipts/credit applications need distinct review and allocations?
3. Are source review, bill approval, payment preparation and independent authorization appropriately separated for the intended company?
4. Is the distinction between source matching, AP-to-GL reconciliation and bank/cash reconciliation clear? Initial FakeBank funds are not proof of a reconciled opening cash GL balance.
5. Are later source corrections, rejected/returned payments, unmatched bank activity and unpaid AP carryforward treated correctly in the completed B3/B4 evidence?
6. Are QuickBooks account/vendor mappings and Bill/BillPayment/credit representations appropriate, with Increase retaining payment execution authority?

Pending evidence: B3 broader cases and exact postings; B4 locked-period/close/carryforward; C3 scheduling; C2 real human authorization and Increase sandbox workflow; C4 real QuickBooks OAuth and external record reconciliation. Update each entry with measured results, leaving all unsupported and unresolved cases visible.

## Review record — unfilled

- Reviewer identity and relevant experience: pending.
- Review scope/date and exact code, policy, fixture and evidence revisions: pending.
- Findings, decisions and required changes: pending.
- Accepted limitations and rationale: pending.
- Practitioner sign-off or rejection: pending.

A later practitioner must record their own judgment. Neither the expected outcome file nor an agent's passing test report fills this record.
