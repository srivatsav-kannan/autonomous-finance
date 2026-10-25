# Results

Every number here was measured on Oct 24, 2026 and comes from a file in this repo. Model calls used OpenAI `gpt-6.1-sol` at medium effort; the APEX answers were graded by `gpt-6-astra` at low effort. Total spend for this batch was **$9.48**: $8.63 on the outside benchmarks and $0.85 on agent runs. Small samples are labeled as such.

## The short version

| Claim | Evidence | How strong |
|---|---|---|
| **An agent works faster, cheaper and more safely on our kernel than on spreadsheets** | Same model, same 2 days of events: **12 vs 71 tool calls, 45 s vs 94 s, $0.12 vs $0.48, 4/4 vs 3/4 planted errors caught**. On 156 operations without a model: **1 vs about 6 tool calls per operation, and 18/18 vs 8/18 bad operations stopped**. | **Strong.** Measured directly, same inputs on both sides. |
| **It runs a company's books correctly, for cents** | Simulated Sweetgreen, 4 seeds × 14 days: **13/13 planted errors caught on every seed, 3/3 decoys, 0 false alarms, books correct on every account, $0.04–0.05 and about 80 s per run** | **Strong** on our world. We built the world and the answer key. |
| **Its controls hold** | **20/20** scripted control tests: 16 bad actions refused, the ledger hash chain verifies, and 3 legitimate paths still work | **Strong.** Deterministic. |
| **Money moves exactly once, even through failures** | The bank accepts a payment, the worker is killed and replaced, and the books still show exactly one transfer and one journal entry. It passed locally and runs in CI on every pull request. | **Strong.** |
| **Our team is at least as accurate as the model alone on outside benchmarks** | 15 public tasks: **86.7% vs 84.0% mean, 13 vs 12 fully correct**. The team costs about 1.75× as much and takes about 1.65× as long. | **Weak and small.** One run of each, roughly a tie. Details are below. |

Our edge is in the system, not in a model being smarter. Deterministic code handles about 95% of the work. Every write goes through checks the model can't skip. And the tools are built for agents, not for people. The outside benchmarks are question-answering tasks, so they mostly measure the model. They show that our team structure doesn't cost accuracy, and the spreadsheet and simulated-world evals show where we pull ahead.

## 1. Agent-native kernel vs spreadsheet tools

Source: [docs/evals/spreadsheet-vs-kernel.md](evals/spreadsheet-vs-kernel.md) and [runs/final/sheets-agent-model-s7-mvncnkcd](evals/runs/final/sheets-agent-model-s7-mvncnkcd/report.json).

**With a model in the loop.** The same model (`gpt-6.1-sol`) processes the same events: 1 store, 2 days, 11 tasks and 4 planted errors. It works either through our 4 typed kernel tools or through 4 spreadsheet tools (read range, write range, find rows, recalculate) on a real `.xlsx` ledger.

| | Kernel tools | Spreadsheet tools |
|---|---|---|
| Wall time | **45 s** | 94 s |
| Tool calls | **12** | 71 |
| Model turns | **22** | 50 |
| Cost | **$0.12** | $0.48 |
| Planted errors caught | **4/4** | 3/4 |
| Tasks that errored | **0** | 2 |
| Bookkeeping differences from the answer key | 6 | 13 |

Neither side finished the books, because this slice has no controller to approve held bills. That's why the kernel side still shows 6 differences.

**Without a model, as a pure timing and safety test.** 156 bookkeeping operations from seed 7 (3 stores, 14 days), applied through the kernel and through a workbook with formulas. Ten trials, median shown.

| | Kernel | Workbook, in memory | Workbook, saved each time |
|---|---|---|---|
| Time per operation | 0.12 ms | 1.12 ms | 7.67 ms |
| Early vs late in the month | 0.12 → 0.12 ms | 0.20 → 2.23 ms | 2.62 → 13.3 ms |
| Tool calls per operation | **1** | 5.78 | 5.78 |
| 18 injected bad operations | **18 stopped** (15 refused, 2 caught by the hash chain, 1 absorbed as a replay) | **all 18 accepted; 8 flagged afterwards, 10 never caught** | same |

