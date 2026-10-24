# Invoice MVP independent evaluation

**Current status (2026-10-24):** the one approved OpenAI batch has completed: baseline unscored, app original 0/18, held-out 4/9; calculated cost $1.201842 across 59 calls; both app restart comparisons pass. See [the independent live report](../../docs/invoice-mvp/evaluation-openai-results.md). The NOT RUN/approval text below is the preserved earlier preparation checkpoint, including the unused Claude plan; it is not the current OpenAI execution status. Do not repeat completed run commands or reset the shared ledger.

Protocol frozen at `357866ec73dd8a643408e4a3b1ca4db6654e99b7` before first scores. See `docs/invoice-mvp/evaluation-protocol.md`. Historical A/B/C and their reports are untouched. `system-mvp.py` is the new actual-product adapter, using only the real HTTP gateway and persisted Convex snapshots.

The default `run.py` path performs **free deterministic evaluation only** and rejects `live_model` and `mock_model` runtime attestation before mutating the product. Separate capped live entrypoints are prepared in [LIVE.md](LIVE.md); they require explicit recorded approval and remain NOT RUN. Mock-server unit tests do not qualify as an application evaluation. Preparation does not produce a benchmark score. Outputs must live outside the product worktree, and run/output directories cannot be reused.

## Reproduce free preparation

The evaluator-private location on this host is `/Users/junjiexiong/.codex/invoice-mvp-evaluation-private`. Implementation workers must not read the held-out sources/expectations before the recorded first scored run. The source and key hashes are public; their bytes are not committed. On another host, D must transfer the private source bundle through an evaluator-only channel; these scenarios cannot be reconstructed from the public manifest alone.

```bash
# Shell variables below are paths, never credentials.
EVAL_PRIVATE=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private
EVAL_PYTHON="$EVAL_PRIVATE/.venv/bin/python"
EVAL_UPSTREAM="$EVAL_PRIVATE/upstream"

# Already done on this host. For a fresh evaluator host:
git clone https://github.com/ciru-ai/invoice-sandbox-benchmark.git "$EVAL_UPSTREAM"
git -C "$EVAL_UPSTREAM" checkout b8cb58ff9747486e86c623e867b76fad5d8d075f
uv venv --python 3.12 "$EVAL_PRIVATE/.venv"
uv pip install --python "$EVAL_PYTHON" pypdf==6.21.2

# Choose a new reset ID each time; --fresh refuses overwrite.
"$EVAL_PYTHON" -I "$EVAL_UPSTREAM/scripts/reset_env.py" --run-id mvp-original-001 --fresh
"$EVAL_PYTHON" -I evals/external/invoice-sandbox/extract_text.py \
  "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache"
"$EVAL_PYTHON" evals/external/invoice-sandbox/system-mvp.py prepare \
  --upstream "$EVAL_UPSTREAM" \
  --workspace "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  --text-cache "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache" \
  --out "$EVAL_PRIVATE/prepared-original-001"

INVOICE_MVP_UPSTREAM="$EVAL_UPSTREAM" "$EVAL_PYTHON" -m unittest discover \
  -s evals/invoice-mvp -p 'test_*.py' -v
```

`verify_upstream` validates Git revision, README/scorer hashes, pinned fixture bytes and grading keys against Git objects. Preparation includes all 148 reset-workspace files with original base64 plus normalized text. Existing pypdf extraction supplies page markers. Inputs total 100,094,614 bytes; largest single JSON source is 1,218,637 bytes. Default HTTP import chunks are 2,000,000 bytes. A must persist source chunks because encoded PDF bytes exceed Convex's single-document limit. No source is dropped to fit a request.

## Run against the integrated product

Root starts the real Convex backend and B gateway in deterministic mode using a new empty company/run. Do not reuse the UI demo company or an earlier evaluation. Record a clean integrated commit with runtime attestation matching it. The GET workspace route sets the local session cookie; POST uses it with `X-Invoice-MVP-Session: 1` and `Origin: http://127.0.0.1:8790`. No privileged backend token enters the adapter. `--origin` can select another gateway-allowed origin.

```bash
# Replace the value with the exact clean integrated runtime commit.
EVAL_APP_COMMIT=REPLACE_WITH_EXACT_COMMIT
"$EVAL_PYTHON" evals/external/invoice-sandbox/system-mvp.py run \
  --upstream "$EVAL_UPSTREAM" \
  --workspace "$EVAL_UPSTREAM/runs/mvp-original-001/workspace" \
  --text-cache "$EVAL_UPSTREAM/runs/mvp-original-001/text_cache" \
  --run-id mvp-original-001 --app-commit "$EVAL_APP_COMMIT" --cohort first-pass \
  --out "$EVAL_PRIVATE/runs/mvp-original-001"

# Separate evaluator process; never send resulting private details to the app.
"$EVAL_PYTHON" evals/invoice-mvp/score.py \
  --run "$EVAL_PRIVATE/runs/mvp-original-001" --upstream "$EVAL_UPSTREAM" \
  --out "$EVAL_PRIVATE/scores/mvp-original-001"
```

The adapter does not interpret documents or produce its own totals. CSV fields come directly from persisted `CustomerTotal`. Strict metrics independently check all four fields at exact cents, duplicate/missing/extra customer rows, expected document inclusion/exclusion and structural support. `official_score.txt` is unmodified original scorer stdout. Its tolerance and known quirks remain unchanged. A source reference passing structural checks is not proof that the conclusion follows from its content.

## Held-out and restart (D only)

Start a distinct empty runtime/company. No automatic human answer is supplied. The source suite drives ordered ingestion: initial evidence, duplicate, explicit revision, late evidence. Outputs are sealed before the private scorer is invoked. Only aggregate results leave D initially; detailed failures can be disclosed after the first score is recorded. `--cohort post-fix` labels subsequent product revisions; the evaluator is responsible for preserving and referencing the first run.

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

Root then actually restarts both gateway and backend while preserving the run state. Write a private JSON attestation with `gatewayRestarted: true`, `backendRestarted: true`, `operator`, `restartedAt`, and the exact `command`. Compare immediately before processing additional work:

```bash
"$EVAL_PYTHON" evals/invoice-mvp/run.py compare-restart \
  --before "$EVAL_PRIVATE/runs/mvp-heldout-001" \
  --attestation "$EVAL_PRIVATE/restart-attestation.json" \
  --out "$EVAL_PRIVATE/restart/mvp-heldout-001"
```

This checks persisted case/proposal pointers, totals/effects and recorded decisions. It does not prove replay/stale approval without actual operator decisions. Root's browser acceptance and backend tests own those paths until D adds secondary explicitly assisted run artifacts. Restarting an HTTP client alone is not restart acceptance.

## Live work intentionally blocked

Required credential name: `ANTHROPIC_API_KEY`. No key was read, no API calls made, and no budget is authorized. Proposed batch is $7.50 maximum (A original $3, MVP original $3, MVP held-out $1.50); details are frozen in the protocol. Credential alone does not authorize spending.

The new capped baseline transport and separate live application adapter are now implemented and tested without network calls. Historical A/B/C are unchanged. See [LIVE.md](LIVE.md) for exact disabled-by-default commands, persistent shared budget controls, provider pricing provenance, and remaining external approval/credential requirements. The default deterministic runner remains unchanged. No live result is claimed.

No reviewer is implemented; no reviewer improvement is measurable. Missing usage remains null, never guessed from the number of tool calls. The explicitly opted-in live adapter consumes only persisted product reservation/actual-usage events.
