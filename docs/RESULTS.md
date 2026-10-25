# Results

Measured Oct 24–25, 2026. Agents: OpenAI `gpt-6.1-sol` at medium effort. APEX grader: `gpt-6-astra` at low effort. Total model spend for everything below: $10.59. Every row links to its raw output in [`docs/evals/runs/final/`](evals/runs/final/). Each eval was run once unless noted.

## Summary

| Eval | Us | Comparison |
|---|---|---|
| Same model, same 11 tasks: our kernel tools vs spreadsheet tools | 12 tool calls, 45 s, $0.12, 4 of 4 planted errors caught | 71 tool calls, 94 s, $0.48, 3 of 4 caught |
| 156 bookkeeping operations with 18 bad ones injected (no model) | All 18 stopped | 8 flagged after the fact, 10 never caught |
| Simulated Sweetgreen books, 4 seeds × 14 days | 13 of 13 errors caught on every seed, books correct, $0.04–0.05 per run | — |
| 15 public benchmark tasks (APEX, DABstep, Invoice Sandbox, FinBalance) | Our team: 93.3% mean, 14 of 15 correct, $4.06 | Same model alone: 84.0%, 12 of 15, $2.33 |
| Control tests | 20 of 20 hold | — |
| Payment survives a worker crash | 1 transfer, 1 journal entry | — |

## 1. Kernel vs spreadsheet

The question: does giving an agent finance tools built for agents beat giving it the spreadsheet a human team would use?

### With a model

Setup:
- The same model processes the same events: seed 7, 1 store, 2 days, 11 tasks and 4 planted errors (a CAM overcharge, a short shipment, a fraudulent bank change and an unexplained debit).
- One run uses our 4 typed tools: record bill, post entry, match bank transaction, flag exception.
- The other uses 4 spreadsheet tools on a real `.xlsx` ledger: read range, write range, find rows, recalculate.

Source: [sheets-agent-model-s7-mvncnkcd](evals/runs/final/sheets-agent-model-s7-mvncnkcd/report.json).

| | Kernel tools | Spreadsheet tools |
|---|---:|---:|
| Planted errors caught | 4 / 4 | 3 / 4 |
| Tool calls | 12 | 71 |
| Model turns | 22 | 50 |
| Wall time | 45 s | 94 s |
| Cost | $0.12 | $0.48 |
| Tasks that errored | 0 | 2 |
| Differences from the answer key | 6 | 13 |

Neither side finishes the books in this slice. Held bills need a controller, and this harness has none, so both columns show differences from the answer key.

### Without a model

Setup: 156 bookkeeping operations from seed 7 (3 stores, 14 days), applied to our kernel and to an `.xlsx` workbook with a ledger, an AP register, a bank sheet and a trial balance. Ten trials; medians shown.

Source: [spreadsheet-vs-kernel.md](evals/spreadsheet-vs-kernel.md).

| | Kernel | Workbook |
|---|---:|---:|
| Tool calls per operation | 1 | 5.8 |
| Time per operation, first tenth of the month | 0.12 ms | 0.20 ms |
| Time per operation, last tenth of the month | 0.12 ms | 2.23 ms |
| Bad operations stopped before they landed (of 18) | 15 | 0 |
| Bad operations caught afterwards | 3 | 8 |
| Bad operations never caught | 0 | 10 |

The kernel's 3 "caught afterwards" are 2 direct database edits detected by the hash chain and 1 retried posting absorbed as a replay. The workbook never caught:
- self-approval
- approval over the limit
- approval with an open exception
- posting to a closed period
- a duplicate invoice typed as "inv 1001"
- fractional cents
- bad line arithmetic
- a bill with no source document
- a retried posting
- an edited sales entry

The kernel time stays flat as the books grow; the workbook gets 11× slower over the month. Both paths produce identical books when no bad operations are injected.

## 2. Simulated company

The world:
- 3 stores, 14 days, 230 events and 64 vendor invoices, calibrated to Sweetgreen's FY2025 10-K.
- 21 of the 64 invoices are in formats the built-in parsers can't read.
- 13 planted errors and 3 legitimate look-alikes, with an answer key the agents never see.

Books are checked against an independent ledger on every account.

Source: [eval-openai-s*](evals/runs/final/).

| Seed | Errors caught | Look-alikes left alone | False alarms | Invoices read | Books | Model calls / tasks | Cost | Time |
|---|---|---|---:|---:|---|---:|---:|---:|
| 7 | 13 / 13 | 3 / 3 | 0 | 64 / 64 | correct | 11 / 218 | $0.05 | 82 s |
| 11 | 13 / 13 | 3 / 3 | 0 | 64 / 64 | correct | 11 / 218 | $0.05 | 79 s |
| 23 | 13 / 13 | 3 / 3 | 0 | 64 / 64 | correct | 11 / 218 | $0.04 | 71 s |
| 42 | 13 / 13 | 3 / 3 | 0 | 64 / 64 | correct | 11 / 218 | $0.05 | 77 s |

- The 11 model calls per run read the 21 unfamiliar invoices and write 2 parsers. After the controller merges the parsers, the remaining invoices in those formats are parsed by code.
- **Limits:** we built the world and the answer key, and seeds change amounts and stores but not the 13 error types.
- **Earlier comparison** (same world, seed 7, with Claude instead of OpenAI): our team cost $0.15 and took 87 s; one generalist agent with the same tools cost $7.80, took 42 min and caught 12 of 13 ([run](evals/runs/baseline-s7-mvm30964.md)).

