# PR #105: independent review of the AP business and accounting logic

**Claude independent model review. Not a human accountant or AP practitioner sign-off.** Scope: the USD implementation at `11244ee`. The probes were re-run on merged main (`b48885f`), and all 15 reproduce.

Method:
- Expected outcomes were derived from the original PDFs, `facts.json`, the events, `src/ap-system/policy.ts`, `business-policy.ts` and `src/core/accounts.ts` **before** reading the PR's expected postings ([notes](01-derived-expectations.md)).
- They were then compared against the PR's casebook and against actual behavior: `convex-test` and FakeBank in memory, with no providers and no model calls.

Probes are in [probes/](probes/). To run them from the repo root: `cd submission/review-105/probes && AGENT_LLM=off npx vitest run --config vitest.config.mjs --reporter=verbose <name>`, where name is `sod-remainder`, `golden`, `credits` or `creditdate`.

## Bottom line

The double-entry core held in every case run:
- Every journal balances.
- Settlement touches only AP (2000) and cash (1000), so payment never expenses a purchase again.
- The AP subledger matched the 2000 control account.
- Credits were consumed once, and zero or negative cash was rejected.
- Closed periods rejected postings.
- Duplicate or renamed deliveries created one obligation.
- Text on an invoice never changed where the payment went.

The problems are in **controls and missing AP lifecycle paths**, not arithmetic.

## Derived expectations vs actual

| Case | Expected (derived first) | Actual | Result |
|---|---|---|---|
| A. INV-1001 full path | Dr 5000 19,250 / 17,100 / 20,670 / 10,840, Cr 2000 67,860. Then Dr 2000, Cr 1000 67,860. AP 0 | Exactly that. One transfer to the configured beneficiary. Replay still left 2 journals | Match (control gap in F2) |
| B. INV-1001-QTY: 6 kale invoiced, 5 ordered and received | Hold, no short-pay, no journal | Held with `po_mismatch` and `receipt_mismatch`. Approving 71,710 denied as `policy_hold`. Approving 67,860 denied as `adjustment_authority_required` | Match |
| C. Partial acceptance 2/2/1/1 | Dr 5000 28,560, Cr 2000 28,560. Disputed 39,300 visible. Pay 10,000. AP 18,560 | Exactly that. GL 18,560 = subledger 18,560 | Match (F3, F6) |
| D. Credit with later payments | Recognize 7,700. Credit 1,200 once. Cash 3,800, then 2,700. Return and replacement. AP 0 | Arithmetic matches. The evidence uses the legacy, ungoverned `recordCredit`. The governed path rejects zero or negative cash and blocks credit reuse | Arithmetic matches |
| E. Duplicate or resend | One obligation | A renamed identical copy and a different-bytes copy with the same facts land on the same case. Changed facts under the same number need an explicit revision | Match (different number: F6) |
| F. Invoice shows new bank details | Ignore for destination, flag for verification | Paid the configured beneficiary. Not flagged | Partial (F7) |
| G. Close with open items | Accrual or explicit disposition. Unpaid AP carries forward | Blockers raised for the disputed portion, received-not-invoiced and the statement review. Lock, reopen and carryforward pass | Match on blocking (F9) |
| H. Recoverable tax 10% | Dr 5000 7,700, Dr 1180 770, Cr 2000 8,470. At 50%: 8,085 / 385 / 8,470 | Tests assert exactly that | Match |

All 58 entries in `PRACTITIONER-EXPECTED-POSTINGS.json` balance.

## Findings

### F1. High: payment release isn't separated from bill or supplier-bank approval, and has no amount limit
- **Problem:** any configured human can authorize a payment, including the person who approved the bill, the person who approved the supplier's new bank destination, and the callback verifier. No approval band applies to payment amounts. This is the classic control gap where an invoice or vendor-master approver can also release cash.
- **Evidence:**
  - `applyCommand.ts:98` blocks only the requesting agent seat.
  - `demoAuth.ts:55` gives every human the `human_cfo` role.
  - `apCasePayments.authorize` applies no group or limit.
  - Probe P1: the bill approver authorized the payment. Probes P2 and P2b: the governor and the verifier each authorized payment.
- **Reproduce:** `sod-remainder`.
- **Fix:** add payment groups and amount bands to `BusinessPolicy`. Reject an authorizer who appears in the bill's recognition votes, the current supplier revision's verification or approval, or the field review. Apply this in `approveAndQueueCommand` and in the payment-run authorize path.

### F2. High: in first-wave mode, one person can review, approve, pay and post a credit
- **Problem:** with no business policy active, `apCases.approveBill` (`apCases.ts:468`) checks only the case-creating agent. `demoPayments.recordCredit` (`demoPayments.ts:156-170`) lets one human post a credit with free-text evidence, no source document and no linked bill. The C01/I1 evidence used this mode: `verify-first-case.ts` uses one session for all steps.
- **Evidence:** Probe P4: one human did review, approval and authorization. Probe P5: credit evidence "x" posted Dr 2000 50,000, Cr 6200 50,000 with no bill.
- **Reproduce:** `sod-remainder`.
- **Fix:** require distinct people in first-wave mode. Disable `recordCredit` for AP-case runs, or route it through the linked credit workflow. Label the C01/I1 evidence as a single-operator run.

