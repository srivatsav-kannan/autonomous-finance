# Capped live comparison: prepared, NOT RUN

No credential or spending permission is present. This document is a reproducible preparation record, not authorization. `authorization.example.json` deliberately contains `authorized: false`, an unusable expiry, and a placeholder ledger path. Neither runner can execute a paid request with that file. Required credential name only: `ANTHROPIC_API_KEY`.

## Proposed single approval

One batch, **at most $7.50 total**: one original-fixture baseline A run (40 requests, $3, 20 minutes), one original-fixture actual MVP run (160 requests, $3, 30 minutes), and one held-out actual MVP run (64 requests, $1.50, 20 minutes). Budget exhaustion may yield partial results; it is not permission to extend the budget. Model is `claude-opus-5-5` for all three. No reviewer is implemented.

The official [model overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) and [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) were checked on 2026-10-24: standard input/output pricing is $4/$20 per million tokens. `pricing-provenance.json` records the model and sources. Authorization must carry that same provenance and non-lower rates. It expires, and pricing verification older than seven days is refused. Fast mode, caching, Batch API, fallbacks, and automatic SDK retries are disabled. Actual served model must match the approved model. Pricing remains an estimate rather than a billing invoice.

The requested $7.50 envelopes are independent persistent limits whose sum is checked before use. Both runners must use the single absolute ledger path bound into the approved authorization. A different ledger path, changed authorization, reused application envelope, expired authorization, or replayed baseline request is rejected. `budget.py` uses an exclusive advisory lock, atomic replacement and fsync. Never copy/reset the ledger to obtain more budget.

Before every baseline request, UTF-8 request bytes plus a 4,096-token protocol allowance bound input tokens; all 64,000 permitted output tokens are reserved. Historical A's prompt, schema, tools, source access, and agent loop are unchanged; a source-equality test enforces that claim. Only its transport is replaced. On a validated successful response the reservation settles to observed usage. On transport failure, invalid/missing usage, unexpected model/cache/fallback, or interruption, the conservative charge remains. There are no automatic retries. Malformed final output still incurs its recorded actual provider usage. This conservative guard can stop earlier than historical A's accrued-cost guard.

The app runner prepays its entire run envelope before import. The product enforces atomic persistent per-request reservation separately, across processes and restarts. The app adapter sends `live: true` only on explicit processing calls, never runs a substitute investigator, and never auto-accepts model proposals. It requires real runtime commit/model/budget/telemetry attestation and reads actual persisted `model_reservation`/`model_usage` audit records. Missing usage stays unknown and prevents a complete scored live result. App reservations currently remain charged at their maximum after success; this differs from baseline reconciliation and must be reported. Live application processing uses a per-case HTTP timeout of `maxTurns × 30 seconds + 60 seconds` (360 seconds for the attested ten-turn investigator). It dispatches a new case only when that complete allowance fits inside the approved run deadline. Reads/imports keep the 30-second default. A client timeout does not cancel server work; no retry follows, and backend reservations remain charged. Baseline checks its deadline before each call; an already-started bounded baseline call may finish after that dispatch deadline without exceeding its reservation.

## No-network verification

```bash
EVAL_PRIVATE=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private
EVAL_PYTHON="$EVAL_PRIVATE/.venv/bin/python"
INVOICE_MVP_UPSTREAM="$EVAL_PRIVATE/upstream" "$EVAL_PYTHON" -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v
node_modules/.bin/tsx --test evals/invoice-mvp/capped-llm.node-test.ts
node_modules/.bin/tsc --noEmit -p evals/invoice-mvp/tsconfig.json
```

Tests use explicit injected transports and synthetic authorization; no credential is read and no provider request occurs. They cover concurrent cap enforcement, persistent crash charges, repeated requests/envelopes, changed ledger paths, unauthorized/expired runs, invalid served models, retained missing usage, default disabled execution and baseline prompt/tool/algorithm parity.

## Commands only after the user approves

Record the actual approval reference and expiry in a private copy of `authorization.example.json`, set `authorized: true` only after that approval, and replace `ledgerPath` with one absolute private path. These edits are an operator recording of approval, not an approval mechanism. Do not execute them merely because credentials become available. The example three run IDs and limits are the proposed batch.

```bash
EVAL_AUTH="$EVAL_PRIVATE/approved-batch.json"
EVAL_LEDGER="$EVAL_PRIVATE/approved-batch-ledger.json"
EVAL_UPSTREAM="$EVAL_PRIVATE/upstream"
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
```

Root must start a separate fresh empty real product workspace for each app run, with model opt-in and persistent per-run caps matching authorization, then supply its exact clean commit and dedicated origin. Example runtime configuration names are `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, `INVOICE_MVP_MAX_MODEL_CALLS`, `INVOICE_MVP_MAX_COST_MICROS`, `INVOICE_MVP_MAX_INPUT_TOKENS`, `INVOICE_MVP_MAX_OUTPUT_TOKENS`, `INVOICE_MVP_OUTPUT_TOKENS_PER_CALL`, `INVOICE_MVP_INPUT_TOKEN_MICROS`, and `INVOICE_MVP_OUTPUT_TOKEN_MICROS`. Required model credential is `ANTHROPIC_API_KEY`; backend seat credentials stay server-side. Root owns startup, backend provisioning and supervised restarts.

```bash
# Replace with the approved exact clean runtime commit and dedicated live endpoint.
EVAL_APP_COMMIT=REPLACE_WITH_EXACT_COMMIT
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

# D only; a second empty live application workspace with the held-out envelope.
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

Comparison differences remain: baseline A has generic file tools; app uses retrieval, deterministic validators, per-case tools and mandatory human acceptance. Baseline effort high versus app provider-default effort is a chosen configuration difference, not a technical necessity. Output limits and reservation-reconciliation policies are also chosen differently. A later controlled comparison can align these settings. The same original bytes/text and model do not make this a controlled agent-count experiment. Historical contamination is acknowledged. A complete live run still needs the user's explicit capped approval, credentials, fresh runtime attestation, and production-path execution; no mock test substitutes for that evidence.
