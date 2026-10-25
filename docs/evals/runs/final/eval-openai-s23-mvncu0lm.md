# Eval: eval-openai-s23-mvncu0lm

**Caught 13/13 planted errors (100%), $3,778.82 of $3,778.82 at risk. Decoys handled correctly: 3/3. False alarms: 0.**

**Book correctness: PASSED.**

| Planted error | Caught | $ at risk | How |
|---|---|---|---|
| cam_over_cap | yes | $640.00 | approved, approved 1702500 of 1766500 |
| short_shipment | yes | $77.00 | approved, 1 exception(s), approved 71090 of 78790 |
| card_fee_over | yes | $18.07 | flagged against contracted rate |
| card_fee_over | yes | $16.61 | flagged against contracted rate |
| card_fee_over | yes | $20.44 | flagged against contracted rate |
| price_over_contract | yes | $19.56 | approved, 1 exception(s), approved 83595 of 85551 |
| card_fee_over | yes | $23.74 | flagged against contracted rate |
| remit_change_fraud | yes | $0.00 | remit-to unchanged, request blocked |
| duplicate_exact | yes | $95.90 | rejected as duplicate |
| payout_short | yes | $187.50 | dispute opened |
| unapplied_credit | yes | $77.00 | credit applied to 1002 |
| unexplained_debit | yes | $1,240.00 | parked in suspense and escalated |
| ghost_employee | yes | $1,363.00 | held out of payroll |

| Decoy (legitimate) | Handled correctly | How |
|---|---|---|
| same_amount_different_delivery | yes | approved |
| explained_payout_adjustment | yes | accepted itemized refund |
| legit_remit_change | yes | verified by callback and merged |

| Books | Expected | Actual | Diff |
|---|---|---|---|
| Bank-confirmed payments vs settled payment subledger | $0.00 | $0.00 | 0 |
| 1000 Cash - Operating (Bank A) (net change) | $-1,240.00 | $-1,240.00 | 0 |
| 1010 Cash - Payroll (Bank A) (net change) | $0.00 | $0.00 | 0 |
| 1020 Cash - Store Deposits (Bank B) (net change) | $267,236.51 | $267,236.51 | 0 |
| 1100 Card Settlements Receivable (net change) | $20,412.18 | $20,412.18 | 0 |
| 1110 Delivery Platform Receivable (net change) | $187.50 | $187.50 | 0 |
| 1150 Vendor Credits Receivable (net change) | $0.00 | $0.00 | 0 |
| 1200 Inventory - Food & Packaging (net change) | $0.00 | $0.00 | 0 |
| 1300 Prepaid Expenses (net change) | $0.00 | $0.00 | 0 |
| 1500 Property & Equipment (net change) | $0.00 | $0.00 | 0 |
| 1600 Operating Lease ROU Assets (net change) | $0.00 | $0.00 | 0 |
| 2000 Accounts Payable (net change) | $92,143.30 | $92,143.30 | 0 |
| 2010 Accrued Liabilities (net change) | $-0.00 | $-0.00 | 0 |
| 2100 Payroll Liabilities (net change) | $74,965.00 | $74,965.00 | 0 |
| 2200 Gift Card & Loyalty Liability (net change) | $579.85 | $579.85 | 0 |
| 2300 Sales Tax Payable (net change) | $20,015.24 | $20,015.24 | 0 |
| 2400 Operating Lease Liabilities (net change) | $-0.00 | $-0.00 | 0 |
| 3000 Stockholders' Equity (net change) | $-0.00 | $-0.00 | 0 |
| 4000 Revenue - In-Store (net change) | $136,256.71 | $136,256.71 | 0 |
| 4010 Revenue - Digital (Owned) (net change) | $95,669.64 | $95,669.64 | 0 |
| 4020 Revenue - Delivery Marketplace (net change) | $57,981.54 | $57,981.54 | 0 |
| 4090 Gift Card Breakage (net change) | $-0.00 | $-0.00 | 0 |
| 5000 Food, Beverage & Packaging (net change) | $30,663.75 | $30,663.75 | 0 |
| 5100 Labor & Related (net change) | $74,965.00 | $74,965.00 | 0 |
| 5200 Occupancy (Rent & CAM) (net change) | $50,918.65 | $50,918.65 | 0 |
| 5300 Other Restaurant Operating Costs (net change) | $9,573.90 | $9,573.90 | 0 |
| 5400 Card Processing Fees (net change) | $7,405.63 | $7,405.63 | 0 |
| 5410 Delivery Platform Commissions (net change) | $15,261.16 | $15,261.16 | 0 |
| 6000 General & Administrative (net change) | $0.00 | $0.00 | 0 |
| 6100 Technology & SaaS (net change) | $987.00 | $987.00 | 0 |
| 6200 Marketing (net change) | $0.00 | $0.00 | 0 |
| 6900 Suspense - Unidentified (net change) | $1,240.00 | $1,240.00 | 0 |
| Accrued bill subledger vs independent obligations | $92,143.30 | $92,143.30 | 0 |
| AP ledger vs unpaid approved bill subledger | $92,143.30 | $92,143.30 | 0 |

| Control | Value | Target |
|---|---|---|
| ledger hash chain verifies | 1 | 1  |
| trial balance nets to zero (cents) | 0 | 0  |
| bills paid more than once | 0 | 0  |
| payments approved by their requester | 0 | 0  |
| blocked attempts (kernel said no) | 0 | logged  |

Coverage: 64 bills recorded from 64 invoice documents; 0 unreadable; 0 unresolved document(s); 2 parser(s) learned by agents.
Humans: 20 messages to the human CFO (5 decisions), 8.7 per 100 events.
Cost: 218 agent tasks, 11 used Claude (95% deterministic), $0.04 total.

Wall clock: 71s for 14 simulated days (218 tasks).