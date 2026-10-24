# Vals AI Finance Agent benchmark: unofficial harness

This harness runs the public question set (50 questions) of the [Vals AI Finance Agent benchmark](https://www.vals.ai/benchmarks/finance_agent) (v1.1, repo [vals-ai/finance-agent](https://github.com/vals-ai/finance-agent), MIT code, CC BY 4.0 data) with Claude Opus 5.5 and real tools, then grades the answers with the benchmark's rubrics.

**It is an unofficial harness.** The official one needs a gated Vals platform account plus Tavily and sec-api.io keys. This one uses a different search provider, our own EDGAR tool and our own judge. Its numbers are indicative and are not equivalent to the leaderboard. Results and the leaderboard comparison are in [`docs/evals/vals-finance-agent.md`](../../../docs/evals/vals-finance-agent.md) (machine-readable copy: `.json`).

## What it mirrors, and what it replaces

| Part | Official harness (`finance_agent/*.py` @ 8ba65f8) | This harness |
|---|---|---|
| Prompt | `INSTRUCTIONS_PROMPT`, sent as the first user message, no system prompt | Same text character for character, except the data-storage paragraph, which is swapped for an equivalent web_fetch paragraph (`src/prompt.ts`) |
| Web search | `web_search`: Tavily, `end_date` capped at 2025-04-07 | Anthropic server tool `web_search_20260209` (no date filter) |
| Documents | `parse_html_page` + `retrieve_information` (key-value store, LLM query over stored text) | Anthropic server tool `web_fetch_20260209` (dynamic filtering: the model filters fetched pages with code before they reach context) |
| EDGAR | `edgar_search`: sec-api.io full-text search | `edgar_search` client tool with the same name, description, parameters, validation and date cap, backed by SEC's free EDGAR full-text search (`efts.sec.gov/LATEST/search-index`). Requests carry a declared User-Agent from `SEC_USER_AGENT` (set it to "name email" before running; SEC asks for a contact) and are limited to 8/s across all questions (`src/edgar.ts`). |
| Submission | `submit_final_result`; nothing else ends a question | Same tool and description |
| Loop | 50 turns max (`--max-turns` default); text-only reply gets "Continue."; tool errors go back to the model | Same. A turn is one model sampling iteration (`usage.iterations`), so server-side search and fetch steps count. `pause_turn` is resumed. (`src/agent.ts`) |
| Model | Temperature 0 by default in the CLI. The Anthropic leaderboard runs used max_tokens 128000. | `claude-opus-5-5`, adaptive thinking, effort `high`, max_tokens 128000, streaming, no sampling parameters, prompt caching, server-side refusal fallback (`fallbacks: "default"`) |
| Grading | Vals platform. The v1.1 judge is GPT-5.2, mode of 3 samples. Operators `correctness` / `contradiction`; a question is correct only if every check passes. | `claude-opus-5-5` at effort `medium`. It makes one call per check and takes the mode of 3 samples. It sees only the question, the check and the final answer. Operator wording comes from the Finance Agent paper (arXiv 2508.00828), because Vals' judge prompt is not public. (`src/judge.ts`) |

The harness also adds two safety rails that the official one does not have. A question is stopped at $6 or 45 minutes and is then scored as unanswered. A spend ledger (`var/evals/vals-finance-agent/ledger.jsonl`) enforces a hard budget across all phases.

## Reproduce

Run everything from the `autonomous-finance` repo root. `ANTHROPIC_API_KEY` is read from `.env.local`; it is never printed or written anywhere.

```bash
# 0. Benchmark data (outside the repo)
git clone --depth 1 https://github.com/vals-ai/finance-agent.git ../benchdata/vals-finance-agent/repo

# 1. Typecheck, then a capability probe (about $0.10)
npx tsc --noEmit -p evals/external/vals-finance-agent/tsconfig.json
npx tsx evals/external/vals-finance-agent/src/probe.ts

# 2. Pilot on 3 questions to measure cost
npx tsx evals/external/vals-finance-agent/src/run.ts --run-id pilot --ids q003,q015,q043 --concurrency 3

# 3. Full public set (reuses the pilot records, which come from the same harness version)
npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --all --reuse-from pilot --concurrency 8
#    ...or a stratified subset across Question Types if the budget is tight:
#    npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --stratified 25 --seed 1
#    Optional repeats of the same questions, to see run-to-run variation:
npx tsx evals/external/vals-finance-agent/src/run.ts --run-id rep2 --all --concurrency 8

# 4. Grade (3 judge samples per check, mode)
npx tsx evals/external/vals-finance-agent/src/grade.ts --run-id main --samples 3
npx tsx evals/external/vals-finance-agent/src/grade.ts --run-id rep2 --samples 3

# 5. Leaderboard snapshot, then the report (docs/evals/vals-finance-agent.{md,json})
npx tsx evals/external/vals-finance-agent/src/leaderboard.ts
npx tsx evals/external/vals-finance-agent/src/report.ts --runs main,rep2 --judge-tag s3
```

The `run.ts` script stops starting new questions once the ledger total, plus an estimate for the questions in flight, plus a judging reserve would pass `--hard-budget` (default $60). Finished questions are skipped on re-run, so an interrupted run resumes where it stopped (pass `--force` to redo them).

## Files

- `src/config.ts`: model, effort, limits, prices and paths
- `src/prompt.ts`: the agent prompt (official text kept alongside for the record)
- `src/agent.ts`: the agent loop, tool definitions and fallback-safe echoing of assistant turns
- `src/edgar.ts`: the `edgar_search` tool over EDGAR full-text search, with the shared SEC rate limiter
- `src/judge.ts`: the rubric judge (a separate prompt from the agent)
- `src/run.ts`, `src/grade.ts`, `src/report.ts`, `src/leaderboard.ts`: CLIs
- `src/pricing.ts`, `src/stats.ts`, `src/select.ts`, `src/store.ts`, `src/dataset.ts`: helpers
- `src/probe.ts`, `src/probe-fetch.ts`: one-off API capability checks, including whether `web_fetch` can read SEC filings

Run output goes to `var/evals/vals-finance-agent/runs/<run>/`, which is gitignored. Each run has three subfolders:
- `questions/`: one record per question (status, final answer, turns, tool calls, tokens, cost, time)
- `transcripts/`: the full message history and per-call usage
- `judge-<tag>/`: the judgments
