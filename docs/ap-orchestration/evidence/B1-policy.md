# B1: Golden State AP policy, golden-state-ap-v1

This is an explicit synthetic company policy implemented under ap-evidence-v1. It is policy-derived engineering behavior, not AP practitioner approval. Source baseline: d24f22007a36722831a521d7387ee8f5c92c5803. Reviewed issue SHA256: b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565.

## Enforced decision table

| Trigger | Result / owner | Permitted route |
| --- | --- | --- |
| Missing/incomplete/conflicting invoice content or failed pages | Hold / AP clerk | Preserve the nullable candidate and original; submit a source/evidence revision, then fresh field review |
| Precise geometry missing, content supported | Field-review hold / AP clerk | Authenticated human explicitly reviews every candidate field against the version-correct original; business checks still apply |
| Derived geometry without hashed raw/token/config artifacts or local-OCR raster/traineddata | Hold / AP clerk | Repair provenance; a visible rectangle never grants authority |
| Unverified supplier, unknown SKU or unit | Hold / vendor-verification or purchasing owner | Independent approved master-data/evidence correction; invoice text cannot change beneficiary |
| PO/receipt absent, ambiguous, wrong source/supplier/line or insufficient quantity | Hold / purchasing or receiving owner | New supporting evidence revision; no invented receipt and no calculated short-pay |
| Any unexplained contract/PO unit-price variance | Hold / purchasing owner | Corrected invoice or separately authorized variance workflow; zero auto-tolerance in this first policy |
| Wrong totals, missing allocations, unknown dimensions/account treatment or wrong accounting period | Hold / controller | Correct supported allocation; exact decimal quantity × cents with half-up once per line |
| Reuse of a receipt line already supporting another recognized obligation | Hold / controller | Explicit partial allocation/correction workflow; first wave reserves the full received line |
| Lower accepted total without corresponding authorized adjustment allocations | Reject / controller | First wave approves full original amount only; expanded adjustment workflow belongs to B3 |
| Source evidence changes after review | Invalidate field/business review | Preserve previous revisions and decisions; re-review exact current snapshot |
| Source evidence changes after recognized bill/payment request | Hold linked bill | Cancel provably unsent payment; retain possible-dispatched request and reservations until bank outcome resolves; use controlled accounting correction |

The first packet posts reviewed food-cost allocations to account 5000 and AP to account 2000. It does not infer inventory/fixed-asset/prepayment coding. Those supported cases and credits remain B3. Recognition leaves payment authorization not_requested; payment remains a separate existing engine operation. Internal journals do not count as ERP synchronization.

## Public policy inputs

Virginia Tech describes owned written approval and retained documentation for price variances, with correction/credit routes when the variance is not accepted. We adopt the ownership and retained-evidence principle, not its university thresholds. [Virginia Tech Procedure 20310f](https://www.controller.vt.edu/accountspayable/20310f.html), read 2026-10-25.

Upper Iowa requires review of approvals/coding/support, return of incomplete requests to the responsible budget officer, independent verification of changed vendor banking information and separate wire/ACH preparers and approvers. We retain those control principles; our roles, exact thresholds and timing remain explicit company policy. [Upper Iowa BO-214, effective 2024-05-29](https://uiu.edu/wp-content/uploads/BO-214-Accounts-Payable-Payment-Policy-5-29-24.pdf), read 2026-10-25.

## Implementation and test scope

`src/ap-system/policy.ts` and `accounting.ts` contain deterministic matching/arithmetic. `convex/apCases.ts` enforces authenticated source-bound decisions and atomic bill/journal creation. Legacy aggregate acceptance and flag-clearing APIs deny AP-linked bills. Legacy AP handler now holds missing delivery references and unknown SKUs; its controller requires explicit human resolution for price/quantity discrepancies and never says a note was sent to the vendor.

B unit-test packets use synthetic text bytes with a PDF MIME label solely to exercise the backend contract. They are explicitly not PDF/parser fidelity evidence. A1/A2 provide actual generated PDFs and provider parsing; V1 independently reviews those originals and expected outcomes. These tests do not establish I1, V2, external provider or practitioner acceptance.
