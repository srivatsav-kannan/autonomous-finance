# Connected AP case — revised mockups for issue #97

This revision turns the [earlier page concepts](https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6396533726) into six views of one persistent AP case. The stable case header, source links, decisions, payment identity, and history remain connected. These are proposed desktop UI images, not screenshots of completed software or verification of a bank integration.

## The six frames

| Frame | View and purpose |
| --- | --- |
| [01-decision-inbox.png](01-decision-inbox.png) | Decision inbox and case preview. A concrete evidence gap has an owner and action; opening the case preserves the queue context. |
| [02-evidence-hold.png](02-evidence-hold.png) | The same case's Evidence & matching tab. Source invoice and exception lines are compared; absent receiving evidence remains unknown. Field confirmation is separate from bill approval. |
| [03-receipt-change-bill-review.png](03-receipt-change-bill-review.png) | The same case's Decisions tab after a receipt arrives. The proposed obligation and recognition entry appear beside the exact change and its actor. Payment remains unauthorized. |
| [04-payment-authorization.png](04-payment-authorization.png) | The Payment tab after bill approval and recognition. The authorized payer reviews a saved amount, funding account, beneficiary version, and execution condition. |
| [05-original-payment-recovery.png](05-original-payment-recovery.png) | The same Payment tab after an uncertain submission. The original operation and reservation are retained; replacement payment is unavailable. |
| [06-settlement-accounting-repair.png](06-settlement-accounting-repair.png) | The Reconciliation tab after bank settlement is confirmed. Missing settlement accounting is repaired without another transfer. Bank-to-payment matching is explicitly separate from AP-subledger-to-GL reconciliation. |

These views do not require six new top-level destinations. They use the existing console navigation and add case-local tabs and contextual history. The displayed signed-in roles illustrate separate actors; they are not a control for assuming a privileged role.

## Why these changes

- **Ramp: shorten the distance between evidence and action.** The supplied screenshots show task-specific actions, document comparison, and staged decisions. Its [programs](https://support.ramp.com/ramp-procurement-quick-start-guide/) connect intake questions to approval routing, while the [layout explanation](https://community.ramp.com/t/bill-pay-layout/1377) emphasizes consistency and navigation through multiple bills. This revision preserves queue position and keeps a source close to the field being checked. Our AP intake does not need a broad procurement catalog.
- **BILL: preserve responsibility across handoffs.** Its [bill-centered collaboration](https://www.bill.com/product/accounts-payable/) and [permissions and dual controls](https://www.bill.com/product/accounts-payable-controls) support keeping questions, evidence, and decisions together. Field review, bill approval, supplier-destination verification, and payment authorization remain distinct.
- **Tipalti: handle supplier readiness before payment and cross-system differences afterward.** Its [supplier management](https://marketing.tipalti.com/ap-automation/supplier-management/) and [payment reconciliation](https://marketing.tipalti.com/ap-automation/automated-payment-reconciliation/) inform a verified beneficiary version in the payment proposal and separate bank/accounting outcomes. A full supplier portal is deferred until needed.
- **Medius: send a discrepancy to the person who can resolve it.** Its [product walkthrough](https://www.medius.com/videos/product-tours/how-medius-replicates-ap-decision-making-to-deliver-truly-touchless-invoice-processing/) shows line-level evidence and routes delivery issues to receiving. The case shows exception lines first, retains the hold, and rechecks later evidence. Automatic short-paying is not adopted.
- **Vic.ai: make uncertain and stalled automation reviewable.** Its [approval approach](https://www.vic.ai/accounts-payable/approvals) and [product-team explanation](https://content.vic.ai/q1-2026-product-release-webinar) support explicit waiting states and contextual change history. Extraction confidence never substitutes for business evidence or payment authority.

These applications are design judgments grounded in documented product behavior, not claims about competitors' private design research or guarantees.

## Story and state assumptions

All views use synthetic Case AP-1001, Golden State Produce invoice INV-1001, USD 662.90. The four illustrative quantities are constructed from the repository's supplier catalog to equal that total: 6 Kale cases at 38.50, 4 Romaine at 42.75, 3 Avocado at 68.90, and 1 Tomato at 54.20. They are not asserted to be a recovered original source packet. Tax is zero in this illustrative fixture. Account 5000 is a scenario-specific proposed classification, not a general policy for all AP.

Receipt v1 adds a separate source and changes the evidence set from revision 1 to 2; Invoice v1 remains unchanged. The scenario follows a contract-and-receipt review without a supplied PO and does not claim three-way matching. The bill decision and accounting recognition occur between frames 3 and 4. P-1001 is the original payment proposal/operation; J-1001 is recognition; B-1001 is simulated bank evidence. Beneficiary ending 4417 and all verification outcomes are synthetic states. Frame 6 intentionally ends with accounting work still owed; its recorded AP balance is not a claim that the already-settled obligation should be paid again.

## Files and method

Generated and edited with the built-in `image_gen` tool. [prompts.json](prompts.json) contains the prompt set and [revisions.json](revisions.json) records review corrections. Existing mockups served as brand references and the new Evidence & matching frame served as the shared visual template. Images were reviewed for readable text, arithmetic, stable identity, authority boundaries, and continuity across states. The selected scenario and relative simulation day identify the sequence; these are not real calendar timestamps. An independent review prompted the shared scenario control and clearer action/history labels. No application code or responsive implementation is included.
