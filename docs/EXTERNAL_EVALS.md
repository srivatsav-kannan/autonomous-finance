# Eight-task external finance evaluation

This batch compares `full-team`, `generalist`, and `rules-only` on three APEX accounting tasks and five DABstep payment-analysis tasks. It supplements the synthetic-world eval (`npm run eval`) with real benchmark source files. Its scores are local development-subset scores, not official leaderboard results.

**Live comparison status: NOT_RUN.** The current adapter uses the repository's Anthropic runtime, while the user has only OpenAI keys available. OpenAI compatibility, model selection and explicit batch-budget approval are tracked in [#67](https://github.com/srivatsav-kannan/autonomous-finance/issues/67). The free milestone was verified with all eight rules baselines over three repeats (24/24 answers, no errors or abstentions), 15/15 DABstep passes, and real-backend integration tests with a model stub. APEX answers remain ungraded until an authorized compatible judge run; stub results are not model-performance evidence.

## Prepare and run

Run from the repository root with Node 22+ and Python 3.11+. Install the source-file readers once:

```bash
python3 -m venv var/benchmarks/.venv
var/benchmarks/.venv/bin/python -m pip install -r scripts/external-bench/requirements.txt
npm run bench:prepare
npm run bench:list
```

Preparation downloads pinned public data from Hugging Face. It extracts PDFs, spreadsheets, CSVs, JSON and documents into read-only SQLite evidence databases. The local venv is discovered automatically; `EXTERNAL_BENCH_PYTHON` can select another interpreter. No upstream executable scripts or containers are run.

First check the matrix, then run the free baseline:

```bash
npm run bench:run -- --dry-run
npm run bench:run -- --modes rules-only --repeats 1 --judge off
```

For the full comparison, configure Claude credentials in `.env.local`, start the existing Convex backend (`npm run backend`), and set matching `KERNEL_ADMIN_SECRET` values in the backend and `.env.local` as described in the README. The CLI uses `CONVEX_URL` or `VITE_CONVEX_URL`. Generalist and rules-only modes do not require the backend.

```bash
AGENT_FALLBACKS=0 npm run bench:run -- --repeats 3 --max-turns 12
```

This schedules **8 tasks × 3 modes × 3 repeats = 72 task runs**, plus APEX rubric-judge calls. It makes paid model calls. Both agent modes use the same `AGENT_MODEL`; the default comes from `src/agents/llm.ts`. `EXTERNAL_JUDGE_MODEL` can select a separate judge (otherwise it uses `AGENT_MODEL`). Disabling provider fallbacks keeps the configured model consistent across comparisons; the run config records whether fallbacks were enabled.

To check a smaller slice or defer judging:

```bash
npm run bench:run -- --tasks dabstep-1273 --modes generalist,rules-only --repeats 1
npm run bench:run -- --tasks apex-17 --modes full-team,generalist --repeats 1 --judge off
npm run bench:score -- --run var/evals/external/REPLACE_WITH_RUN_DIRECTORY
```

`--judge off` leaves answered APEX cases ungraded; DABstep scoring always runs. `bench:score` regrades saved answers without rerunning agents, checks the original data provenance, and updates the report. It replaces the current grades; original per-task trace files retain the grades from execution. `--run PATH` on `bench:run` chooses a new output directory and refuses to overwrite an existing one. `--data PATH` selects an alternate prepared fixture directory for every command.

## Cases and adapters

| Local ID | Workflow | Team specialist | Rules-only procedure |
|---|---|---|---|
| `apex-13` | AR reconciliation | Revenue accountant | Reconciles opening AR plus GL activity to Clio and aging by matter; checks draft adjustments and December write-down/write-off classification |
| `apex-17` | Payroll reconciliation | Payroll accountant | Recomputes employee stub/PTO accruals, allocates practice-group totals, and proposes balanced corrections against booked GL entries |
| `apex-30` | AR aging exposure | Revenue accountant | Recomputes aging from invoice due dates and outstanding balances |
| `dabstep-1273` | Average credit fee | Cash application | Filters fee rules and averages fees at the requested amount |
| `dabstep-1305` | Hospitality fee | Cash application | Applies account/MCC filters and averages fees |
| `dabstep-1681` | Applicable daily fee IDs | Cash application | Matches payments against fee conditions using monthly volume/fraud |
| `dabstep-1753` | Applicable monthly fee IDs | Cash application | Matches the requested month's payments against fee conditions |
| `dabstep-1871` | Fee-change delta | Cash application | Reprices payments matching the specified fee |

- **Full team:** the real `Team` scheduler and authenticated seats run a CFO dispatch → relevant specialist draft → controller verification workflow. Notes are recorded in observability and the final decision in Git memory. The task-specific adapter activates the relevant seats, not all twelve seats on every question. Each task/repeat receives a fresh kernel run and memory repository, with no emitted synthetic-world events.
- **Generalist:** one agent answers the same question with the same evidence tools. It has no specialist draft or review stage.
- **Rules-only:** deterministic, task-specific procedures cover all eight cases using the same evidence. They do not read gold answers or invoke models. Missing required evidence or inconsistent employee/opening-balance mappings produce explicit errors. These are hand-authored procedures for this fixed batch, not a general accounting engine.

The APEX 13/17 procedures live in `scripts/external-bench/apex_rules.py`. AR balances are rebuilt from the opening invoice allocation and GL postings, avoiding double-counted collections; Clio invoice equations and draft matter differences are checked separately. December adjustment totals use invoice dates, keeping annual write-offs separate. Draft and reviewer assertions never override the calculated source balances.

