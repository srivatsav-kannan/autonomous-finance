# Finance eight-task comparison

Run progress: 11/16 task runs recorded. INCOMPLETE — aggregate scores and paired deltas are withheld.

Local development-subset evaluation, not an official APEX or DABstep leaderboard score. APEX uses mean rubric credit; DABstep uses exact sets and numeric tolerances. Results remain separate by benchmark.

Full-team uses the real seat scheduler, specialist → controller handoff, and Git decision records. External cases produce answers, not ledger mutations. Generalist has the same evidence tools and total turn cap. Rules-only has task-specific deterministic procedures for every case. Errors and abstentions receive zero.

| Mode | Benchmark | Runs | Answered | Graded | Mean score | Fully passed | Abstained | Errors | Agent turns | Agent $ est. | Judge $ est. | Seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| full-team | apex | 2 | 2 | 2 | pending | 2 | 0 | 0 | 21 | 0.7080 | 0.0842 | 86.8 |
| generalist | apex | 2 | 2 | 2 | pending | 1 | 0 | 0 | 11 | 0.3830 | 0.0802 | 45.9 |
| full-team | dabstep | 4 | 3 | 4 | pending | 3 | 0 | 1 | 45 | 0.4827 | 0.0000 | 97.7 |
| generalist | dabstep | 3 | 3 | 3 | pending | 2 | 0 | 0 | 21 | 0.2478 | 0.0000 | 44.0 |

Costs use the run's approved provider/model prices, not provider billing; judge usage is separate. Unverified requests retain their reserved cost ceiling; consult the budget ledger for uncertain charges. A pending mean means execution is incomplete or at least one grade is missing or failed. Fixed external tasks are repeated trials, not new synthetic-world seeds.

| Case | Mode | Repeat | Answer status | Score | Grade status | Detail |
|---|---|---:|---|---:|---|---|
| apex-13 | full-team | 1 | answered | 100.0% | graded |  |
| apex-13 | generalist | 1 | answered | 100.0% | graded |  |
| apex-30 | full-team | 1 | answered | 100.0% | graded |  |
| apex-30 | generalist | 1 | answered | 60.0% | graded |  |
| dabstep-1273 | full-team | 1 | answered | 100.0% | graded |  |
| dabstep-1273 | generalist | 1 | answered | 100.0% | graded |  |
| dabstep-1305 | full-team | 1 | answered | 100.0% | graded |  |
| dabstep-1305 | generalist | 1 | answered | 100.0% | graded |  |
| dabstep-1681 | full-team | 1 | answered | 100.0% | graded |  |
| dabstep-1681 | generalist | 1 | answered | 0.0% | graded |  |
| dabstep-1753 | full-team | 1 | error | 0.0% | graded | Agent loop hit its turn limit |

