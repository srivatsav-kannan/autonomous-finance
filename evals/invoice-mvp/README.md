# Invoice workspace evaluation harness

This harness scores the invoice workspace (`src/invoice-mvp/`, `convex/invoiceCases.ts`) on the original Invoice Sandbox fixture and on a private held-out suite. It talks to the product only through its real HTTP gateway and persisted Convex snapshots.

**Status (2026-10-24):** the one approved OpenAI batch has run. Results, costs and limits are in [evaluation-openai-results.md](../../docs/invoice-mvp/evaluation-openai-results.md); the free deterministic results are in [evaluation-results.md](../../docs/invoice-mvp/evaluation-results.md). Do not repeat the completed paid commands or reset their ledger.

The protocol was frozen at `357866ec73dd8a643408e4a3b1ca4db6654e99b7` before the first scores; see [evaluation-protocol.md](../../docs/invoice-mvp/evaluation-protocol.md). `system-mvp.py` is the product adapter. Historical systems A, B and C in `evals/external/invoice-sandbox/` are unchanged.

## Prerequisites

- `uv` and Python 3.12, with `pypdf==6.21.2`.
- A private evaluator directory outside the repository, here `$EVAL_PRIVATE`. It holds the upstream checkout, the held-out sources and expectations, run outputs and any approval file. The held-out bytes are not committed; only their hashes are public. On a new host they must be copied through an evaluator-only channel. Implementation workers must not read them.
- Outputs must live outside the product checkout, and run and output directories cannot be reused.

```bash
EVAL_PRIVATE=/path/to/invoice-mvp-evaluation-private   # any private directory; never committed
EVAL_PYTHON="$EVAL_PRIVATE/.venv/bin/python"
EVAL_UPSTREAM="$EVAL_PRIVATE/upstream"

git clone https://github.com/ciru-ai/invoice-sandbox-benchmark.git "$EVAL_UPSTREAM"
git -C "$EVAL_UPSTREAM" checkout b8cb58ff9747486e86c623e867b76fad5d8d075f
uv venv --python 3.12 "$EVAL_PRIVATE/.venv"
uv pip install --python "$EVAL_PYTHON" pypdf==6.21.2
```

## Free deterministic run

The default `run.py` path is free. It rejects `live_model` and `mock_model` runtime attestations before touching the product.

```bash
# Choose a new reset ID each time; --fresh refuses to overwrite.
"$EVAL_PYTHON" -I "$EVAL_UPSTREAM/scripts/reset_env.py" --run-id mvp-original-001 --fresh
"$EVAL_PYTHON" -I evals/external/invoice-sandbox/extract_text.py \
  "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache"
"$EVAL_PYTHON" evals/external/invoice-sandbox/system-mvp.py prepare \
  --upstream "$EVAL_UPSTREAM" \
  --workspace "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  --text-cache "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache" \
  --out "$EVAL_PRIVATE/prepared-original-001"
```

`verify_upstream` checks the Git revision, README and scorer hashes, fixture bytes and grading keys. Preparation includes all 148 reset-workspace files with original base64 and normalized text. Encoded PDFs exceed Convex's single-document limit, so sources are imported in chunks (2,000,000 bytes by default); none are dropped.

Start the backend and invoice gateway in deterministic mode with a new, empty company and run ([startup guide](../../docs/invoice-mvp/STARTUP.md)). Record the clean commit the runtime attests. The adapter gets a session cookie from `GET /api/invoice-mvp/workspace` and posts with `X-Invoice-MVP-Session: 1` and `Origin: http://127.0.0.1:8790` (`--origin` selects another allowed origin). No backend token enters the adapter.

```bash
EVAL_APP_COMMIT=REPLACE_WITH_EXACT_COMMIT
"$EVAL_PYTHON" evals/external/invoice-sandbox/system-mvp.py run \
  --upstream "$EVAL_UPSTREAM" \
  --workspace "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  --text-cache "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache" \
  --run-id mvp-original-001 --app-commit "$EVAL_APP_COMMIT" --cohort first-pass \
  --out "$EVAL_PRIVATE/runs/mvp-original-001"

# Score in a separate process; never send private details back to the app.
"$EVAL_PYTHON" evals/invoice-mvp/score.py \
  --run "$EVAL_PRIVATE/runs/mvp-original-001" --upstream "$EVAL_UPSTREAM" \
  --out "$EVAL_PRIVATE/scores/mvp-original-001"
```

