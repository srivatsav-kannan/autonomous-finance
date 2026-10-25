# Invoice Sandbox Benchmark harness

Runs [ciru-ai/invoice-sandbox-benchmark](https://github.com/ciru-ai/invoice-sandbox-benchmark) (commit `b8cb58f`) with real Claude API calls (`claude-opus-5-5` only) and scores the output with the benchmark's own `scripts/score_submission.py`, plus extended metrics. Results: [`docs/evals/invoice-sandbox.md`](../../../docs/evals/invoice-sandbox.md) and `.json`.

Two systems get the same task text (`lib/task.ts`: the README's scoring contract and dataset rules) and the same output contract (`lib/submission.ts`):

- **System A, plain agent** (`system-a.ts`): one Claude agent with `list_dir`, `read_file` (PDFs come back as pypdf-extracted text, default 4,000 characters per call, max 20,000, pageable with `offset`) and `submit_results`. No code execution, no calculator, no domain helpers. Effort `high`, at most 40 turns, $5 cap per run.
- **System B, agent-native pipeline** (`system-b.ts`), deterministic first and the model for judgment:
  1. Claude extracts every PDF (primary pages through the totals block, plus any later-page lines that match review keywords) and every email into a strict zod schema with structured outputs (effort `low`). Extractions are cached on disk by (prompt version, model, effort, sample, document text), so rerunning a sample costs nothing and a new `--sample` gives an independent pass.
  2. Code checks each extraction against the source text (every amount must appear verbatim; line amounts must sum to the subtotal; subtotal - discount + tax must equal the total), resolves customers through the CRM alias table, applies the README rules (void, superseded original, duplicate scan, statement, credit memo, emails never count, bank deposits never count) and adds everything up in integer cents.
  3. Claude adjudicates only what the rules cannot settle (effort `high`, cached the same way): in practice the six invoices whose own `qty x unit price` does not equal the line amount.

The model only ever sees files inside `runs/<id>/workspace` (through `lib/workspace.ts`, which confines paths). The answer key and `scripts/` are read only by `score.py` after a run.

## Files

| File | Role |
|---|---|
| `setup_fixture.sh` | Clone the benchmark at the pinned commit, build its venv (+ pypdf), generate the fixture and verify it against the committed copy, or generate a fresh-seed fixture |
| `patches/seed-override.patch` | 2-line change to `generate_fixture.py`: `SEED` read from `INVOICE_SANDBOX_SEED` (default unchanged). Used only for the fresh-seed contamination check; no grading code touched |
| `extract_text.py` | pypdf text extraction of a run workspace into `runs/<id>/text_cache` (and `--compare` for the determinism check) |
| `run.ts` | One run: fresh workspace via the benchmark's `reset_env.py`, text extraction, System A or B, scoring |
| `system-a.ts`, `system-b.ts` | The two systems |
| `score.py` | Official scorer (output kept verbatim in `official_score.txt`) + per-field exactness, trap handling per `traps.json` document, false exclusions |
| `report.ts` | Aggregates all runs into `docs/evals/invoice-sandbox.json` and prints the markdown tables |
| `lib/llm.ts` | Claude calls: beta Messages endpoint, `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`, `output_config.effort`, adaptive thinking left at its default, no sampling parameters; spend ledger and hard cap; HTTP/1.1 transport (see below) |
| `smoke.ts` | Token counts and two tiny paid calls to check the request shape |

## Reproduce

From the `autonomous-finance` repo root. The API key is read from `.env.local` (`ANTHROPIC_API_KEY` only) and never printed. Every call is appended to `../benchdata/invoice-sandbox/ledger.jsonl`; the harness refuses new calls once the ledger total reaches `INVOICE_SANDBOX_HARD_CAP` (default $24.50).

```bash
# 1. Fixture (committed seed), with the determinism check against the committed answer key and PDFs
evals/external/invoice-sandbox/setup_fixture.sh

# 2. Runs on the original fixture (each run gets a fresh workspace from reset_env.py --fresh)
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-r1
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-r2
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-r3
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-r1 --sample 1
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-r2 --sample 2
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-r3 --sample 3

# 3. Contamination check: fresh fixture + answer key from a new seed, in a separate clone
evals/external/invoice-sandbox/setup_fixture.sh 20261024
export INVOICE_SANDBOX_DIR=../benchdata/invoice-sandbox-seed20261024
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-f1
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-f2
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-f1 --sample 1
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-f2 --sample 2
unset INVOICE_SANDBOX_DIR

# 4. Aggregate
npx tsx evals/external/invoice-sandbox/report.ts
```

Run ids must be unique across fixtures (the spend ledger is keyed by run id). Per-run artifacts land in `../benchdata/<bench dir>/runs/<id>/out/`: `submission.csv` (answer-key column layout), `suspicious_documents.{json,csv}`, `official_score.txt`, `score.json`, `run_meta.json`, plus `transcript.jsonl` (A) or `b_extractions.json` / `b_decisions.json` (B).

Typecheck: `npx tsc --noEmit -p evals/external/invoice-sandbox/tsconfig.json`.

## Notes

- **HTTP/1.1 transport.** Node 26's built-in fetch negotiates HTTP/2 with the API, and on this machine concurrent POSTs over that shared connection completed one at a time (six concurrent `count_tokens` calls finished ~130 ms apart; over HTTP/1.1 they finished together). `lib/llm.ts` therefore sends requests through an HTTP/1.1 undici Agent. Run `b-r1` predates this fix, so its wall time (615 s) reflects serialized calls; its outputs and score are unaffected.
- System B never sees later appendix pages except keyword-matching lines; System A can read any page and chose to read page 1 only.
- `run.ts --system b ... --offline` makes no API calls: it rebuilds B's output from cached extractions and adjudications and holds anything uncached for human review. It was used for the partial `b-f1` row after the API credit ran out (see the results doc for the resume commands). If the adjudicator errors out during a normal run, B also holds those documents for review instead of crashing.
- Costs are computed from `usage` at list prices ($4 / $20 per MTok input/output, $0.20 cache reads, $5 cache writes) and are estimates, not invoices.