The spreadsheet missed self-approval, approval over the limit, posting to a closed period, a duplicate invoice retyped as "inv 1001", fractional cents, bad line arithmetic and a bill with no document. The raw-speed gap is about 10× on compute. The bigger gaps are in tool calls and in safety. We don't quote the "65×" figure, which compares a workbook saved after every operation against a kernel that wrote nothing durable.

## 2. Our system on the simulated company

Source: [runs/final/eval-openai-s*.md](evals/runs/final/). The world is calibrated to Sweetgreen's FY2025 SEC filing. Each run is 3 stores, 14 days, 64 vendor invoices (21 of them in formats the built-in parsers can't read), 13 planted errors and 3 legitimate look-alikes. The answer key is never shown to the agents.

| Seed | Errors caught | Decoys handled | False alarms | Invoices read | Books, all accounts | Model calls / tasks | Cost | Time |
|---|---|---|---|---|---|---|---|---|
| 7 | 13/13 ($3,774.33) | 3/3 | 0 | 64/64 | passed | 11 / 218 | $0.05 | 82 s |
| 11 | 13/13 ($3,986.24) | 3/3 | 0 | 64/64 | passed | 11 / 218 | $0.05 | 79 s |
| 23 | 13/13 ($3,778.82) | 3/3 | 0 | 64/64 | passed | 11 / 218 | $0.04 | 71 s |
| 42 | 13/13 ($3,900.09) | 3/3 | 0 | 64/64 | passed | 11 / 218 | $0.05 | 77 s |

On every seed the agents wrote 2 parsers for the unfamiliar formats, and the controller reviewed and merged them.

Earlier comparison on this same world, run with Claude: our system cost **$0.15 and took 87 s**. One generalist agent given the same tools cost **$7.80 and took 42 minutes**, and caught 12 of 13. Source: [runs/baseline-s7-mvm30964.md](evals/runs/baseline-s7-mvm30964.md). This was one seed. Note also that one of its decoy misses was a tooling gap in the baseline, not a judgment error.

Weaknesses:
- We wrote the world and the answer key.
- Seeds change amounts and which store gets each error, but not the error types.

## 3. Controls and recovery

- **Control tests: 20/20.** Source: [docs/evals/control-tests.json](evals/control-tests.json), run `controls-mvnc9ak5`.
  - **Must refuse:**
    - a bill with no document, or two bills from one document
    - cash with no bank evidence, or the AP clerk posting cash
    - self-approval, paying a bill twice, or $50k or more without a human
    - an agent hiring a control seat, or closing a month without a human
    - a direct bank-detail edit, merging your own change, or an unauthorized merge
    - booking a bank transaction twice, or at the wrong amount
    - re-booking a bank transaction after a double reversal
    - posting with a kernel-only source label
    - answering your own question to the human
  - **Hash chain:** the ledger chain verifies.
  - **Still allowed:**
    - a real bank booking
    - correcting by reversal
    - re-booking after a single reversal
- **Exactly-once payment** (`npm run demo:local`, and the CI recovery job on every pull request):
  - the bank accepts the payment and the response is lost
  - the dispatcher is SIGKILLed
  - after the lease expires, the replacement reuses the saved command and key
  - a same-key retry returns the original transfer
  - result: one posted debit, linked once, with the month closed by two signatures

## 4. Outside benchmarks: our team vs the same model alone

Source: [runs/final/external-*](evals/runs/final/).
- **Team mode:** the full team runs inside our kernel. A specialist seat drafts, our scheduler hands it to the controller, the controller checks it against the sources independently, and the decision is committed to git memory. On FinBalance, the controller's entries are posted through our ledger and the balance sheet is read from the kernel.
- **Model alone:** the same model with the same evidence tools and turn budget.
- One run of each.