## 3. Public benchmarks: our team vs the same model alone

Two modes, same model, same evidence tools, same 30-turn budget per task:
- **Team:** a specialist seat writes a draft. Our task scheduler hands it to the controller seat, which checks the draft against the source files and writes the final answer. The decision is committed to git memory. On FinBalance, the controller's journal entries are posted through our ledger and the balance sheet is read back from it.
- **Model alone:** the model answers directly.

Source: [external-*](evals/runs/final/).

| Task | Benchmark | Team | Model alone |
|---|---|---:|---:|
| AR reconciliation | APEX #13 | 100% | 100% |
| Payroll reconciliation | APEX #17 | 100% | 100% |
| AR aging exposure | APEX #30 | 100% | 60% |
| Average credit fee | DABstep 1273 | 100% | 100% |
| Hospitality fee | DABstep 1305 | 100% | 100% |
| Applicable daily fee IDs | DABstep 1681 | 100% | 0% |
| Applicable monthly fee IDs | DABstep 1753 | 100% | 100% |
| Fee-change delta | DABstep 1871 | 100% | 100% |
| Net spend for 18 customers | Invoice Sandbox | 18 / 18 | 18 / 18 |
| Balance sheet exact, 4 records | FinBalance | 4 / 4 | 4 / 4 |
| Contradiction code, 2 records | FinBalance | 1 / 2 | 1 / 2 |
| **Total** | | **93.3% mean, 14 of 15** | **84.0% mean, 12 of 15** |
| Cost / model turns / wall time | | $4.06 / 135 / 537 s | $2.33 / 74 / 292 s |

- **Where the team is better:** the controller's review fixed the two answers the model got wrong alone (APEX #30 and DABstep 1681).
- **What it costs:** the team uses about 1.7× the cost and 1.8× the time, because every answer is checked a second time.
- **Small sample:** 15 tasks, one run each.

The team's payroll and DABstep 1753 results come from a rerun after a harness fix ([#90](https://github.com/srivatsav-kannan/autonomous-finance/pull/90)). The specialist had been capped at half the turn budget, so it ran out of turns before writing a draft.

### Published scores on the same benchmarks

These aren't directly comparable: different task counts, runs per task and graders. We list them for scale.

| Benchmark | Published | Ours | Difference in setup |
|---|---|---|---|
| APEX-Accounting | Leaderboard: Gemini 4 Argon 71.5%, Fable 5.1 66.7%, Opus 5.5 65.5%, GPT-6 Astra 64.7%. Paper best: 56.4%. | 3 of 3 tasks at 100% | They run 100+ private tasks, averaged over 4 runs, with their grader. We ran 3 public tasks once, with our grader. |
| DABstep | Best validated entry: 87.5% easy, 89.95% hard | 5 of 5 | We used public dev tasks, not the 450 hidden ones |
| FinBalance | GPT-5: 46.5% balance sheets exact on the full split | 4 of 4 | Our records are difficulty levels 1–2 |
| Invoice Sandbox | Author's best: 18 of 18 | 18 of 18 | The benchmark is saturated |

Sources: [APEX leaderboard](https://www.mercor.com/apex/apex-accounting-leaderboard/), [APEX paper](https://www.alphaxiv.org/abs/2607.27189), [DABstep](https://huggingface.co/datasets/adyen/DABstep), [FinBalance](https://github.com/Devansh1105/finbalance), [Invoice Sandbox](https://github.com/ciru-ai/invoice-sandbox-benchmark).

## 4. Controls and payment recovery

**Control tests:** 20 of 20 hold ([control-tests.json](evals/control-tests.json)). Each case runs against the live kernel and git memory.

Refused (17):
- a bill with no source document
- two bills from one document
- cash posted with no bank transaction behind it
- the AP clerk posting cash
- approving your own payment
- paying a bill twice
- a payment of $50k or more without a human
- an agent hiring a control-role seat
- closing a month without a human signature
- editing bank details directly in memory
- merging your own change
- merging without authority
- booking a bank transaction twice
- booking it at a different amount
- re-booking it after a double reversal
- posting with a kernel-only source label
- answering your own question to the human

Also checked:
- the ledger hash chain verifies
- a real bank transaction books
- a cash entry can be reversed

**Payment recovery:** `npm run demo:local` runs on every pull request in CI and passed locally:
1. The bank accepts a $100 payment and the response is lost.
2. The dispatcher is killed.
3. After the lease expires, a new dispatcher resends the saved request with the same key and gets back the original transfer.

Result: one transfer, one posted debit, one journal entry. The month closes with the controller's and the human's signatures.

## What's real and what's simulated

- **Real:**
  - the kernel and its controls
  - the agents and their model calls
  - the public benchmark data
  - all timings and costs
- **Simulated:**
  - the company, its vendors, staff and bank feed
  - the bank used in the payment demo, a local simulator. The Increase sandbox adapter is contract-tested.

## Reproduce

`npm run evals -- --paid --budget-usd 15` reruns every eval above in one command (`npm run evals` alone runs the free part); the payment-recovery run is `npm run demo:local`. See the README's [Quick start](../README.md#quick-start).
