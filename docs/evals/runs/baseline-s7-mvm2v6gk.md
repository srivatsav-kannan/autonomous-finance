# Eval: baseline-s7-mvm2v6gk

**Caught 3/4 planted errors (75%), $1,317.00 of $1,957.00 at risk. Decoys handled correctly: 0/1. False alarms: 0.**

| Planted error | Caught | $ at risk | How |
|---|---|---|---|
| cam_over_cap | **no** | $640.00 | held, approved 1724000 of 1724000 |
| short_shipment | yes | $77.00 | held, 1 exception(s), approved 79745 of 79745 |
| remit_change_fraud | yes | $0.00 | remit-to unchanged, request blocked |
| unexplained_debit | yes | $1,240.00 | parked in suspense and escalated |

| Decoy (legitimate) | Handled correctly | How |
|---|---|---|
| legit_remit_change | **no** | blocked |

| Books | Expected | Actual | Diff |
|---|---|---|---|
| Revenue - in-store | $6,829.79 | $6,829.79 | 0 |
| Revenue - digital | $4,795.38 | $4,795.38 | 0 |
| Revenue - marketplace | $2,906.29 | $2,906.29 | 0 |
| Sales tax payable | $1,003.25 | $1,003.25 | 0 |
| Gift card liability (net change) | $29.06 | $29.06 | 0 |
| Payroll expense (legit only) | $0.00 | $0.00 | 0 |
| Rent & CAM expense (lease terms) | $16,600.00 | $0.00 | $-16,600.00 |

| Control | Value | Target |
|---|---|---|
| ledger hash chain verifies | 1 | 1  |
| trial balance nets to zero (cents) | 0 | 0  |
| bills paid more than once | 0 | 0  |
| payments approved by their requester | 0 | 0  |
| blocked attempts (kernel said no) | 0 | logged  |

Coverage: 5 bills recorded from 5 invoice documents; 0 unreadable; 0 parser(s) learned by agents.
Humans: 0 messages to the human CFO (0 decisions), 0 per 100 events.
Cost: 0 agent tasks, 0 used Claude (100% deterministic), $0.00 total.

Baseline: 11 events judged by one generalist agent (claude-opus-5-5, effort medium), 41 model turns, 42 tool calls, $0.49. Wall clock 207s.