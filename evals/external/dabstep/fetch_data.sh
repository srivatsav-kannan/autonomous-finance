#!/usr/bin/env bash
# Download the DABstep tasks and context files (CC-BY-4.0, huggingface.co/datasets/adyen/DABstep)
# into DATA_DIR and check them against the hashes this eval was run with.
#   bash evals/external/dabstep/fetch_data.sh [DATA_DIR]   (default: ../benchdata/dabstep)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DATA_DIR="${1:-$REPO_ROOT/../benchdata/dabstep}"
BASE="https://huggingface.co/datasets/adyen/DABstep/resolve/main/data"
mkdir -p "$DATA_DIR/context"

fetch() { curl -fsSL -m 600 -o "$DATA_DIR/$2" "$BASE/$1"; }
fetch tasks/dev.jsonl dev.jsonl
fetch tasks/all.jsonl all.jsonl
for f in payments.csv fees.json manual.md merchant_data.json merchant_category_codes.csv acquirer_countries.csv payments-readme.md; do
  fetch "context/$f" "context/$f"
done

# sha256 of the files used for docs/evals/dabstep.{md,json} (dataset revision 0545553f02cedc323dee8658af62555852bc3b24)
cd "$DATA_DIR"
shasum -a 256 -c - <<'EOF'
c1da755a6fe9cb538fc84719f51e1db0bff0190a1d6905767ac18c755e66a07b  dev.jsonl
d776385abe09ff89ed3263bd47c90fa0f060680c0d2ef04a83485fa4b6f2512c  all.jsonl
5fbb26210a45427d7a6560cfab3a362a08e4067f27cd03695f211a51c47ffc25  context/payments.csv
9a833666ae9be5a8e756dd1fe076c72e7c502d64161315ffa8fee9e5bf2599dc  context/fees.json
bb7f4ca6fdc759af1f480702b3a3b12e17e9293b0d38a1dbfbbc8ffc1e572d2c  context/manual.md
f158e834de27ee8407e99d9c32da690357981d2770958fd302a9bb79ced83581  context/merchant_data.json
83247d79f5ddcdd180e02f184b644f4912731942a2fc58d91f2a06b911d04b41  context/merchant_category_codes.csv
6744cf1962e4b5086342821e627f4557c32f06c3c58e8b0ff3b449dcc634f37f  context/acquirer_countries.csv
8754b92d0b3127856ff72266ea482995d2a1f6a34d0a12732f7c26f527f2c4a5  context/payments-readme.md
EOF
echo "data in $DATA_DIR"
