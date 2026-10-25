# External finance benchmark comparison

Run progress: 14/14 task runs recorded. Execution complete; grading coverage is shown below.

Local development-subset evaluation, not an official APEX or DABstep leaderboard score. APEX uses mean rubric credit; DABstep uses exact sets and numeric tolerances. Results remain separate by benchmark.

Invoice Sandbox uses the benchmark's official per-customer net-spend metric ($0.01 tolerance; score = share of customers exact). FinBalance uses its own BS_exact on standard records and exact contradiction-code match on negative controls; full-team FinBalance balance sheets come from booking the controller's entries through the ledger kernel.

Full-team uses the real seat scheduler, specialist → controller handoff, and Git decision records. Only FinBalance answers are booked to the kernel; other external cases produce answers, not ledger mutations. Generalist has the same evidence tools and total turn cap. Rules-only has task-specific deterministic procedures for every case. Errors and abstentions receive zero.

| Mode | Benchmark | Runs | Answered | Graded | Mean score | Fully passed | Abstained | Errors | Agent turns | Agent $ est. | Judge $ est. | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| full-team | finbalance | 6 | 6 | 6 | 83.3% | 5 | 0 | 0 | 13 | 0.1536 | 0.0000 | 59.5 |
| generalist | finbalance | 6 | 6 | 6 | 83.3% | 5 | 0 | 0 | 6 | 0.0701 | 0.0000 | 26.9 |
| full-team | invoice-sandbox | 1 | 1 | 1 | 100.0% | 1 | 0 | 0 | 20 | 1.6309 | 0.0000 | 131.2 |
| generalist | invoice-sandbox | 1 | 1 | 1 | 100.0% | 1 | 0 | 0 | 11 | 0.9338 | 0.0000 | 70.9 |

Costs use the run's approved provider/model prices, not provider billing; judge usage is separate. Unverified requests retain their reserved cost ceiling; consult the budget ledger for uncertain charges. A pending mean means execution is incomplete or at least one grade is missing or failed. Fixed external tasks are repeated trials, not new synthetic-world seeds.

| Case | Mode | Repeat | Answer status | Score | Grade status | Detail |
|---|---|---:|---|---:|---|---|
| finbalance-cov-pro-m1-0000 | full-team | 1 | answered | 100.0% | graded |  |
| finbalance-cov-pro-m1-0000 | generalist | 1 | answered | 100.0% | graded |  |
| finbalance-db-hea-q1-00196 | full-team | 1 | answered | 100.0% | graded |  |
| finbalance-db-hea-q1-00196 | generalist | 1 | answered | 100.0% | graded |  |
| finbalance-cov-pro-y1-0085 | full-team | 1 | answered | 100.0% | graded |  |
| finbalance-cov-pro-y1-0085 | generalist | 1 | answered | 100.0% | graded |  |
| finbalance-db-pro-m2-00004 | full-team | 1 | answered | 100.0% | graded |  |
| finbalance-db-pro-m2-00004 | generalist | 1 | answered | 100.0% | graded |  |
| finbalance-neg-bank-closing-01 | full-team | 1 | answered | 100.0% | graded |  |
| finbalance-neg-bank-closing-01 | generalist | 1 | answered | 100.0% | graded |  |
| finbalance-neg-invoice-total-01 | full-team | 1 | answered | 0.0% | graded |  |
| finbalance-neg-invoice-total-01 | generalist | 1 | answered | 0.0% | graded |  |
| invoice-sandbox-net-spend | full-team | 1 | answered | 100.0% | graded |  |
| invoice-sandbox-net-spend | generalist | 1 | answered | 100.0% | graded |  |

Paired deltas (full-team minus baseline; matched task and repeat):

- invoice-sandbox / generalist: 0.0 percentage points across 1 scored pairs.
- finbalance / generalist: 0.0 percentage points across 6 scored pairs.
