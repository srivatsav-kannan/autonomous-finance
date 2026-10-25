# DABstep dev split: Claude Opus 5.5 with sandboxed code execution

Run on 2026-10-24. Machine-readable results, including every answer, cost and timing for each
task-run: [`dabstep.json`](dabstep.json). Harness and reproduction steps:
[`evals/external/dabstep/`](../../evals/external/dabstep/README.md).

**Read this first.** The dev split is 10 public tasks (3 easy, 7 hard) whose answers are published.
It is meant for checking a harness before a leaderboard submission. These numbers are **not
comparable** to the leaderboard or the paper, which score all 450 tasks against hidden answers.
Nothing was submitted to the leaderboard.

## Result

Three independent runs over all 10 dev tasks. Each task-run used a fresh container. Scoring used
the official DABstep scorer (`dabstep_benchmark.utils.evaluate`), vendored unchanged.

| Level | Tasks | Run 1 | Run 2 | Run 3 | Mean ± SD over runs |
|---|---|---|---|---|---|
| Easy | 3 | 2/3 | 2/3 | 3/3 | **77.8% ± 19.2** |
| Hard | 7 | 6/7 | 6/7 | 6/7 | **85.7% ± 0.0** |
| Overall | 10 | 8/10 | 8/10 | 9/10 | **83.3% ± 5.8** |

SD is the sample standard deviation across the 3 runs. With so few tasks, one task moves easy
accuracy by 33 points and hard accuracy by 14 points. A 6/7 result on hard has a Wilson 95%
interval of roughly 49% to 97%. Six of the 7 hard tasks were solved in every run, and one was
missed in every run. Two easy tasks were solved in every run; the third was solved in 1 of 3 runs.

| Run | Easy (n=3) | Hard (n=7) | Overall (n=10) | Token cost | Sum of task wall time |
|---|---|---|---|---|---|
| 1 | 2/3 (66.7%) | 6/7 (85.7%) | 8/10 (80.0%) | $0.99 | 13.2 min |
| 2 | 2/3 (66.7%) | 6/7 (85.7%) | 8/10 (80.0%) | $0.74 | 18.2 min |
| 3 | 3/3 (100.0%) | 6/7 (85.7%) | 9/10 (90.0%) | $0.71 | 19.4 min |

### Answers vs ground truth

Long lists are truncated here; full answers are in `dabstep.json`. "pass" means the official
`question_scorer` accepted the answer.

| Task | Level | Ground truth | Run 1 | Run 2 | Run 3 | Correct |
|---|---|---|---|---|---|---|
| 5 | easy | `NL` | `NL` pass | `NL` pass | `NL` pass | 3/3 |
| 49 | easy | `B. BE` | `B. BE` pass | `B. BE` pass | `B. BE` pass | 3/3 |
| 70 | easy | `Not Applicable` | `yes` FAIL | `yes` FAIL | `Not Applicable` pass | 1/3 |
| 1273 | hard | `0.120132` | `0.120132` pass | `0.120132` pass | `0.120132` pass | 3/3 |
| 1305 | hard | `0.123217` | `0.123217` pass | `0.123217` pass | `0.123217` pass | 3/3 |
| 1464 | hard | `1, 2, 5, 6, 8, 9, 10, 12, ...` (416 IDs) | same set, pass | same set, pass | same set, pass | 3/3 |
| 1681 | hard | `741, 709, 454, 813, 381, ...` (10 IDs) | same set, pass | same set, pass | same set, pass | 3/3 |
| 1753 | hard | `384, 394, 276, 150, 536, ...` (34 IDs) | same set, pass | same set, pass | same set, pass | 3/3 |
| 1871 | hard | `-0.94810300000017` | `-0.948103` pass | `-0.948103` pass | `-0.948103` pass | 3/3 |
| 2697 | hard | `E:13.57` | `B:77.87` FAIL | `B:77.87` FAIL | `B:77.87` FAIL | 0/3 |

All 25 passes are also exact matches: identical strings, identical sets for the ID lists, or the
same number up to floating-point noise (task 1871's reference `-0.94810300000017` differs from
`-0.948103` by 1.7e-13). No pass relied on the scorer's lenient rules, which are described under
Caveats.

### What failed

