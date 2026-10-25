# FinBalance with Claude Opus 5.5

Runs the FinBalance accounting-reconciliation benchmark
([arXiv 2606.15949](https://arxiv.org/abs/2606.15949), EMNLP 2026 Findings;
[github.com/Devansh1105/finbalance](https://github.com/Devansh1105/finbalance), Apache-2.0 code,
CC BY 4.0 data) against `claude-opus-5-5` with real API calls. Results and the comparison with
the paper's six models are in [`docs/evals/finbalance.md`](../../../docs/evals/finbalance.md);
raw metrics are in [`docs/evals/finbalance.json`](../../../docs/evals/finbalance.json).

Each FinBalance record is a bundle of OCR'd source documents (invoices, bank statements, payment
advices, schedules, contracts, tax certificates, distractors). The model returns strict JSON:
balanced journal entries with supporting `doc_refs`, the final balance sheet, and an
inconsistency flag plus code when the documents contradict each other.

## Files

| File | Purpose |
|---|---|
| `anthropic_client.py` | Claude adapter implementing the harness's `ChatClient` protocol, plus the spend ledger and hard budget cap |
| `run_finbalance.py` | `select` builds the stratified sample; `run` evaluates an ablation spec with N workers, checkpointing and resume |
| `analyze_finbalance.py` | Headline metrics, bootstrap CIs, per-slice tables, the paired ledger-feedback bootstrap and the paper comparison, written as JSON |
| `sample_main_seed42.json` | The evaluated sample: 120 standard and 58 negative-control record IDs from `data/main`, plus the 40-record ledger-feedback subset |
| `sample_fresh_seed20260712_seed42.json` | Contamination check 1: 60 standard and 29 negative records from the authors' second split, `data/fresh_seed_20260712/main` |
| `sample_new_seed20261024_seed42.json` | Contamination check 2: 30 standard and 14 negative records from a split generated here with seed 20261024 |
| `pilot_ids.json` | The three pilot records |

Nothing in the upstream checkout is modified. The prompt (`build_prompt`), the per-record loop
including the ledger-feedback protocol (`run_ablation_evaluation`), the parser, the scorer
(`analyze_submission`), the summaries and the output layout all come from the upstream package.
The wrapper adds the Claude client, runs one `run_ablation_evaluation([record])` call per worker
and record, and re-assembles the official `evaluation.json` / `summary.json` /
`per_record_results.jsonl` / `slice_tables/` for the whole run.

## Reproduce

Requires `uv` and an Anthropic API key. Raw outputs are large, so they go in the FinBalance
checkout's git-ignored `results/` folder, outside this repo.

```bash
export FB="$PWD/../benchdata/finbalance"   # run from the repo root; any fresh directory
export ENVFILE="$PWD/.env.local"  # holds ANTHROPIC_API_KEY
cd evals/external/finbalance

# 0. Harness at the pinned commit, with Python 3.12 (the system Python is 3.14)
git clone https://github.com/Devansh1105/finbalance.git "$FB"
git -C "$FB" checkout a1062b7b392eaf53311308c2f63cf748b68bb8cf
(cd "$FB" && uv venv --python 3.12 && uv sync --python 3.12)   # the lockfile pins anthropic==0.86.0

# 1. Deterministic stratified sample (rewrites sample_main_seed42.json identically)
"$FB/.venv/bin/python" run_finbalance.py select --dataset "$FB/data/main/records.jsonl" \
  --per-cell 8 --negatives 58 --ablation-standard 32 --ablation-negatives 8 --seed 42 \
  --output sample_main_seed42.json

COMMON=(--dataset "$FB/data/main/records.jsonl" --model claude-opus-5-5 --effort medium
        --max-output-tokens 32000 --budget-cap 39 --ledger "$FB/results/opus55_spend_ledger.jsonl"
        --env-file "$ENVFILE")

# 2. Pilot: 3 records (L1 month, L3 quarter, L5 year) to measure tokens and cost
"$FB/.venv/bin/python" run_finbalance.py run "${COMMON[@]}" --record-ids-file pilot_ids.json \
  --ablation prompt_baseline --output-dir "$FB/results/opus55_pilot" --concurrency 3

# 3. Baseline on the 178-record sample (resumable: rerun the same command after an interruption)
"$FB/.venv/bin/python" run_finbalance.py run "${COMMON[@]}" --record-ids-file sample_main_seed42.json \
  --ablation prompt_baseline --output-dir "$FB/results/opus55_main_sample" --concurrency 4

# 4. Forced ledger-feedback ablation on the 40-record subset, written next to the baseline
#    so the upstream paired bootstrap matches records by ID
"$FB/.venv/bin/python" run_finbalance.py run "${COMMON[@]}" --record-ids-file sample_main_seed42.json \
  --record-ids-key ablation_record_ids --ablation forced_ledger_verifier \
  --output-dir "$FB/results/opus55_main_sample" --concurrency 4

# 5. Contamination check 1: the authors' second split (seed 20260712, committed 2026-08-28)
"$FB/.venv/bin/python" run_finbalance.py select --dataset "$FB/data/fresh_seed_20260712/main/records.jsonl" \
  --per-cell 4 --negatives 29 --ablation-standard 0 --ablation-negatives 0 --seed 42 \
  --output sample_fresh_seed20260712_seed42.json
"$FB/.venv/bin/python" run_finbalance.py run "${COMMON[@]}" \
  --dataset "$FB/data/fresh_seed_20260712/main/records.jsonl" --record-ids-file sample_fresh_seed20260712_seed42.json \
  --ablation prompt_baseline --output-dir "$FB/results/opus55_fresh_seed_sample" --concurrency 4

# 6. Contamination check 2: a never-published split from the repo's own generator (same
#    construction as data/main: 4 records per industry x period x level cell, 10 per code)
export NEW="$(dirname "$FB")/finbalance_fresh_seed20261024"
(cd "$FB" && .venv/bin/python scripts/generate_standard_datasets.py --base-dir "$NEW" --seed 20261024 \
  --records-per-combo 4 --negative-controls-per-code 10)
(cd "$FB" && .venv/bin/python scripts/audit_structural_invariants.py "$NEW/main/records.jsonl")  # 710/710 pass
"$FB/.venv/bin/python" run_finbalance.py select --dataset "$NEW/main/records.jsonl" \
  --per-cell 2 --negatives 14 --ablation-standard 0 --ablation-negatives 0 --seed 42 \
  --output sample_new_seed20261024_seed42.json
"$FB/.venv/bin/python" run_finbalance.py run "${COMMON[@]}" \
  --dataset "$NEW/main/records.jsonl" --record-ids-file sample_new_seed20261024_seed42.json \
  --ablation prompt_baseline --output-dir "$FB/results/opus55_new_seed20261024_sample" --concurrency 4

# 7. Metrics, CIs, paired bootstrap, contamination comparison, paper comparison
"$FB/.venv/bin/python" analyze_finbalance.py --results-root "$FB/results/opus55_main_sample" \
  --ledger "$FB/results/opus55_spend_ledger.jsonl" --sample-file sample_main_seed42.json \
  --dataset "$FB/data/main/records.jsonl" \
  --check "Authors' fresh seed 20260712" "$FB/results/opus55_fresh_seed_sample" sample_fresh_seed20260712_seed42.json \
    "data/fresh_seed_20260712 shipped in the repo; first committed 2026-08-28, after the model's June 2026 training cutoff" \
  --check "New seed 20261024 (generated here)" "$FB/results/opus55_new_seed20261024_sample" sample_new_seed20261024_seed42.json \
    "generated for this run with scripts/generate_standard_datasets.py --seed 20261024; never published" \
  --output-json ../../../docs/evals/finbalance.json --tables-md /tmp/finbalance_tables.md

# Optional: the upstream paired-bootstrap CLI gives the same ledger-feedback table
(cd "$FB" && .venv/bin/python -m finbalance analyze-ablations \
  --results-dir results/opus55_main_sample --baseline prompt_baseline --iterations 5000)
```

The key is read from `ANTHROPIC_API_KEY` if exported, otherwise from `--env-file`. It is never
printed or written anywhere. `--budget-cap` is checked against the cumulative spend ledger before
every call. Each call reserves a worst-case cost (its input plus `max_tokens` of output), so
concurrent workers cannot overshoot the cap. Hitting the cap raises an error with
`status_code=402`, which the upstream runner treats as fatal: it stops and checkpoints.
`--retry-api-errors` re-runs only rows where no completion came back (transport or API failure).
It never re-runs a model's unparseable answer.

## Adapter: what differs from the upstream OpenRouter client

Upstream ships only an OpenAI-compatible chat-completions client, so there was no Anthropic
adapter to patch. `anthropic_client.py` is a new client with the same interface. Every place it
departs from the paper's request settings:

| Setting | Paper (OpenRouter / DeepSeek) | Here | Why |
|---|---|---|---|
| `temperature` | 0.0 | not sent | Opus 5.5 returns a 400 for temperature, top_p and top_k |
| Reasoning | none for 4 models; GPT-5 effort `low`; Grok reasoning on | `thinking={"type":"adaptive"}`, `output_config={"effort":"medium"}` | Thinking cannot be disabled on Opus 5.5 (`disabled` and `budget_tokens` both return 400); effort is the only control |
| `max_tokens` | 8k to 32k per model | 32,000 (covers thinking plus answer) | Matches the paper's largest (GPT-5) budget; no call hit it |
| Transport | non-streaming chat completions | streaming `messages.stream(...).get_final_message()` | Avoids HTTP timeouts on long thinking |
| Retries | client retries on 429/5xx, at most 3 | SDK `max_retries=4`, plus at most 2 retries after a stream breaks on 408/409/429/5xx/529 or a connection error | The SDK does not retry a stream that fails after it has started |
| Cost | provider-billed `usage.cost` | computed from usage at $4 / $20 / $0.20 per M input / output / cache-read tokens (cache write $5 per M) | The Messages API returns tokens, not dollars |
| Prompt caching | none | baseline: none. Ledger-feedback ablation only: one `cache_control` breakpoint on the first user message | The revision turn resends the whole record prompt. The model sees the same tokens; only billing changes |
| Refusal fallback | n/a | not enabled | A fallback model would answer some records, so results would no longer be Opus 5.5's alone |

In the ledger-feedback ablation the harness sends prior assistant turns as plain text, so thinking
blocks from the draft turn are not replayed. That is the same information other models got under
the paper's protocol (chat-completions history carries no reasoning).