### F3. High: a disputed remainder can never become payable on its original invoice
- **Problem:** every path to recognize the rest of a partially accepted invoice is blocked:
  - a larger amount on the same case (`posted_correction_required`, `apBusiness.ts:160-165`)
  - an explicit revision (same denial, plus the bill is flagged)
  - a new case with the same number (`existing_obligation`)

  The only options left are an unpayable accrual or a disposition with no journal, which pushes users to re-key the invoice under another number (F6).
- **Evidence:** Probes P6 and P6b.
- **Reproduce:** `sod-remainder`.
- **Fix:** add a governed supplemental acceptance that posts only the difference. For I2: Dr 5000 39,300, Cr 2000 39,300 on the same bill. It consumes the remaining PO and receipt capacity, raises `approvedCents`, and links both approvals.

### F4. Medium: the field reviewer can also cast the recognition vote
- **Evidence:** Probe P3. The vote check at `apBusiness.ts:409` compares only agent seats.
- **Fix:** reject a vote from the seat on the current `fieldReviewId` decision.

### F5. Medium: payment can ignore an available credit, and an AP debit balance doesn't block close
- **Evidence:** Probe C1: a 3,850 credit was recognized, the full 7,700 was paid, and AP ended at -3,850 with no blocker beyond the statement review. Probe C3: same result when the credit comes after payment. `applyCommand.ts:58-75` never checks available credits.
- **Reproduce:** `credits`.
- **Fix:** require a reasoned acknowledgement for unused credits. Add a close blocker or disposition for any supplier with a debit balance.

### F6. Medium: a second invoice number for the same PO and delivery gets no duplicate warning
- **Evidence:** Probe G3. After INV-1001 was accepted 2/2/1/1, INV-1001-QTY (same PO and delivery) was accepted for the remaining units, 39,300. Receipt capacity still capped the total. But nothing flagged a possible duplicate, nothing linked it to the open dispute, and INV-1001 still shows 39,300 disputed. Duplicate checks key only on the invoice number.
- **Reproduce:** `golden -t G3`.
- **Fix:** a soft duplicate hold on supplier + PO + delivery, with a reviewed override. Link cases when one consumes capacity the other left in dispute.

### F7. Medium: changed bank details on an invoice are silently ignored
- **Problem:** prevention works, since the invoice can't change the destination. But a changed remit-to is a common fraud signal, and it isn't extracted at all. The fixture invoice says "Remit to: Pacific Western Bank acct ****4417", and the payment went to the configured beneficiary without comment.
- **Fix:** extract remit-to as evidence only, compare it with the masked master destination, and raise a vendor-verification exception on mismatch.

### F8. Medium: no internal way to void a bill recognized in error
- **Problem:** only a supplier credit note can reduce a recognized bill. `reverseEntry` is blocked for scoped AP runs (`ledger.ts:93`). To fix its own mistake, AP would have to fabricate a supplier credit.
- **Fix:** an approved reverse-recognition for unpaid, unreserved bills. It posts the exact mirror journal with `reversalOf` and releases the receipt consumptions.

### F9. Low: one approver can clear any disputed or received-not-invoiced amount, with no amount routing
- **Evidence:** a disposition carries `amountCents: 0` (`apClose.ts:68`) and goes to a single group (`apClose.ts:428-437`).
- **Fix:** price the disposition at units × agreement price, route it through amount bands, and require a stated basis.

### F10. Low: a credit can be dated before the original invoice and receipt
- **Evidence:** Probe CD1: a credit dated 2026-10-01 against an invoice and receipt from 2026-10-19 posted on 2026-10-01.
- **Reproduce:** `creditdate`.
- **Fix:** require the credit date to be on or after the original recognition and return-receipt dates.

### F11. Low: weaknesses in the PR's own evidence
- The C06 "credit consumed once" evidence uses the legacy single-human `recordCredit`.
- `business.test` "recognizes explicit partial quantity" checks only the journal count, not the lines.
- `verify-first-case.ts` compares per-account totals, so it would miss a wrong per-line split.
- The answer key was amended after the freeze to rename hold codes. Financial values are unchanged.

## Not verified

- **Real HTTP, browser and LlamaParse runs of I1 and I2.** The same facts were rebuilt in memory from the original PDF bytes.
- **Increase and QuickBooks.** Out of scope for this review.
- **C16–C20** (header tax, physical line identity, dimensions, contact replacement): checked only by arithmetic and their passing tests.
- **Practitioner judgments:** expense-on-receipt, the accrual basis, whether dispositions are acceptable, tax eligibility evidence, and reopen authority.

Test runs at `11244ee`: 64 files and 572 tests in `tests/ap-system` (QBO, browser and UI excluded) plus five root AP files. All pass.
