# Eval: baseline-s7-mvm30964

**Caught 12/13 planted errors (92%), $3,634.63 of $3,774.33 at risk. Decoys handled correctly: 2/3. False alarms: 0.**

| Planted error | Caught | $ at risk | How |
|---|---|---|---|
| cam_over_cap | yes | $640.00 | approved, approved 1702500 of 1766500 |
| short_shipment | yes | $77.00 | approved, 1 exception(s), approved 76320 of 84020 |
| card_fee_over | yes | $16.00 | flagged against contracted rate |
| card_fee_over | yes | $14.71 | flagged against contracted rate |
| card_fee_over | yes | $22.95 | flagged against contracted rate |
| price_over_contract | yes | $19.56 | approved, 2 exception(s), approved 84870 of 94526 |
| card_fee_over | yes | $23.91 | flagged against contracted rate |
| remit_change_fraud | yes | $0.00 | remit-to unchanged, request blocked |
| duplicate_exact | **no** | $139.70 | never processed |
| payout_short | yes | $187.50 | dispute opened |
| unapplied_credit | yes | $77.00 | credit applied to INV-1004 |
| unexplained_debit | yes | $1,240.00 | parked in suspense and escalated |
| ghost_employee | yes | $1,316.00 | held out of payroll |

| Decoy (legitimate) | Handled correctly | How |
|---|---|---|
| same_amount_different_delivery | yes | approved |
| explained_payout_adjustment | yes | accepted itemized refund |
| legit_remit_change | **no** | blocked |

| Books | Expected | Actual | Diff |
|---|---|---|---|
| Revenue - in-store | $137,529.15 | $137,529.15 | 0 |
| Revenue - digital | $96,563.04 | $96,563.04 | 0 |
| Revenue - marketplace | $58,523.02 | $58,523.02 | 0 |
| Sales tax payable | $20,202.12 | $20,202.12 | 0 |
| Gift card liability (net change) | $585.19 | $585.19 | 0 |
| Payroll expense (legit only) | $75,082.50 | $24,158.00 | $-50,924.50 |
| Rent & CAM expense (lease terms) | $50,949.23 | $50,949.23 | 0 |

| Control | Value | Target |
|---|---|---|
| ledger hash chain verifies | 1 | 1  |
| trial balance nets to zero (cents) | 0 | 0  |
| bills paid more than once | 0 | 0  |
| payments approved by their requester | 0 | 0  |
| blocked attempts (kernel said no) | 3 | logged  |

Coverage: 64 bills recorded from 64 invoice documents; 0 unreadable; 0 parser(s) learned by agents.
Humans: 0 messages to the human CFO (0 decisions), 0 per 100 events.
Cost: 0 agent tasks, 0 used Claude (100% deterministic), $0.00 total.

Baseline: 160 events judged by one generalist agent (claude-opus-5-5, effort medium), 581 model turns, 636 tool calls, $7.80. Wall clock 2522s.