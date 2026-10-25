# Vals AI Finance Agent (v1.1 public set): Claude Opus 5.5, unofficial harness

> **Unofficial harness.** Indicative only, not leaderboard-equivalent: different search provider (Anthropic web search instead of Tavily), different document tools (web_fetch instead of parse_html_page/retrieve_information), our EDGAR tool (SEC full-text search instead of sec-api.io), our judge (Claude Opus 5.5 instead of GPT-5.2), and the public set instead of the private Test set.

Generated 2026-10-24 from `evals/external/vals-finance-agent/` (reproduce: see its README). Raw transcripts: `var/evals/vals-finance-agent/runs/` (gitignored).

> **Incomplete coverage: 44 of 50 questions are graded.** The Anthropic API key ran out of credit during the run (HTTP 400 'Your credit balance is too low'). The questions in flight then failed, and the remaining answers could not be graded. No further API calls were made. Every score below is on the 44 graded questions only. The graded subset is not stratified: it is the first 45 questions in CSV order minus q039. It under-represents Beat or Miss (3/7 graded) and Market Analysis (2/3). Across the full 50, accuracy would lie between 68.0% (all 6 unscored questions wrong) and 80.0% (all right).

## Result

| Metric | Value |
|---|---|
| Coverage (primary pass `main`) | **44 of 50 questions graded.** 47 were answered; 3 of those were not graded (q039, q046, q047), and 3 were not answered (q048, q049, q050) |
| Accuracy (all rubric checks pass) | **77.3%** (34/44), 95% Wilson CI 63.0% to 87.2% |
| Class-balanced accuracy (Vals' leaderboard formula) | 69.1%, 95% stratified-bootstrap CI 58.6% to 79.6% (stderr 5.2%) |
| Rubric check pass rate | 86.3% (183/212); correctness 144/168, contradiction 39/44 |
| Mean fraction of checks passed per question | 88.2% |
| Agent cost (primary pass) | $8.38 total, $0.19 mean / $0.16 median / $0.60 max per question (web search fees $0.72) |
| Judge cost (primary pass) | $2.44 |
| Total spend, all phases (ledger) | $13.11 of the $60 budget (probe $0.52, agent $9.98, judge $2.61) |
| Wall time per question | 4.9 min mean, 5.2 median, 13.4 max; pass elapsed 36 min at concurrency 8 |
| Turns per question | 8.0 mean, 7.5 median, 26 max (limit 50) |
| Tool calls (total / mean per question) | web_search 72 / 1.6; web_fetch 138 / 3.1; code execution (dynamic filtering) 266 / 6.0; edgar_search 45 / 1.0 (used in 38 questions) |
| Tokens (primary pass) | 4.42M cache read, 0.87M cache write, 0.8K uncached input, 0.12M output; 72 web searches, 138 fetches |
| Status | submitted 44; refusal fallbacks used in 0 question(s); served by claude-opus-5-5 |

## By question type

| Question type | n | Correct | Accuracy | Check pass rate | Vals v1.1 Test set: Opus 4.7 / Sonnet 4.6 |
|---|---|---|---|---|---|
| Adjustments | 4 | 3 | 75.0% | 80.0% | 74.1% / 66.7% |
| Beat or Miss | 3 | 3 | 100.0% | 100.0% | 55.8% / 51.2% |
| Complex Retrieval | 3 | 3 | 100.0% | 100.0% | 55.6% / 55.6% |
| Financial Modeling  Projections | 4 | 2 | 50.0% | 76.0% | 73.3% / 73.3% |
| Market Analysis | 2 | 0 | 0.0% | 33.3% | 28.6% / 33.3% |
| Numerical Reasoning | 8 | 7 | 87.5% | 88.5% | 75.0% / 73.1% |
| Simple retrieval - Qualitative | 8 | 7 | 87.5% | 96.3% | 77.0% / 72.1% |
| Simple retrieval - Quantitative | 9 | 8 | 88.9% | 92.6% | 82.8% / 82.8% |
| Trends | 3 | 1 | 33.3% | 85.7% | 57.1% / 61.9% |

Per-type n is 3 to 9, so per-type accuracies are very noisy (one question moves a 3-question type by 33 points).

## Leaderboard comparison (fetched 2026-10-24)

Vals publishes results only on private Test sets, never on the public set, so no published number is directly comparable to ours.

| Leaderboard | Updated | Leader(s) | Claude Opus 5.5 | Comparable to this run? |
|---|---|---|---|---|
| [Finance Agent v1.1](https://www.vals.ai/benchmarks/finance_agent) (archived) | 2026-06-04 | claude-opus-4-7 64.37%; claude-sonnet-4-6 63.33%; muse_spark 60.59% | not listed | Closest: same harness design, taxonomy and grading as the public set we ran, but Test set (337 Q), GPT-5.2 judge, Tavily + sec-api tools |
| [Finance Agent v2.1](https://www.vals.ai/benchmarks/fabv2-1) | 2026-10-22 | claude-opus-5-5 67.85%; gemini-4-argon 67.66%; muse-wonder-full 67.58% | 67.85% (effort max, $8.91/test, 33 min/test) | No: different questions (v2), harness (adds calculator, price_history; 2 h limit), dealbreaker-gated partial credit, 3-model jury |
| [Finance Agent (v2)](https://www.vals.ai/benchmarks/fabv2) | 2026-10-20 | gemini-4-argon 65.40%; gemini-3.8-flash 61.44%; muse-spark-open 61.34% | 58.59% (effort max, $9.22/test, 33 min/test) | No: v2 question set and harness |
| [Finance Agent v1](https://www.vals.ai/benchmarks/finance_agent_v1) (archived) | 2026-02-10 | claude-opus-4-6-thinking 60.65%; gpt-5.1-2025-11-13 56.55%; claude-sonnet-4-5-20250929-thinking 55.32% | not listed | No: older harness (SerpAPI, no submit tool) |

On v2.1, Claude Opus 5.5's all-pass score (closest to our all-checks metric) is 56.27% versus 67.85% partial credit.
Anthropic models on v1.1: claude-opus-4-7 64.37% (effort high, $0.80/test); claude-sonnet-4-6 63.33% (effort max, $1.44/test); claude-opus-4-6-thinking 60.05% (effort max, $1.11/test); claude-opus-4-5-20251101-thinking 58.81% (effort high, $1.50/test); claude-sonnet-4-5-20250929-thinking 54.50% (effort n/a, $1.10/test); claude-haiku-4-5-20251001-thinking 46.93% (effort n/a, $0.38/test). Claude Opus 5.5 is not listed on v1.1 (last updated 2026-06-04).

## Deviations from the official protocol

- Search provider: Tavily web_search (date-capped at 2025-04-07, up to 20 results) is replaced by Anthropic's server-side web_search_20260209, which has no date filter; results can include material published after the benchmark's as-of date (the prompt still says to answer as of April 07, 2025).
- Document tools: parse_html_page + retrieve_information (key-value store queried by a second call to the same LLM) are replaced by Anthropic's server-side web_fetch_20260209 with dynamic filtering (the model filters fetched pages/PDFs with code before they reach context). web_fetch can only fetch URLs that already appeared in the conversation, unlike parse_html_page.
- EDGAR: sec-api.io full-text search is replaced by our edgar_search client tool over SEC's free EDGAR full-text search (efts.sec.gov/LATEST/search-index): same tool name, description, parameters, validation and 2025-04-07 date cap; results are mapped to sec-api-style metadata (accessionNo, cik, companyNameLong, ticker, formType, type, description, filedAt, periodOfReport, filingUrl). EDGAR FTS indexes 2001+ only and its query parser is EDGAR's, not sec-api's.
- Prompt: INSTRUCTIONS_PROMPT is sent verbatim as the first user message (no system prompt, as in the official harness) except one paragraph: the data-storage / retrieve_information paragraph is replaced by an equivalent paragraph about web_fetch.
- Model settings: claude-opus-5-5, adaptive thinking (always on), output_config.effort "high", max_tokens 128000, no temperature (the official CLI default is temperature 0; Vals' Anthropic leaderboard runs list temperature 1.0), streaming, top-level prompt caching, server-side refusal fallbacks (fallbacks: "default").
- Turn limit: 50 turns as in run_agent.py, where one turn = one model sampling iteration (usage.iterations), counted across server-side tool loops; the check happens between API calls, so a call already in flight can finish a few iterations past the limit. Text-only replies get "Continue." as in get_agent.py; only submit_final_result ends a question.
- Safety rails not in the official harness: per-question cost cap $6.00 and wall-clock cap 45 min (a hit is scored as no answer); SEC requests limited to 8/s with the declared User-Agent.
- Judge: claude-opus-5-5 at effort "medium" with structured JSON verdicts, one call per rubric check, mode of 3 samples (Vals v1.1 uses GPT-5.2 as judge and the mode of three; its judge prompt and rounding guidelines are not public, so ours are written from the operator definitions in the Finance Agent paper). Empty answers are graded without a model call (correctness checks fail).
- Metric: a question counts as correct only if all of its rubric checks pass (the paper's conjunction rule). Vals' leaderboard 'Accuracy' for v1/v1.1 is the class-balanced mean of the nine category accuracies on the private 337-question Test set (verified: Opus 4.7's per-category numbers average to its 64.37%); we report naive and class-balanced accuracy on the 50-question public set.
- Data split: the public set (50) is not the Test set the leaderboard is computed on; Vals publishes no public-set scores.

## Judge spot-check

I re-graded 5 judge decisions by hand (question, criterion and answer only). Agreement: **5/5**.

| Question | Check | Judge (samples) | Mine | Note |
|---|---|---|---|---|
| q036 | #3 correctness: $12.50 per share | pass (pass,pass,pass) | pass | Answer states the deal price as $12.50 per Redfin share, verbatim. |
| q012 | #0 correctness: Q1 2025 guidance (USD): $25.0B to $25.8B | pass (pass,pass,pass) | pass | Answer quotes Q1 2025 guidance of US$25.0B to US$25.8B from the 4Q24 release. |
| q042 | #3 correctness: KHC: 0.70 | fail (fail,fail,fail) | fail | Answer covers KDP, KO, PEP and MNST only; Kraft Heinz is never mentioned. |
| q001 | #3 correctness: U.S. government would retain a golden share protecting national interests | fail (fail,fail,fail) | fail | No golden share in the answer. The answer correctly stops at the 2025-04-07 as-of date; the golden share came later in 2025, so this rubric item expects post-cutoff facts. |
| q014 | #1 correctness: 2023 FCF margin: 11.3% | pass (pass,fail,pass) | pass | Borderline. 11.26% for FY2023 appears only as the PP&E-only alternative (headline 9.72%); counts as present under the paper's definition. The judge split 2-1, and it failed an equivalent hedged alternative in q022 (outside this sample). |

## Failures and anomalies

- Not answered: q048 (Beat or Miss, api_error), q049 (Beat or Miss, api_error), q050 (Beat or Miss, api_error). The cause was the API key running out of credit (HTTP 400 "Your credit balance is too low to access the Anthropic API"); these are infrastructure failures, not model failures, so they are left out of the score instead of counted as wrong.
- Answered but not graded (the judge needs the same API key): q039, q046, q047.
- **Harness defect (v1, this pass): most EDGAR filings could not be fetched.** edgar_search returned compact, whitespace-free JSON. For URLs that appeared only in an edgar_search result, web_fetch accepted the last URL of that result (24/24 fetches succeeded) and rejected every earlier one as url_not_in_prior_context (81/81). 29 of 50 questions hit at least one blocked fetch. The agent usually recovered through web search, so these answers were still scored, but this likely understates the agent's accuracy. Graded accuracy was 18/26 with a blocked fetch and 16/18 without; this split is correlational. Fix (harness v2, not yet run because of the credit outage): results are now serialised like the official tool's Python json.dumps output (", " separators).
- q001 (US Steel / Nippon Steel): the expected answer and rubric include facts from the deal's mid-2025 completion (a U.S. golden share, the $14B / $11B-by-2028 investment pledge, the up-to-$4B new mill). Those postdate the benchmark's April 07, 2025 as-of date, so an answer that respects the date fails 7 of its 9 checks.
- Wall times in this pass are inflated. The median time to a question's first response was 4 s for the first 8 questions started and 152 s for the 33 after them. Node 26's fetch sent every API request over one HTTP/2 connection, so new requests queued behind the long streaming turns; a probe in a fresh process took about 2 s. The harness now uses separate HTTP/1.1 sockets for the API. Token, cost and accuracy figures are unaffected.
- Every graded question ended with a submit_final_result call: no turn-limit, cost or time cap, refusal, or fallback hits.
- Tool errors returned to the agent: web_fetch:url_not_in_prior_context x76.

- As-of leakage (no date filter on web_search): 2 answers fetched, and 2 cited, at least one SEC filing filed after 2025-04-07. Accuracy was 1/2 among the citing answers vs 33/42 among answers that neither fetched nor cited one. The official harness caps both search tools at that date.

## Per question (primary pass)

| ID | Type | Correct | Checks | Turns | Search / Fetch / Code / EDGAR | Cost | Min | Failed checks |
|---|---|---|---|---|---|---|---|---|
| q001 | Market Analysis | no | 1/9 | 26 | 3 / 23 / 21 / 5 | $0.60 | 13.3 | #1 CEO David B. Burritt highlighted Nippon Steel's global exper; #2 U.S. Steel framed the acquisition as a strategic partnership; #3 U.S. government would retain a golden share protecting natio; #4 Commitments to safeguard over 100,000 jobs; #5 $14B pledged including $11B by 2028 for facility upgrades an; #6 Up to $4B allocated for a U.S.-based advanced mill; #7 Focus on Western Pennsylvania jobs and regional economic gro; #8 contradiction |
| q002 | Trends | no | 9/10 | 10 | 2 / 5 / 8 / 1 | $0.18 | 2.3 | #6 From 2019-2022, average revenue per paying membership increa |
| q003 | Beat or Miss | yes | 3/3 | 3 | 3 / 0 / 2 / 0 | $0.15 | 0.5 | - |
| q004 | Complex Retrieval | yes | 5/5 | 6 | 4 / 7 / 4 / 1 | $0.17 | 3.4 | - |
| q005 | Simple retrieval - Qualitative | yes | 9/9 | 9 | 6 / 1 / 7 / 1 | $0.56 | 1.1 | - |
| q006 | Complex Retrieval | yes | 5/5 | 3 | 1 / 0 / 2 / 0 | $0.08 | 0.3 | - |
| q007 | Simple retrieval - Qualitative | yes | 2/2 | 5 | 0 / 1 / 2 / 2 | $0.08 | 3.6 | - |
| q008 | Simple retrieval - Quantitative | no | 0/2 | 12 | 1 / 4 / 9 / 2 | $0.21 | 4.5 | #0 $3.25 Billion; #1 contradiction |
| q009 | Beat or Miss | yes | 2/2 | 7 | 1 / 4 / 5 / 1 | $0.13 | 2.7 | - |
| q010 | Numerical Reasoning | yes | 4/4 | 7 | 1 / 2 / 5 / 1 | $0.11 | 6.5 | - |
| q011 | Simple retrieval - Quantitative | yes | 5/5 | 8 | 1 / 2 / 6 / 1 | $0.11 | 6.2 | - |
| q012 | Financial Modeling  Projections | no | 8/11 | 7 | 7 / 6 / 6 / 0 | $0.25 | 3.2 | #1 Q1 2025 guidance (NT$ at 3288): 835,152; #9 Q1: -1.2% Miss; #10 contradiction |
| q013 | Numerical Reasoning | yes | 2/2 | 11 | 2 / 3 / 9 / 1 | $0.29 | 5.3 | - |
| q014 | Trends | no | 4/6 | 9 | 1 / 2 / 7 / 1 | $0.17 | 5.3 | #2 2022 FCF margin: 24.8%; #5 contradiction |
| q015 | Numerical Reasoning | yes | 6/6 | 7 | 0 / 2 / 5 / 1 | $0.12 | 0.9 | - |
| q016 | Complex Retrieval | yes | 12/12 | 15 | 4 / 6 / 13 / 1 | $0.41 | 7.3 | - |
| q017 | Trends | yes | 5/5 | 12 | 4 / 5 / 10 / 1 | $0.24 | 7.3 | - |
| q018 | Simple retrieval - Qualitative | yes | 6/6 | 8 | 1 / 4 / 6 / 1 | $0.15 | 6.9 | - |
| q019 | Numerical Reasoning | yes | 2/2 | 3 | 0 / 1 / 1 / 1 | $0.07 | 6.8 | - |
| q020 | Numerical Reasoning | yes | 4/4 | 10 | 1 / 2 / 8 / 1 | $0.17 | 7.0 | - |
| q021 | Simple retrieval - Qualitative | yes | 3/3 | 9 | 1 / 2 / 7 / 1 | $0.16 | 6.9 | - |
| q022 | Numerical Reasoning | no | 1/4 | 14 | 3 / 6 / 12 / 1 | $0.29 | 7.4 | #0 FY 2022: $160.44; #1 FY 2023: $163.51; #2 FY 2024: $166.23 |
| q023 | Simple retrieval - Qualitative | yes | 2/2 | 10 | 1 / 10 / 8 / 2 | $0.42 | 7.9 | - |
| q024 | Numerical Reasoning | yes | 2/2 | 4 | 0 / 1 / 2 / 1 | $0.17 | 5.1 | - |
| q025 | Simple retrieval - Qualitative | no | 7/9 | 11 | 1 / 2 / 9 / 1 | $0.22 | 5.4 | #5 Third-party partners and suppliers may experience breaches, ; #6 Security incidents could damage trust in HCM and payroll sol |
| q026 | Numerical Reasoning | yes | 2/2 | 3 | 0 / 1 / 1 / 1 | $0.06 | 4.6 | - |
| q027 | Simple retrieval - Qualitative | yes | 6/6 | 4 | 1 / 1 / 2 / 1 | $0.22 | 5.6 | - |
| q028 | Simple retrieval - Quantitative | yes | 2/2 | 3 | 0 / 1 / 1 / 1 | $0.10 | 5.3 | - |
| q029 | Simple retrieval - Qualitative | yes | 17/17 | 3 | 0 / 1 / 1 / 1 | $0.10 | 4.9 | - |
| q030 | Financial Modeling  Projections | yes | 2/2 | 5 | 0 / 1 / 3 / 1 | $0.20 | 4.2 | - |
| q031 | Financial Modeling  Projections | yes | 2/2 | 12 | 2 / 3 / 10 / 1 | $0.17 | 5.2 | - |
| q032 | Simple retrieval - Quantitative | yes | 3/3 | 8 | 1 / 2 / 6 / 1 | $0.12 | 4.8 | - |
| q033 | Adjustments | no | 0/3 | 8 | 1 / 2 / 6 / 1 | $0.15 | 5.3 | #0 $1.261 Billion Negative Impact to Net Income; #1 10.7% decrease in Net Income; #2 contradiction |
| q034 | Simple retrieval - Quantitative | yes | 4/4 | 11 | 0 / 1 / 9 / 1 | $0.14 | 4.9 | - |
| q035 | Adjustments | yes | 2/2 | 3 | 1 / 0 / 2 / 0 | $0.10 | 1.6 | - |
| q036 | Simple retrieval - Quantitative | yes | 5/5 | 5 | 4 / 0 / 4 / 0 | $0.15 | 1.8 | - |
| q037 | Simple retrieval - Quantitative | yes | 2/2 | 10 | 1 / 2 / 7 / 1 | $0.19 | 8.4 | - |
| q038 | Beat or Miss | yes | 2/2 | 13 | 3 / 7 / 11 / 1 | $0.25 | 5.3 | - |
| q040 | Adjustments | yes | 8/8 | 5 | 0 / 2 / 3 / 1 | $0.13 | 5.2 | - |
| q041 | Simple retrieval - Quantitative | yes | 2/2 | 5 | 1 / 0 / 3 / 1 | $0.11 | 4.7 | - |
| q042 | Market Analysis | no | 4/6 | 14 | 6 / 9 / 12 / 1 | $0.32 | 5.5 | #3 KHC: 0.70; #4 SJM: 0.59 |
| q043 | Financial Modeling  Projections | no | 7/10 | 7 | 2 / 1 / 6 / 0 | $0.15 | 0.7 | #5 Mobility segment growth: 25%; #6 Delivery segment growth: 17%; #7 Freight segment growth: 2% |
| q044 | Simple retrieval - Quantitative | yes | 2/2 | 3 | 0 / 1 / 1 / 1 | $0.09 | 5.3 | - |
| q045 | Adjustments | yes | 2/2 | 6 | 0 / 2 / 4 / 1 | $0.11 | 5.2 | - |
