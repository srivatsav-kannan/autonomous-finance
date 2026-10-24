# DABstep (external benchmark)

[DABstep](https://huggingface.co/datasets/adyen/DABstep) (Adyen + Hugging Face, [arXiv 2506.23719](https://arxiv.org/abs/2506.23719))
is a data-agent benchmark: multi-step questions over a synthetic payments dataset (`payments.csv`,
138k rows) plus a fee rulebook (`fees.json` with 1,000 rules, `manual.md`) and metadata for 30 merchants. This directory runs
its public **dev split** (10 tasks with answers: 3 easy, 7 hard) with Claude Opus 5.5 and scores the
answers with the benchmark's own scorer. Results: [`docs/evals/dabstep.md`](../../../docs/evals/dabstep.md)
and [`docs/evals/dabstep.json`](../../../docs/evals/dabstep.json).

## How it works

- `run.ts` (TypeScript, `@anthropic-ai/sdk` 1.3): one agent per task. The model runs Python/pandas in
  **Anthropic's server-side code execution sandbox** (`code_execution_20260521`); nothing the model
  writes executes on this machine. The seven context files are uploaded once with the Files API
  (`client.files.upload`, IDs cached in `var/dabstep/files.json`) and copied into each task's fresh
  container with `container_upload` blocks; inside the container they appear in `$INPUT_DIR`.
- Request: `claude-opus-5-5`, adaptive thinking (`display: "summarized"`), `output_config.effort: "high"`,
  no sampling parameters, no `tool_choice`, top-level automatic prompt caching, beta endpoint with
  server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"`),
  streamed. `pause_turn` (the server's 10-iteration loop limit) is resumed in the same container.
- Prompt: adapted from the DABstep baseline (`baseline/prompts.py` in the Space): Explore, Plan,
  Execute, Conclude; read `manual.md` and `payments-readme.md` in full first; "Not Applicable" only
  after exhausting all plans; the question followed by its answer-format guidelines. The final answer
  goes in `<final_answer>...</final_answer>`, which the runner parses (last occurrence).
- Limits per task-run: 8 requests or $1.50, after which a mid-conversation system message asks for
  the best final answer; one format reminder if the reply has no `<final_answer>` tag.
- Spend control: every request is appended to `var/dabstep/ledger.jsonl`; the runner will not send a
  request if the ledger plus a reserve for in-flight requests could exceed `--budget-usd`.
- `score.py` groups results into runs and calls the official `dabstep_benchmark.utils.evaluate`
  (vendored verbatim in `vendor/`, upstream tests included) once per run; it reports accuracy per
  level the way the leaderboard does, plus spread across runs, cost and wall time.

Raw outputs (gitignored): `var/dabstep/runs/<label>/{config.json,results.jsonl,transcripts/}`.

## Reproduce

```bash
# from the repo root; needs ANTHROPIC_API_KEY in .env.local (or the environment), Node, uv
bash evals/external/dabstep/fetch_data.sh ../benchdata/dabstep          # dataset + hash check

# optional: confirm the vendored scorer passes its upstream tests
(cd evals/external/dabstep/vendor && uv run --no-project --with pytest --with pandas \
   python -I -m pytest -q -p no:cacheprovider dabstep_benchmark/tests)

npx tsx evals/external/dabstep/run.ts --probe                            # where uploads land (~$0.03)
npx tsx evals/external/dabstep/run.ts --label pilot --task-ids 1681 --concurrency 1
npx tsx evals/external/dabstep/run.ts --label dev-x3 --runs 3 --concurrency 5 --budget-usd 15

uv run --no-project --with pandas python -I evals/external/dabstep/score.py \
  --tasks ../benchdata/dabstep/dev.jsonl \
  --results var/dabstep/runs/dev-x3/results.jsonl \
  --config var/dabstep/runs/dev-x3/config.json \
  --pilot var/dabstep/runs/pilot/results.jsonl \
  --ledger var/dabstep/ledger.jsonl \
  --reference evals/external/dabstep/reference.json \
  --out docs/evals/dabstep.json            # also prints the markdown tables used in dabstep.md
```

`run.ts` flags: `--data-dir` (default `../benchdata/dabstep`), `--split dev|all`, `--task-ids a,b`,
`--runs N`, `--effort`, `--concurrency`, `--budget-usd`, `--task-cap-usd`, `--max-requests`,
`--no-fallbacks`. Re-running the same `--label` skips finished task-runs and retries errored ones.
The `all` split has no public answers; scoring it means submitting to the leaderboard, which this
eval deliberately does not do.

Uploaded files persist in the Files API until deleted (`client.files.delete(id)` with the IDs in
`var/dabstep/files.json`).

## Licensing

DABstep data and the vendored scorer are CC BY 4.0 (c) 2025 Egg, Iglesias Goyanes, Mora, Kingma,
Wolf, von Werra; see `vendor/LICENSE` and `vendor/README.md`.