- **Task 2697 (hard), 0/3.** The question asks which ACI to steer Belles_cookbook_store's fraudulent
  January transactions to, for the lowest fees, answered as `{ACI}:{fee}`. All three runs re-priced
  the 94 fraudulent transactions under each ACI and found that for D, E and F, 50 to 64 of the 94
  had no matching fee rule. The model treated those options as unpriceable and chose B at €77.87.
  It noted that E would be cheapest (€41.66) if unmatched transactions counted as free. The
  reference is `E:13.57`, so the reference also computes the fee differently, not only the
  coverage choice. The same answer came back in all three runs.
- **Task 70 (easy), 1/3.** "Is Martinis_Fine_Steakhouse in danger of getting a high-fraud rate
  fine?" The reference is `Not Applicable`, because the manual defines no fine for fraud. Runs 1
  and 2 found a 9.1% fraud rate, above the top `>8.3%` fee band, and answered `yes` while noting
  that the manual gives no cut-off. Run 3 answered `Not Applicable` for that reason. This is the
  benchmark's "abstain when the documents don't support an answer" trap, and the model's judgment
  varied between runs.
- **No infrastructure failures.** All 30 task-runs ended normally with a parsed `<final_answer>`.
  There were no API errors, no refusals, no server-side fallbacks, no format reminders and no step
  limits. Every task finished in a single API request with no `pause_turn`, using 2 to 5
  code-execution calls (mean 2.8). Every run first printed `manual.md` and `payments-readme.md` in
  full, as the prompt instructs.

## Setup

- **Data:** `adyen/DABstep` dataset revision `0545553f02ce` (CC BY 4.0): `data/tasks/dev.jsonl`
  (sha256 `c1da755a...`) and the 7 context files. `payments.csv` has 138,236 rows; `fees.json` has
  1,000 rules. Hashes are checked by `evals/external/dabstep/fetch_data.sh`.
- **Model and request:** `claude-opus-5-5` on the beta Messages endpoint with
  `betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"`; adaptive thinking
  (`display: "summarized"`); `output_config.effort: "high"`; no temperature, top_p or top_k; no
  `tool_choice`; `max_tokens` 64,000; streamed; top-level automatic prompt caching.
  `@anthropic-ai/sdk` 1.3.0.
- **Sandbox:** Anthropic's server-side code execution tool `code_execution_20260521`. The context
  files were uploaded once with `client.files.upload` and attached to each task's first message as
  `container_upload` blocks; they appear in the container at `$INPUT_DIR`. No model-written code ran
  on the laptop.
- **Prompt:** the DABstep baseline's reasoning-agent prompt (`baseline/prompts.py` in the Space),
  adapted to this tool. It keeps the Explore, Plan, Execute, Conclude workflow and the rules,
  including "Not Applicable only after exhausting all plans". It adds an instruction to read
  `manual.md` and `payments-readme.md` in full first, and to put only the guideline-formatted answer
  in `<final_answer></final_answer>`, which the runner parses. The user turn is the question
  followed by its guidelines. The exact text is in `dabstep.json` under `config`.
- **Limits:** 8 requests or $1.50 per task-run, then a system message asks for a final answer, plus
  one format reminder if no tag is present. Neither limit triggered.
- **Order:** probe (where uploads land) → 1-task pilot (task 1681: correct, $0.12, 24 s) → 3 runs of
  all 10 tasks at concurrency 5. The prompt did not change between the pilot and the runs. The pilot
  is kept in `dabstep.json` under `pilot` and is not part of the 3-run statistics.

## Cost and time

| Item | USD |
|---|---|
| 3 runs × 10 tasks, tokens | 2.44 |
| 3 runs × 10 tasks, code-execution container time (upper bound) | 0.125 |
| Pilot (1 task, incl. container bound) | 0.12 |
| Probe (1 request) | 0.03 |
| **Total spent** (per-request ledger, `var/dabstep/ledger.jsonl`) | **2.72** of the $15 budget |

- Prices are Opus 5.5 list prices: $4/M input, $20/M output, $0.20/M cache read, $5/M 5-minute cache
  write. Each task-run cost $0.081 on average ($0.013 to $0.146), and each 10-task run cost $0.71 to
  $0.99.
- Tokens across the 3 runs: 286 uncached input, 44,990 output, 927,421 cache reads and 271,402 cache
  writes. Cache writes cost the most ($1.36), then output ($0.90), then cache reads ($0.19). Prompt
  caching worked inside the server-side tool loop.
- **Container time:** code execution without web tools bills $0.05 per container-hour beyond the
  organization's 1,550 free hours per month, with a 5-minute minimum per container. 30 containers ×
  5 minutes = 2.5 h, or at most $0.125, which is likely $0 inside the free hours. The probe's
  container (at most $0.004) is not in the ledger.
