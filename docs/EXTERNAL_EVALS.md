# Eight-task external finance evaluation

This batch compares `full-team`, `generalist`, and `rules-only` on three APEX accounting tasks and five DABstep payment-analysis tasks. It supplements the synthetic-world eval (`npm run eval`) with real benchmark source files. Its scores are local development-subset scores, not official leaderboard results.

Seven more cases, one Invoice Sandbox case and six FinBalance records, run through the same three modes. They are opt-in: the default matrix is still the eight tasks above. See [Opt-in cases: Invoice Sandbox and FinBalance](#opt-in-cases-invoice-sandbox-and-finbalance). **Status: adapters built, not yet run with a model.** Only the free rules-only baseline has run.

**Live comparison status: NOT_RUN.** OpenAI tool calling and structured APEX judging are implemented, with mocked transport coverage for OpenAI and Anthropic. Paid execution is disabled by the checked-in `benchmarks/external-models.json` (`approval: null`); having API keys does not enable it. The recommended models and prices are configured. Explicit budget approval and the first live smoke/matrix remain tracked in [#67](https://github.com/srivatsav-kannan/autonomous-finance/issues/67). The free milestone covers all eight rules baselines over three repeats (24/24 answers, no errors or abstentions), 15/15 DABstep passes, and real-backend integration tests using model stubs. APEX rules answers remain ungraded until an authorized judge run; mock results are not model-performance evidence.

## Prepare and run

Run from the repository root with Node 24.18+ and Python 3.11+. Install the source-file readers once:

```bash
python3 -m venv var/benchmarks/.venv
var/benchmarks/.venv/bin/python -m pip install -r scripts/external-bench/requirements.txt
npm run bench:prepare
npm run bench:list
```

Preparation downloads pinned public data from Hugging Face for the eight tasks and from GitHub for the opt-in cases. It extracts PDFs, spreadsheets, CSVs, JSON, emails and documents into read-only SQLite evidence databases. The local venv is discovered automatically; `EXTERNAL_BENCH_PYTHON` can select another interpreter. No upstream executable scripts or containers are run. `--batch eight` or `--batch extra` prepares one batch; the default prepares both, into `var/benchmarks/finance-eight` and `var/benchmarks/finance-extra` (`--data` and `--extra-data` override them).

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

For these eight tasks, all three adapters produce answers. They do not post invoices, move money, or exercise the complete production transaction lifecycle. Keep using the synthetic-world eval to measure those controls and end-to-end bookkeeping. The opt-in FinBalance cases are the one exception: full-team posts journal entries to the kernel (below).

## Opt-in cases: Invoice Sandbox and FinBalance

`benchmarks/finance-extra.json` pins seven cases. Name them with `--tasks`, by ID or by benchmark name (`--tasks finbalance,invoice-sandbox`). Without `--tasks`, the run is the unchanged eight-task matrix, with the same prompts, evidence hashes, grading keys and provenance as before. A run that mixes both batches records each batch's provenance hash in `config.json`.

| Local ID | Source record | What it tests | Team specialist |
|---|---|---|---|
| `invoice-sandbox-net-spend` | Invoice Sandbox fixture (commit `b8cb58f`) | Customer-level gross, credit and net spend from 112 invoice PDFs, 30 emails, bank exports, a CRM file and notes, with voids, a superseded original and its revision, a duplicate scan, statements and credit memos | Revenue accountant |
| `finbalance-cov-pro-m1-0000` | `COV_PRO_M1_0000` | L1, month, professional services, USD; includes a cancellation-note distractor | Revenue accountant |
| `finbalance-db-hea-q1-00196` | `DB_HEA_Q1_00196` | L1, quarter, healthcare clinic, USD; includes a vendor-statement distractor | Revenue accountant |
| `finbalance-cov-pro-y1-0085` | `COV_PRO_Y1_0085` | L1, year, property management, EUR (European number format); memo and vendor-statement distractors | Revenue accountant |
| `finbalance-db-pro-m2-00004` | `DB_PRO_M2_00004` | L2, month, professional services, VAT on sales and purchases, customer and supplier settlements citing two documents each | Revenue accountant |
| `finbalance-neg-bank-closing-01` | `MAIN_NEG_01_BANK_CLOSING_MISMATCH` | Contradiction: the bank statement's closing balance does not follow from its rows | Revenue accountant |
| `finbalance-neg-invoice-total-01` | `MAIN_NEG_01_INVOICE_TOTAL_MISMATCH` | Contradiction: a bill's total disagrees with its line items and tax | Revenue accountant |

The FinBalance cases are a small stratified pick from the 710-record `data/main` split. The four standard records span three industries, all three period types, levels 1 and 2, two currencies and a VAT regime. The two contradiction records use the most common negative-control codes at levels 1 and 2. They are all low difficulty: the paper's hard cases (levels 3 to 5, with leases, deferred tax, FX and ASC 606) are not in this pick.

**What each mode does**

- **Generalist:** one model with the task prompt and the read-only evidence tools. For FinBalance the prompt is FinBalance's own baseline prompt (`build_prompt`, baseline variant, normal visibility), ported to `scripts/external-bench/prepare_extra.py` and checked line by line against the pinned source at prepare time. The answer is FinBalance's strict JSON, including the model's own balance sheet. For Invoice Sandbox, the prompt is the existing harness's task text (`evals/external/invoice-sandbox/lib/task.ts`, read at prepare time), plus a two-CSV-block output contract.
- **Full team:** CFO dispatch, revenue-accountant draft and controller review, as for the other cases. For **FinBalance**, the controller's reviewed entries are then **booked through the ledger kernel**. The controller seat calls `ledger.postEntry` once per entry, in the task's isolated kernel run, dated at the record's period end. The kernel enforces balance, integer cents, an open period, seat posting rights, idempotency and the hash chain. The submitted balance sheet is computed from the kernel's `trialBalance` plus the record's public opening balances; the balance sheet the model wrote is discarded and kept in the trace. Entries the kernel refuses, or that name accounts outside FinBalance's taxonomy, are left out and listed in the trace, as FinBalance's own reconstruction does. Contradiction answers and answers that don't parse are not booked. The Git decision record states how many entries were booked. For Invoice Sandbox, full-team produces an answer only, like the eight tasks.
- **Rules-only:** deterministic procedures in `scripts/external-bench/extra_rules.py` over the same public evidence. Invoice Sandbox applies the README's dataset rules: void excluded, a revision supersedes its original, one invoice number counts once, statements and bank deposits excluded, credit memos subtracted. It reads only the invoice PDFs' first pages and the CRM file, never the answer key. FinBalance applies the prompt's accounting rules to the document types in these six records. It checks documents for contradictions and computes the balance sheet with a port of FinBalance's ledger. Unsupported document types, tax regimes or unresolved references raise errors instead of guessing.

**How the kernel binding works, and its limits.** The kernel's chart of accounts is the company's (`src/core/accounts.ts`), not FinBalance's. For each run, every FinBalance account the entries touch is bound to a distinct non-cash kernel account of the same type, and the binding is recorded in the trace. Revenue and expense accounts may share a code, since only their total reaches the balance sheet, through retained earnings. If a record needs more balance-sheet accounts of one type than the chart offers (8 assets, 6 liabilities, 1 equity), the run errors rather than merging them. FinBalance has no bank feed, so its Cash is bound to a non-cash kernel account. **The kernel's cash and bank-evidence controls are therefore not exercised.** Unit tests (`tests/finbalance-kernel.test.ts`) run the real `postEntry`, `trialBalance` and `verifyChain` handlers against the repository's in-memory kernel harness, and show the kernel balance sheet equals FinBalance's own ledger. An opt-in integration test (`EXTERNAL_BENCH_INTEGRATION=1`) covers the same path on the live backend; it has not been run as part of this change.

**Scoring**

- **Invoice Sandbox:** the official `scripts/score_submission.py` metric, ported to `src/evals/external/invoice-sandbox.ts`. For each CRM customer, `net_spend_usd` must be within $0.01. Missing customers miss; extra customers are reported but not penalized. Money parsing follows `Decimal.quantize` (half-even), and an unparseable value scores the whole answer zero, as the official script stops on it. Score = customers exact / 18; passed = 18/18. The grade also records count, gross and credit exactness, like the existing `score.py`. On the eight saved runs in `../benchdata/invoice-sandbox/runs`, the port reproduces the official customers-exact count and absolute error for every run.
- **FinBalance:** a port of `parse_submission` and `analyze_submission` (`src/evals/external/finbalance.ts`). Standard records score `final_balance_sheet_matches` (BS_exact: same nonzero accounts per section, each within $0.01). Contradiction records score `inconsistency_code_matches` (flag set and the exact code set). An unparseable answer scores zero, as in FinBalance's harness. The grade also records entry matching (exact, doc-refs mismatch, wrong amount or account, missing, extra), whether the entries reconstruct the correct balance sheet, and false alarms. Rescoring the 218 saved Opus 5.5 responses in `../benchdata/finbalance/results` (178 baseline, 40 ledger-feedback) reproduced the upstream metrics on all 2,240 compared fields. That includes the published 69.2% BS_exact and 96.5% contradiction-code rates. The comparison table's FinBalance mean pools the four standard and two contradiction records; the paper reports them separately, so read the per-case rows (or `grade.metrics.expected_inconsistency`) before quoting a number.

**Free rules-only result** (`--modes rules-only --repeats 1 --judge off`, Oct 24, 2026): 7/7 cases fully passed. Invoice Sandbox has 18/18 customers exact, and every count, gross and credit field also matches. All four FinBalance standard records are BS_exact, with entries that match exactly, citations included. Both contradiction records get the exact code. **Read this as a check that the harness, evidence and scorers agree, not as a baseline.** These procedures were written by someone who had seen these records' expected entries, and the answer key's first rows, while picking the cases. They cover only the document types present. The FinBalance contradiction check also can't tell `invoice_total_mismatch` from `tax_total_mismatch` when an invoice's lines equal its subtotal and only the total is wrong. FinBalance's generator renders both codes the same way, so the procedure reports `invoice_total_mismatch`.

**Cost estimate** (not measured; checked-in policy prices: `gpt-6.1-sol`, $2 per million input and $10 per million output tokens; no judge, because both scorers are deterministic):

| Case | Prompt size | Expected per run, generalist | Expected per run, full team | Ceiling per run (12 requests × 100k in + 4,096 out) |
|---|---|---|---|---|
| FinBalance (each) | 13–16k characters, about 4–5k tokens, all documents inline | about $0.03–0.08 | about $0.08–0.20 | $2.89 |
| Invoice Sandbox | short prompt; 2.7M characters of evidence reached through tools | about $0.5–1.5 | about $0.8–2.0 | $2.89 |

A one-repeat run of all seven cases in both model modes is about **$2–5** expected, with a $40.48 ceiling (14 model runs, at most 168 requests). The default three repeats are about **$5–17** expected, with a $121.44 ceiling (42 model runs, at most 504 requests). Invoice Sandbox needs many tool calls. Running it with the 12-turn default may exhaust the turn budget or the 100k-token request guard. A guard stop halts a paid run, so run it on its own (`--tasks invoice-sandbox`), and consider `--max-turns 24`, which doubles its ceiling to $5.78 per run.

To run them paid after budget approval (the full team also needs the backend, as above):

```bash
npm run bench:prepare -- --batch extra
npm run bench:run -- --tasks finbalance-cov-pro-m1-0000 --modes full-team,generalist --repeats 1 --judge off --model-policy var/external-models.extra-smoke.json   # smoke, ceiling $5.78
npm run bench:run -- --tasks finbalance --repeats 3 --judge off --model-policy var/external-models.finbalance.json                                            # 54 runs (36 with a model), ceiling $104.09
npm run bench:run -- --tasks invoice-sandbox --repeats 3 --max-turns 24 --judge off --model-policy var/external-models.invoice.json                           # 9 runs, ceiling $34.70
```

Each policy file is a private copy of `benchmarks/external-models.json` with its own approval (`maxTurnsPerCase` at least the `--max-turns` used), claimed once.

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

`benchmarks/finance-eight.json` and `benchmarks/finance-extra.json` pin task IDs and source revisions. The extra manifest pins full GitHub commit SHAs and the SHA-256 of every file it uses. That covers the FinBalance dataset, its code taxonomy and prompt source, the Invoice Sandbox README, a tree hash of its committed `gold_master/` fixture, and its answer key. A mismatch stops preparation. Invoice Sandbox uses the committed fixture, so its Python generator is never run. FinBalance's codes and account types are read with `ast.literal_eval`, so its package is never imported. FinBalance public evidence holds only what its prompt shows: document ID, type, title and OCR text, the record context, opening balances, allowed accounts and the code list. Document roles, posting labels, scenario notes and every `expected_*` field stay in `private/gold.json`. Each batch's preparation writes:

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

For the opt-in cases: `src/evals/external/invoice-sandbox.test.ts` and `finbalance.test.ts` cover the ported scorers. That includes tolerance edges, missing and unexpected customers, unparseable money, fenced and separator-damaged JSON, unknown codes, contradiction code sets, false alarms and Python-compatible rounding. `tests/finbalance-kernel.test.ts` books entries through the real kernel handlers, covering refusals, idempotent replay, the hash chain and slot exhaustion. `scripts/external-bench/test_extra_rules.py` covers both rules procedures on hand-written fixtures, safe archive extraction, literal-only source reading and the prompt-port check. `main.test.ts` checks that the default matrix is still the eight tasks.

## Attribution

Source data remains under its publishers' **CC BY 4.0** licenses:

- Mercor, [APEX-Accounting Harbor](https://huggingface.co/datasets/mercor/apex-accounting-harbor), revision `1662b7e4c3b04b8717f2f723df823e7b6cbe2118`; world 9, tasks 13, 17 and 30.
- Adyen, [DABstep](https://huggingface.co/datasets/adyen/DABstep), revision `0545553f02cedc323dee8658af62555852bc3b24`; development tasks 1273, 1305, 1681, 1753 and 1871.

Opt-in cases, fetched at preparation time and not redistributed:

- The FinBalance authors, [FinBalance](https://github.com/Devansh1105/finbalance) ([arXiv 2606.15949](https://arxiv.org/abs/2606.15949)), commit `a1062b7b392eaf53311308c2f63cf748b68bb8cf`. Code is **Apache-2.0** (the prompt, parser, scorer and ledger are ported here); data is **CC BY 4.0**. Six records from `data/main`.
- ciru-ai, [Invoice Sandbox Benchmark](https://github.com/ciru-ai/invoice-sandbox-benchmark), commit `b8cb58ff9747486e86c623e867b76fad5d8d075f`. The pinned commit has no license file, so its fixture is downloaded for local evaluation only and nothing from it is checked in.

This repository adds task selection, format conversion, adapters and local scoring. Generated fixtures, reference answers and run artifacts remain under ignored `var/`; they are not checked into Git.

Provider protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