The adapter does not interpret documents or compute totals: CSV fields come from persisted `CustomerTotal` rows. Strict metrics check all four fields to the cent, duplicate, missing and extra customers, expected inclusions and exclusions, and structural support. `official_score.txt` is the unmodified upstream scorer output.

## Held-out suite and restart check

Start a separate empty runtime and company. No human answers are supplied. The suite imports in order: initial evidence, a duplicate, an explicit revision, late evidence. Outputs are sealed before scoring. `--cohort post-fix` labels later product revisions.

```bash
"$EVAL_PYTHON" evals/invoice-mvp/run.py run \
  --suite "$EVAL_PRIVATE/heldout-v1/sources.json" --run-id mvp-heldout-001 \
  --app-commit "$EVAL_APP_COMMIT" --cohort first-pass \
  --out "$EVAL_PRIVATE/runs/mvp-heldout-001"
"$EVAL_PYTHON" evals/invoice-mvp/score.py \
  --run "$EVAL_PRIVATE/runs/mvp-heldout-001" \
  --expectations "$EVAL_PRIVATE/heldout-v1/expectations.json" \
  --out "$EVAL_PRIVATE/scores/mvp-heldout-001"
```

Then restart both gateway and backend with the run state intact, write a private attestation (`gatewayRestarted: true`, `backendRestarted: true`, `operator`, `restartedAt`, `command`), and compare before doing more work:

```bash
"$EVAL_PYTHON" evals/invoice-mvp/run.py compare-restart \
  --before "$EVAL_PRIVATE/runs/mvp-heldout-001" \
  --attestation "$EVAL_PRIVATE/restart-attestation.json" \
  --out "$EVAL_PRIVATE/restart/mvp-heldout-001"
```

This checks persisted case and proposal pointers, totals, effects and recorded decisions. Restarting only an HTTP client is not a restart check.

## Paid live runs

This section was `LIVE.md`. Paid runs need a recorded approval; credentials alone never authorize spending.

- **Approval file.** Copy `authorization.openai.example.json` (or the older Claude `authorization.example.json`) into `$EVAL_PRIVATE`, record the approval reference and a future expiry, set `authorized: true` only after approval, and set `ledgerPath` to one absolute private path. The examples ship with `authorized: false`, an unusable expiry and a placeholder ledger, so neither runner can spend with them. Pricing provenance is in `pricing-provenance.openai.json` and `pricing-provenance.json`.
- **Budget.** Each run's envelope is a persistent limit; their sum is checked before use. `budget.py` uses an exclusive lock, atomic replacement and fsync. A different ledger path, changed authorization, reused envelope, expired authorization or replayed request is rejected. Never copy or reset the ledger to get more budget.
- **Baseline.** Before every request, it reserves an input bound and the full output allowance; a validated response settles to actual usage. Transport failures, bad or missing usage, an unexpected model, cache use or interruption keep the conservative charge. There are no retries.
- **App.** The app runner prepays its whole envelope before import. The product also reserves each request atomically across processes and restarts, sends `live: true` only on explicit processing calls, and never auto-accepts model proposals. App reservations stay charged at their maximum after success, unlike the baseline. Each live case has an HTTP timeout of `maxTurns × 30 s + 60 s`, and a case starts only if that fits in the run deadline.