| Task | What it is | Team | Model alone |
|---|---|---|---|
| apex-13 | AR reconciliation | 100% | 100% |
| apex-30 | AR aging exposure | **100%** | 60% |
| apex-17 | Payroll reconciliation | ran out of turns (30) | **100%** |
| dabstep-1273 | Average credit fee | 100% | 100% |
| dabstep-1305 | Hospitality fee | 100% | 100% |
| dabstep-1681 | Applicable daily fee IDs | **100%** | 0% |
| dabstep-1753 | Applicable monthly fee IDs | 100% (needed 30 turns) | 100% |
| dabstep-1871 | Fee-change delta | 100% | 100% |
| invoice-sandbox | 18 customers' net spend | 100% (18/18) | 100% (18/18) |
| finbalance × 4 | Balance sheet exact (levels 1–2) | 4/4 | 4/4 |
| finbalance contradiction × 2 | Inconsistency code exact | 1/2 | 1/2 |
| **Total (15 tasks)** | | **86.7% mean, 13 fully correct** | **84.0% mean, 12 fully correct** |
| Cost / turns / time | | $4.07 / 137 / 482 s | $2.33 / 74 / 292 s |

Reading it honestly:
- **Where the team wins:** the controller's independent check fixed two answers the model got wrong alone (AR aging, and a DABstep fee-ID set).
- **Where it loses:** it ran out of turns on payroll, because the second pass spends turns.
- **Cost:** it costs about 1.75× as much.
- **Overall:** with 15 tasks and one run each, this is a tie within noise. It shows that review doesn't hurt accuracy, and that it sometimes catches a wrong answer.

### Published reference points (not directly comparable)

| Benchmark | Published | Ours | Why not comparable |
|---|---|---|---|
| APEX-Accounting (Mercor with Ramp) | Leaderboard: Gemini 4 Argon (High) 71.5%, Fable 5.1 (Max) 66.7%, Opus 5.5 (Max) 65.5%, GPT-6 Astra (Max) 64.7%. The paper's best is 56.4%. | 3 public tasks: 100%, 100%, and one out of turns | They use 100–160 private tasks, averaged over k=4 runs, with their judge. We ran 3 public tasks once, with our own judge. |
| DABstep (Adyen) | Top validated entry 87.5% easy and 89.95% hard, on 450 hidden tasks | 5 dev tasks: 5/5 for the team, 4/5 for the model alone | Public dev tasks only, not the hidden set |
| FinBalance (EMNLP 2026) | GPT-5 at 46.5% balance-sheet exact on the full split. Claude Opus 5.5 scored 69.2% on 120 records in our earlier run. | 4/4 standard records and 1/2 contradictions, in both modes | Our records are low difficulty (levels 1–2) |
| Invoice Sandbox (ciru-ai) | The author's best run is 18/18 | 18/18 in both modes | The benchmark is saturated |

Sources: [Mercor APEX leaderboard](https://www.mercor.com/apex/apex-accounting-leaderboard/), [APEX-Accounting paper](https://www.alphaxiv.org/abs/2607.27189), [Mercor announcement](https://www.mercor.com/blog/introducing-the-ai-productivity-index-for-accounting/). Earlier per-benchmark write-ups are in [docs/evals/README.md](evals/README.md).

## Real vs simulated

- **Real:**
  - the kernel and its controls
  - the agents and the model calls
  - the public benchmark data
  - every timing and cost measurement
  - the Increase sandbox adapter (contract-tested)
- **Simulated:**
  - the company, its vendors, staff and bank feed (Sweetgreen-calibrated)
  - the bank used in the demo (a persistent local simulator)

## Reproduce

```bash
npm run controls
npm run eval -- --seed 7 --label openai                               # simulated company
npm run eval:sheets-bench                                             # kernel vs spreadsheet, no model
npm run eval:sheets-agent -- --confirm-usd 2.5                        # same, with a model
npm run bench:prepare && npm run bench:prepare -- --batch extra
npm run bench:run -- --modes full-team,generalist --repeats 1 --model-policy <approved policy>   # see docs/EXTERNAL_EVALS.md
```
