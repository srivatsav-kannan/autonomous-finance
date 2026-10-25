#!/usr/bin/env bash
# Clone the benchmark at the pinned commit, build its venv (+ pypdf for local text extraction),
# generate the fixture, and check it.
#   evals/external/invoice-sandbox/setup_fixture.sh            # committed seed -> ../benchdata/invoice-sandbox
#   evals/external/invoice-sandbox/setup_fixture.sh 20261024   # fresh seed     -> ../benchdata/invoice-sandbox-seed20261024
# With the committed seed it verifies the regenerated answer key and fixture against the committed copy.
# With a fresh seed it applies patches/seed-override.patch (SEED read from INVOICE_SANDBOX_SEED; no grading
# code touched) and regenerates gold_master + answer_key inside that separate clone.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BENCHDATA="${INVOICE_SANDBOX_BENCHDATA:-$REPO/../benchdata}"
COMMIT=b8cb58ff9747486e86c623e867b76fad5d8d075f
SEED="${1:-}"
DEST="$BENCHDATA/invoice-sandbox${SEED:+-seed$SEED}"
mkdir -p "$BENCHDATA"
if [ -e "$DEST" ]; then echo "$DEST already exists" >&2; exit 1; fi
git clone -q https://github.com/ciru-ai/invoice-sandbox-benchmark.git "$DEST"
cd "$DEST"
git checkout -q "$COMMIT"
uv venv -q --python 3.12
uv pip install -q --python .venv/bin/python -r requirements.txt pypdf
if [ -z "$SEED" ]; then
  SNAP="$BENCHDATA/invoice-sandbox-committed"
  rm -rf "$SNAP" && mkdir -p "$SNAP" && cp -R answer_key gold_master "$SNAP/"
  .venv/bin/python -I scripts/generate_fixture.py --clean
  for f in invoices.csv customer_totals.csv traps.json; do
    diff -q --strip-trailing-cr "answer_key/$f" "$SNAP/answer_key/$f"
  done
  diff -rq --strip-trailing-cr -x '*.pdf' -x '*.mbox' gold_master "$SNAP/gold_master"
  .venv/bin/python -I "$HERE/extract_text.py" --compare gold_master "$SNAP/gold_master"
  echo "OK: regenerated answer key and fixture match the committed copy (CRLF and timestamps aside)"
else
  git apply "$HERE/patches/seed-override.patch"
  INVOICE_SANDBOX_SEED="$SEED" .venv/bin/python -I scripts/generate_fixture.py --clean
  echo "OK: fresh fixture generated with seed $SEED in $DEST"
fi