Payroll joins the compensation, payroll, stub and PTO records by employee. It derives the stub length from the last paid period, uses full-precision decimal arithmetic, applies the fixture's 2024 employer-tax rates/wage cap, and recalculates PTO using annual salary/260 with the five-day carryover cap. Practice-group totals follow the draft's scope: December Gusto gross plus stub wages/taxes/401(k) plus PTO. Regular-payroll employer costs are outside that subtotal. Proposed adjustments compare rounded expense-account targets with booked amounts and balance the change to accrued payroll; account-level posting rounding can differ by cents from full-precision aggregate totals. These policies and source schemas are specific to the pinned fixtures.

Both model modes receive the same source evidence, medium reasoning effort, and total model-turn cap. The specialist gets up to half the cap; the controller gets the remaining turns. This equalizes turn ceilings, not token usage or wall time. The report includes actual usage and cost estimates. Mode order rotates between repeats.

All three adapters produce answers. They do not post invoices, move money, or exercise the complete production transaction lifecycle. Keep using the synthetic-world eval to measure those controls and end-to-end bookkeeping.

## Scoring and outputs

- **DABstep:** complete numeric answers are compared at the requested decimal precision, with a `1e-12` tolerance floor for upstream floating-point artifacts. Integer ID sets must match exactly, independent of order; duplicates, extra IDs and prose fail. Each task earns 0 or 1.
- **APEX:** a separate judge evaluates the final answer against every published criterion and expert reference. Each criterion earns 0 or 1, and the case score is their mean. Judge outputs must cover every criterion exactly once. This is a local rubric implementation, not execution of the official Harbor verifier. Review borderline judgments before reporting results.
- Agent failures and abstentions earn zero and remain separately counted. Disabled or failed judging produces a null grade, never an inferred pass. A group mean is withheld if its grades are incomplete. All aggregate scores and paired deltas are withheld for interrupted executions.

Each run writes to `var/evals/external/<timestamp>-<id>/`:

| File | Contents |
|---|---|
| `config.json` | Task/mode matrix, repeat and turn budgets, configured models, evidence hashes and provenance hash |
| `results.json` | Answers, statuses, grades, usage, evidence-tool traces and kernel run IDs |
| `comparison.md`, `comparison.json` | Separate APEX/DABstep summaries and full-team-minus-baseline deltas paired by task/repeat |
| `traces/<task>-<mode>-<repeat>.json` | Original per-task result checkpoint |
| `complete.json` | End-of-run marker and expected/actual run counts |
| `rescoring.json` | Judge configuration and time of the latest rescore, when used |

Reports checkpoint after each task. Interrupted runs are inspectable but are not automatically resumed. Costs use the repository's fixed token-price estimate rather than provider billing, and judge costs are separate. Per-case wall time includes adapter setup/tool work and excludes judging.

The default three repeats are repeated model trials on fixed inputs. The provider does not expose a seed here; these are **not three data seeds**. The rules output is deterministic. This small, public development set is useful for regression checks; it is not evidence of held-out error-type generalization or statistical significance. Keep tuning and held-out testing separate when expanding it.

## Data boundaries and provenance

`benchmarks/finance-eight.json` pins task IDs and source revisions. Preparation writes:

- `public/…/evidence.sqlite`: source documents and queryable tables.
- `tasks.json`: prompts and public evidence locations/hashes, with no rubrics or reference answers.
- `private/gold.json`: grading criteria and expected answers, accessible only to the harness.
- `private/cache/`, `private/raw/`: cached downloads and source files.
- `provenance.json`: manifest, prompt/key hashes, and every source-download hash.

Agent tools only list/read public evidence and execute read-only SQLite queries. They have no general filesystem, shell, network, or gold-reading tool. SQLite denies writes, database attachment and extension loading; tool output and execution time are bounded. This is an application-level tool boundary, not an OS sandbox against someone with direct access to the repository.

XLSX extraction preserves worksheet row positions, cached cell values and formula text; it does not recalculate formulas. PDF extraction is text-only and rejects documents with no extractable text. These adaptations make the files usable by the repository's agents but differ from the original benchmark environments. The APEX batch includes the world's shared files/application data plus the task's supplied attachments. DABstep uses its published development questions and shared context.

## Verification

```bash
npm run typecheck
npm test
var/benchmarks/.venv/bin/python -m unittest discover -s scripts/external-bench -p 'test_*.py'
EXTERNAL_BENCH_INTEGRATION=1 npm exec vitest run src/evals/external/adapters.integration.test.ts
```

The opt-in integration test requires prepared fixtures and the backend. It uses a clearly labeled model stub to verify actual seat routing, evidence-tool access, Git decisions and repeat isolation without paid model calls. It creates isolated backend runs but does not write benchmark performance results. The unit tests cover scoring, malformed judges, incomplete reports, evidence access restrictions and source conversion. Independent APEX fixtures verify opening-balance allocation, double-counting detection, monthly classification, changed source values and cutoffs, tax/PTO caps, balanced corrections, and failures for incomplete or duplicate records. They require no downloaded data or answer keys.

## Attribution

Source data remains under its publishers' **CC BY 4.0** licenses:

- Mercor, [APEX-Accounting Harbor](https://huggingface.co/datasets/mercor/apex-accounting-harbor), revision `1662b7e4c3b04b8717f2f723df823e7b6cbe2118`; world 9, tasks 13, 17 and 30.
- Adyen, [DABstep](https://huggingface.co/datasets/adyen/DABstep), revision `0545553f02cedc323dee8658af62555852bc3b24`; development tasks 1273, 1305, 1681, 1753 and 1871.

This repository adds task selection, format conversion, adapters and local scoring. Generated fixtures, reference answers and run artifacts remain under ignored `var/`; they are not checked into Git.
