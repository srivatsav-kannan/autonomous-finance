# B4 V5 standalone receipt capacity correction

Spec: b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565.

Independent V5-F1 reproduced two actual public close flows that incorrectly permitted closing a retained two-unit standalone receipt after either a one-unit accrual or a fully reversed two-unit accrual. A historical accrual row was previously treated as full coverage.

The period projection now adds each standalone receipt's approved immutable SKU/unit/capacity to the same receipt coverage calculation used for case evidence. Coverage is exact invoiced units plus accrued units less reversal units whose journals exist as of the selected period end. Partial or fully reversed coverage retains the owned `received_not_invoiced` blocker; inconsistent reviewed capacities retain a conflict blocker. There is no inference that reversal constitutes disposition.

Validation in isolated HEAD archive with ONLY this fix and its regression file (no ongoing correction-allocation changes): 24/24 close tests passed, backend TypeScript passed. The three new tests include both independently reproduced public-close negatives and a successful fully accrued standalone receipt with an unpaid 7700-cent invoice carried forward. No provider/backend writes. Independent rerun remains verifier-owned.