- **Wall time:** 11.2 minutes for all 30 task-runs at concurrency 5. The median task-run took 109 s
  (11 to 144 s). The pilot ran alone in 24 s, so per-task times at concurrency 5 include waiting.
  Treat them as upper bounds.

## Comparison (for orientation only)

| Source | Tasks scored | Easy | Hard |
|---|---|---|---|
| **This run**: Opus 5.5, server-side code execution, mean of 3 runs | 10 public dev tasks (3 / 7) | 77.8% | 85.7% |
| Paper's best baseline: o4-mini, reasoning prompt (arXiv 2506.23719 v1, Table 1) | 450 hidden (72 / 378) | 76.39% | 14.55% |
| Validated leaderboard #1: NVIDIA KGMON Data Explorer (claude haiku 4.5), 2026-02-22 | 450 hidden | 87.50% | 89.95% |
| Validated leaderboard #2: DataPilot (Qwen3), 2025-12-09 | 450 hidden | 86.11% | 87.57% |
| Validated #5: DS-STAR, Google Cloud AI Research (Gemini 2.5 Pro), 2025-07-08 | 450 hidden | 87.50% | 45.24% |
| Claude 4 Sonnet ReAct baseline (Hugging Face), 2025-05-28 | 450 hidden | 81.94% | 19.84% |

Sources: the [paper](https://arxiv.org/abs/2506.23719) and the
[leaderboard Space](https://huggingface.co/spaces/adyen/DABstep). The leaderboard tables were read
from `adyen-dabstep.hf.space/config` (Space revision `d4431c2e`) on 2026-10-24. Reference values
are in `evals/external/dabstep/reference.json`. The unvalidated board (2,245 entries) has 17
entries at 100% hard, including one named "test gold", so it is not informative. The Space says
validation is closed ahead of DABstep-v2, so the validated board is the meaningful reference.

### Caveats

1. **10 tasks, not 450.** The dev split has 3 easy and 7 hard tasks; the leaderboard scores 72 easy
   and 378 hard. The dev tasks are also not a random sample: all 7 hard tasks are fee-rule
   questions, and 4 of them concern one merchant (Belles_cookbook_store). A dev score says little
   about the hidden-set score. The 85.7% hard result should not be read as competitive with
   the 89.95% leaderboard leader.
2. **Public answers.** The dev answers are published on Hugging Face and could be in any recent
   model's training data. The hidden-set protocol exists to rule this out, and the dev
   split cannot.
3. **Different harness.** Leaderboard entries use their own agents and prompts; the paper's
   baselines used smolagents with a 10-step cap. This run used Anthropic's code execution sandbox,
   Opus 5.5 at high effort, and our own prompt adaptation.
4. **Lenient scorer.** The official `question_scorer` accepts numbers below 1 within 1e-4 absolute
   (`0.1202` matches `0.120132`), drops the minus sign when it extracts numbers (`0.948103` matches
   `-0.94810300000017`), and compares only the number in `X:fee` answers (`B:13.57` would match
   `E:13.57`). We report the official score. As noted above, none of our passes relied on these
   rules.
5. **Not submitted.** Scoring the 450-task split requires submitting to the public leaderboard,
   which would publish results and was not authorized. We made no attempt to infer hidden answers
   from other submissions.

## Deviations from the brief and the baseline

- The baseline runs a smolagents `CodeAgent` with a local Python executor capped at 10 steps. This
  run used Anthropic's server-side container instead. It was capped at 8 requests, each allowing up
  to the server's 10 tool iterations, or $1.50 per task. No task came close.
- The baseline's prompt ends with "If you solve the task correctly, you will receive a reward of
  $1,000,000." We dropped that line. We replaced the baseline's `final_answer()` tool with
  `<final_answer>` tags, and we added the container file location and the instruction to read the
  two documentation files in full.
- Server-side fallbacks were enabled as requested and never triggered: every response was served by
  `claude-opus-5-5`.
- The pilot task (1681) was chosen as a mid-complexity hard task, to keep the cost estimate from
  coming out low.

## Raw artifacts

These are gitignored, under `var/dabstep/`: `runs/dev-x3/{config.json,results.jsonl,transcripts/*.json}`
(full message histories including code, outputs and thinking summaries), `runs/pilot/`,
`ledger.jsonl` (one line per API request, with cost) and `files.json` (Files API IDs for the
uploaded context files, which persist until deleted).