```bash
EVAL_AUTH="$EVAL_PRIVATE/approved-batch.json"
EVAL_LEDGER="$EVAL_PRIVATE/approved-batch-ledger.json"
EVAL_WORKSPACE="$EVAL_UPSTREAM/runs/mvp-preparation-v1/workspace"
EVAL_TEXT="$EVAL_UPSTREAM/runs/mvp-preparation-v1/text_cache"

node_modules/.bin/tsx evals/invoice-mvp/baseline.ts --allow-live \
  --authorization "$EVAL_AUTH" --ledger "$EVAL_LEDGER" --run-id baseline-original \
  --python "$EVAL_PYTHON" --upstream "$EVAL_UPSTREAM" \
  --workspace "$EVAL_WORKSPACE" --text-cache "$EVAL_TEXT" \
  --out "$EVAL_PRIVATE/live/baseline-original"
"$EVAL_PYTHON" evals/invoice-mvp/score_baseline.py \
  --run "$EVAL_PRIVATE/live/baseline-original" --upstream "$EVAL_UPSTREAM" \
  --out "$EVAL_PRIVATE/live-scores/baseline-original"

# Each app run needs a fresh empty product workspace with live opt-in and caps matching the approval.
EVAL_ORIGIN=http://127.0.0.1:8796
"$EVAL_PYTHON" evals/invoice-mvp/live_app.py --allow-live \
  --authorization "$EVAL_AUTH" --ledger "$EVAL_LEDGER" --run-id app-original \
  --app-commit "$EVAL_APP_COMMIT" --cohort first-pass \
  --base-url "$EVAL_ORIGIN" --origin "$EVAL_ORIGIN" \
  --upstream "$EVAL_UPSTREAM" --workspace "$EVAL_WORKSPACE" --text-cache "$EVAL_TEXT" \
  --out "$EVAL_PRIVATE/live/app-original"
"$EVAL_PYTHON" evals/invoice-mvp/score.py \
  --run "$EVAL_PRIVATE/live/app-original" --upstream "$EVAL_UPSTREAM" \
  --out "$EVAL_PRIVATE/live-scores/app-original"

# Held-out live run: a second empty workspace with the held-out envelope.
EVAL_ORIGIN=http://127.0.0.1:8797
"$EVAL_PYTHON" evals/invoice-mvp/live_app.py --allow-live \
  --authorization "$EVAL_AUTH" --ledger "$EVAL_LEDGER" --run-id app-heldout \
  --app-commit "$EVAL_APP_COMMIT" --cohort post-fix \
  --base-url "$EVAL_ORIGIN" --origin "$EVAL_ORIGIN" \
  --suite "$EVAL_PRIVATE/heldout-v1/sources.json" --out "$EVAL_PRIVATE/live/app-heldout"
"$EVAL_PYTHON" evals/invoice-mvp/score.py \
  --run "$EVAL_PRIVATE/live/app-heldout" --expectations "$EVAL_PRIVATE/heldout-v1/expectations.json" \
  --out "$EVAL_PRIVATE/live-scores/app-heldout"
```

App runtime settings: `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, `INVOICE_MVP_PROVIDER=openai` (with `OPENAI_API_KEY`), `INVOICE_MVP_MAX_MODEL_CALLS`, `INVOICE_MVP_MAX_COST_MICROS`, `INVOICE_MVP_MAX_INPUT_TOKENS`, `INVOICE_MVP_MAX_OUTPUT_TOKENS`, `INVOICE_MVP_OUTPUT_TOKENS_PER_CALL`, `INVOICE_MVP_INPUT_TOKEN_MICROS`, `INVOICE_MVP_OUTPUT_TOKEN_MICROS`. Backend seat credentials stay server-side.

Baseline and app still differ in tools, retrieval, per-case orchestration, human acceptance, output limits and reservation accounting. Using the same bytes and model does not make this a controlled agent-count experiment. No reviewer is implemented.

## No-network tests

```bash
INVOICE_MVP_UPSTREAM="$EVAL_UPSTREAM" "$EVAL_PYTHON" -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v
node_modules/.bin/tsx --test evals/invoice-mvp/capped-llm.node-test.ts evals/invoice-mvp/openai-responses.node-test.ts
node_modules/.bin/tsc --noEmit -p evals/invoice-mvp/tsconfig.json
```

Tests use injected transports and synthetic authorization; no credential is read and no provider is called. They cover concurrent cap enforcement, crash charges, repeated requests and envelopes, changed ledger paths, unauthorized or expired runs, wrong served models, missing usage, disabled defaults and baseline prompt, tool and loop parity. These tests are not part of `npm test` or CI (AUDIT P2-25).
