# Finance eight-task comparison

Run progress: 5/6 task runs recorded. INCOMPLETE — aggregate scores and paired deltas are withheld.

Local development-subset evaluation, not an official APEX or DABstep leaderboard score. APEX uses mean rubric credit; DABstep uses exact sets and numeric tolerances. Results remain separate by benchmark.

Full-team uses the real seat scheduler, specialist → controller handoff, and Git decision records. External cases produce answers, not ledger mutations. Generalist has the same evidence tools and total turn cap. Rules-only has task-specific deterministic procedures for every case. Errors and abstentions receive zero.

| Mode | Benchmark | Runs | Answered | Graded | Mean score | Fully passed | Abstained | Errors | Agent turns | Agent $ est. | Judge $ est. | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| full-team | dabstep | 2 | 2 | 2 | pending | 2 | 0 | 0 | 33 | 0.4098 | 0.0000 | 76.4 |
| generalist | dabstep | 2 | 2 | 2 | pending | 2 | 0 | 0 | 16 | 0.2007 | 0.0000 | 37.1 |
| full-team | apex | 1 | 0 | 1 | pending | 0 | 0 | 1 | 15 | 0.7945 | 0.0000 | 51.4 |

Costs use the run's approved provider/model prices, not provider billing; judge usage is separate. Unverified requests retain their reserved cost ceiling; consult the budget ledger for uncertain charges. A pending mean means execution is incomplete or at least one grade is missing or failed. Fixed external tasks are repeated trials, not new synthetic-world seeds.

| Case | Mode | Repeat | Answer status | Score | Grade status | Detail |
|---|---|---:|---|---:|---|---|
| dabstep-1871 | full-team | 1 | answered | 100.0% | graded |  |
| dabstep-1871 | generalist | 1 | answered | 100.0% | graded |  |
| dabstep-1753 | full-team | 1 | answered | 100.0% | graded |  |
| dabstep-1753 | generalist | 1 | answered | 100.0% | graded |  |
| apex-17 | full-team | 1 | error | 0.0% | graded | Agent loop hit its turn limit |

