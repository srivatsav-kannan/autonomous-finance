# Eight-task external finance evaluation

This batch compares `full-team`, `generalist`, and `rules-only` on three APEX accounting tasks and five DABstep payment-analysis tasks. It supplements the synthetic-world eval (`npm run eval`) with real benchmark source files. Its scores are local development-subset scores, not official leaderboard results.

**Live comparison status: NOT_RUN.** OpenAI tool calling and structured APEX judging are implemented, with mocked transport coverage for OpenAI and Anthropic. Paid execution is disabled by the checked-in `benchmarks/external-models.json` (`approval: null`); having API keys does not enable it. The recommended models and prices are configured. Explicit budget approval and the first live smoke/matrix remain tracked in [#67](https://github.com/srivatsav-kannan/autonomous-finance/issues/67). The free milestone covers all eight rules baselines over three repeats (24/24 answers, no errors or abstentions), 15/15 DABstep passes, and real-backend integration tests using model stubs. APEX rules answers remain ungraded until an authorized judge run; mock results are not model-performance evidence.

## Prepare and run

Run from the repository root with Node 24.18+ and Python 3.11+. Install the source-file readers once:

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

## Provider configuration and budget gate

The benchmark uses the reusable `src/agents/model-client.ts` interface for specialist/controller, generalist, and judge. It supports first-party OpenAI Responses and Anthropic Messages, without retries or fallback models. Ordinary application agents retain their existing runtime.

Put your existing `OPENAI_API_KEY` in the private environment or ignored `.env.local` **in the checkout where you run the benchmark**. Add it to the existing file; do not overwrite the generated backend URLs or admin secret. `.env.example` includes an empty `OPENAI_API_KEY=` line. A key in a different worktree is not automatically loaded. Do not place credentials in the policy, command line or artifacts. This configures authentication only; **paid execution remains disabled**. The benchmark ignores ambient `OPENAI_BASE_URL`, `AGENT_MODEL`, `EXTERNAL_JUDGE_MODEL` and `AGENT_FALLBACKS`; its policy is the single source of model/budget configuration. `AGENT_LLM=off` still disables all inference.

Before any paid smoke, full matrix, or rescore, obtain approval for the exact agent/judge models, USD cap, maximum requests, token/turn limits and stop policy. After approval, save a private copy of `benchmarks/external-models.json` under `var/`, verify its configured models/prices, fill in the approved budget, and supply it with `--model-policy PATH`. Keep the checked-in default disabled. Required fields:

- `approval`: `approvedBy`, ISO `approvedAt`, positive `maxCostUsd`, positive integer `maxRequests`, and `maxTurnsPerCase` (the CLI cannot exceed this approved ceiling). It remains `null` until approval.
- `agent` / `judge`: `provider` (`openai` or `anthropic`), exact `model` ID returned by the provider, reasoning `effort`, `maxInputTokens`, `maxOutputTokens`, and `prices` (`input`, `output`, `cacheRead`, `cacheWrite`, in USD per million tokens). Prices are explicit, model-specific estimates; no Claude prices are reused for OpenAI. Select a flat price tier valid across the approved input limit.
- Both agent modes share the same agent configuration. The judge may use a different model/provider. The configured defaults are GPT-6.1 Sol at medium effort for agents and GPT-6 Astra at low effort for judging. Selecting these models does not authorize paid execution.

The checked-in policy uses the following **standard, short-context prices in USD per million tokens**, verified against [OpenAI pricing](https://developers.openai.com/api/docs/pricing) on October 24, 2026:

| Role | Model | Effort | Input | Output (including reasoning) | Cached input | Cache write (30m) |
|---|---|---|---:|---:|---:|---:|
| Full-team and generalist | `gpt-6.1-sol` | medium | $2 | $10 | $0.10 | $2.50 |
| APEX judge | `gpt-6-astra` | low | $10 | $50 | $1 | $12.50 |

Both have 100,000 input and 4,096 output tokens per request configured. The CLI defaults to 12 total agent turns per task/mode and three repeats. Standard global processing is used; no Batch/Flex discount, regional surcharge, or long-context tier is assumed. The published cache-write prices remain recorded for conservative budget reservations, even though this client disables cache writes and rejects nonzero write usage. Prices should be rechecked before budget approval.

OpenAI requires a Responses model supporting function calling, strict structured output, reasoning effort, and explicit prompt-cache controls (GPT-5.6 or later compatible models). Requests use `store: false`, standard service tier, no hosted tools, and explicit caching with no breakpoints, preventing cache writes. Returned reasoning items stay in memory for continuation. Cached input is separated from uncached input; reasoning tokens are included in output usage exactly once. Missing usage/cache-write details, nonzero cache writes, or a served model/tier mismatch stop execution. Anthropic uses an explicit `ANTHROPIC_API_KEY`, fixed origin, approved prices, and no SDK retries/fallbacks.

The budget is shared across both agent modes and the judge. Before every request, the harness checks a conservative input bound (serialized UTF-8 bytes, replayed reasoning, protocol allowance), reserves the configured input/output token ceilings at approved rates, and persists the reservation. Verified usage settles that reservation; transport/usage uncertainty retains the ceiling and stops further dispatch. A limit, agent error, judge error or incomplete/refused response stops the CLI with partial results. A local cost estimate is not a provider billing guarantee; token limits and prices must cover the selected model's pricing tier.

Each approval file is claimed once via an exclusive adjacent `.usage.json` ledger, including across concurrent processes or restarts. Do not delete the ledger to reuse an approval. A separate smoke, rerun or rescore requires a separately approved policy file. Copying policy files is not an account-wide billing control.

The full team also requires the existing Convex backend (`npm run backend`) and matching `KERNEL_ADMIN_SECRET` values in the backend and `.env.local`, as described in the README. The CLI uses `CONVEX_URL` or `VITE_CONVEX_URL`. Generalist and rules-only modes do not require the backend.

These preview commands remain free and do not claim a budget:

```bash
npm run bench:run -- --dry-run --repeats 3 --max-turns 12
npm run bench:run -- --dry-run --tasks dabstep-1273 --modes generalist,rules-only --repeats 1
npm run bench:score -- --dry-run --run var/evals/external/REPLACE_WITH_RUN_DIRECTORY
```

The default matrix schedules **8 tasks × 3 modes × 3 repeats = 72 task runs**, plus 27 APEX rubric-judge calls if every APEX answer succeeds. The conservative ceiling is 576 agent requests (48 model task runs × 12 turns), plus 27 judge requests. Actual calls and costs may be lower. No paid run command has been executed as part of provider implementation.

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

Both model modes receive the same source evidence, approved reasoning effort (medium by default), model/token settings, and total model-turn cap. The specialist gets up to half the cap; the controller gets the remaining turns. This equalizes turn ceilings, not token usage or wall time. The report includes actual usage and cost estimates. Mode order rotates between repeats.

All three adapters produce answers. They do not post invoices, move money, or exercise the complete production transaction lifecycle. Keep using the synthetic-world eval to measure those controls and end-to-end bookkeeping.

## Scoring and outputs

- **DABstep:** complete numeric answers are compared at the requested decimal precision, with a `1e-12` tolerance floor for upstream floating-point artifacts. Integer ID sets must match exactly, independent of order; duplicates, extra IDs and prose fail. Each task earns 0 or 1.
- **APEX:** a separate judge evaluates the final answer against every published criterion and expert reference. Each criterion earns 0 or 1, and the case score is their mean. Judge outputs must cover every criterion exactly once. This is a local rubric implementation, not execution of the official Harbor verifier. Review borderline judgments before reporting results.
- Agent failures and abstentions earn zero and remain separately counted. Disabled or failed judging produces a null grade, never an inferred pass. A group mean is withheld if its grades are incomplete. All aggregate scores and paired deltas are withheld for interrupted executions.

Each run writes to `var/evals/external/<timestamp>-<id>/`:

| File | Contents |
|---|---|
| `config.json` | Task/mode matrix, repeat and turn budgets, approved provider/model/pricing policy, budget-ledger path, evidence hashes and provenance hash |
| `results.json` | Answers, statuses, grades, usage, evidence-tool traces and kernel run IDs |
| `comparison.md`, `comparison.json` | Separate APEX/DABstep summaries and full-team-minus-baseline deltas paired by task/repeat |
| `traces/<task>-<mode>-<repeat>.json` | Original per-task result checkpoint |
| `complete.json` | End-of-run marker and expected/actual run counts |
| `rescoring.json` | Judge configuration and time of the latest rescore, when used |

Reports checkpoint after each task. Interrupted runs are inspectable but are not automatically resumed. Costs use the approved provider/model token prices rather than provider billing, and judge costs are separate. Unknown charges retain their reserved ceiling; inspect the policy's adjacent `.usage.json` for per-request status, served model, actual token usage and retained reservations. Per-case wall time includes adapter setup/tool work and excludes judging.

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

The opt-in integration test requires prepared fixtures and the backend. It uses a clearly labeled model stub to verify actual seat routing, evidence-tool access, Git decisions and repeat isolation without paid model calls. It creates isolated backend runs but does not write benchmark performance results. Mocked provider tests cover Responses continuation, multiple tool calls, invalid arguments, structured output, refusals/truncation, usage/pricing, no retries, and pre-dispatch budget denial. Approval tests cover the disabled default, one-use claims, shared agent/judge caps and retained uncertain charges. The unit tests also cover scoring, malformed judges, incomplete reports, evidence access restrictions and source conversion. Independent APEX fixtures verify opening-balance allocation, double-counting detection, monthly classification, changed source values and cutoffs, tax/PTO caps, balanced corrections, and failures for incomplete or duplicate records. They require no downloaded data or answer keys.

## Attribution

Source data remains under its publishers' **CC BY 4.0** licenses:

- Mercor, [APEX-Accounting Harbor](https://huggingface.co/datasets/mercor/apex-accounting-harbor), revision `1662b7e4c3b04b8717f2f723df823e7b6cbe2118`; world 9, tasks 13, 17 and 30.
- Adyen, [DABstep](https://huggingface.co/datasets/adyen/DABstep), revision `0545553f02cedc323dee8658af62555852bc3b24`; development tasks 1273, 1305, 1681, 1753 and 1871.

This repository adds task selection, format conversion, adapters and local scoring. Generated fixtures, reference answers and run artifacts remain under ignored `var/`; they are not checked into Git.

Provider protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
