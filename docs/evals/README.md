# Evals folder

Results are in one place: [docs/RESULTS.md](../RESULTS.md). This folder holds how-to guides, raw data and older write-ups. Nothing here overrides RESULTS.md.

## How to run

| File | What |
|---|---|
| [external-benchmarks.md](external-benchmarks.md) | APEX, DABstep, Invoice Sandbox and FinBalance through our system: setup, budget gate, scoring, outputs |
| [close-correctness.md](close-correctness.md) | How the scorer checks books against an independent ledger, and the close gate on unread invoices |

`npm run evals` runs every free eval; `npm run evals -- --paid --budget-usd 15` adds the model evals. See the README's [setup and evals reference](../../README.md#setup-and-evals-reference).

## Raw data cited by RESULTS.md

| Path | What |
|---|---|
| [runs/final/](runs/final/) | The Oct 24–25 runs: four world seeds, the spreadsheet agent comparison, five external-benchmark batches |
| [runs/](runs/) | Earlier world runs with Claude, including the one-generalist baseline |
| [spreadsheet-vs-kernel.md](spreadsheet-vs-kernel.md), [.json](spreadsheet-vs-kernel.json) | The model-free spreadsheet vs kernel benchmark (`npm run eval:sheets-bench`) |
| [control-tests.json](control-tests.json) | The 20 control tests (`npm run controls`) |

## Model-only runs

These ran Claude Opus 5.5 through each benchmark's own harness, with none of this repository's agents or kernel. They measure the model, not this system, and RESULTS.md does not use them. Harness code is in `evals/external/`.

| Write-up | Harness |
|---|---|
| [finbalance.md](finbalance.md) | [evals/external/finbalance](../../evals/external/finbalance/README.md) |
| [invoice-sandbox.md](invoice-sandbox.md) | [evals/external/invoice-sandbox](../../evals/external/invoice-sandbox/README.md) |
| [dabstep.md](dabstep.md) | [evals/external/dabstep](../../evals/external/dabstep/README.md) |
| [vals-finance-agent.md](vals-finance-agent.md) | [evals/external/vals-finance-agent](../../evals/external/vals-finance-agent/README.md) |
