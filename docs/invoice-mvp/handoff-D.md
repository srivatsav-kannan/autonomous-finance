# Worker D handoff: free evaluation preparation

Native goal created with `create_goal`, verified via `get_goal` in the first progress update, and remains **active**. Root requested an idle handoff after free preparation to free the third active worker slot for C. Integrated application, restart and live acceptance are not complete; the goal is not marked complete or paused.

- Worker chat: `01a16fb6-c8b1-7ca1-ad77-b379c61a733c` (local).
- Root: `01a16fb4-0204-7780-9d59-1a5d60c4791c` (local).
- Base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c`.
- Worktree: `/Users/junjiexiong/.codex/worktrees/d500/calhacks`.
- Branch: `codex/invoice-mvp-evaluation`.
- Frozen protocol commit: `357866ec73dd8a643408e4a3b1ca4db6654e99b7` (root already integrated).
- Harness code/results commit: `370031681c5ce1226ee74859e8817e0ba941f0c3`.
- This handoff is a documentation-only follow-up; its final commit ID is in the worker's completion message.

## Owned changes

`evals/invoice-mvp/` contains frozen public manifests, original-source preparation, HTTP client, deterministic product runner, evaluator-only original/held-out scorer, artifact sealing, structural audits, mock tests and reproduce instructions. `evals/external/invoice-sandbox/system-mvp.py` is the new entrypoint. `docs/invoice-mvp/evaluation-*` contains protocol and honest status reports. No product code, shared contract, historical A/B/C harness or old result was changed. No push, PR, deployment, bank action or model call occurred.

The original README/scorer were verified from pinned upstream and the original scorer's exact behavior was exercised with synthetic key rows. Official scoring is only per-customer net USD at inclusive one-cent tolerance, with last-row-wins duplicate IDs and unpenalized unexpected IDs; missing negative nets contribute signed error. Separate strict metrics cover count/gross/credit/net exact cents plus duplicate/extra/missing rows; original document metrics use private invoice grading keys after recording outputs.

The adapter imports only reset workspace documents through B HTTP, with byte-preserving base64 and identical PDF text extraction conventions to baseline A. It exports only persisted CustomerTotal fields. HTTP cookie/session/Origin handling matches B's handshake, with default Origin `http://127.0.0.1:8790`. It requires deterministic runtime, clean source attestation matching `--app-commit`, and a new empty persisted workspace. A supports immutable source/evidence details. No alternate finance implementation substitutes for the product.

## Reproducible verification

Run from the worker/review worktree:

```bash
INVOICE_MVP_UPSTREAM=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/upstream \
/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/.venv/bin/python \
  -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v

git diff --check
```

Results on clean code commit `370031681c5ce1226ee74859e8817e0ba941f0c3`: **13/13 pass**, no skipped tests; diff check clean. Ten tests cover adapter/source/artifact/mock HTTP behavior; three execute byte-identical upstream scorer in isolated synthetic fixtures. These are harness tests, not application performance. Python 3.12.12 and pypdf 6.21.2 used for extraction/preparation.

Both `prepare` commands in `evals/invoice-mvp/README.md` succeeded against committed clean code. Private immutable artifacts:

- `/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/prepared-original-3700316/`
- `/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/prepared-heldout-3700316/`

They record PREPARED_NOT_RUN. Original fixture: 148 files, 100,094,614 bytes, 112 PDFs, 2,686,974 PDF text characters. Largest original file 895,030 bytes; largest encoded SourceInput JSON 1,218,637 bytes. Default HTTP chunk target is 2,000,000 bytes. The originally messaged 147 file count was a transcription error and corrected to 148 before final prep.

## Hidden suite custody

Only D may read private held-out source/expectation files until the first score is recorded. They live outside all implementation worktrees. Public source and expectation hashes were frozen before any score. Coverage includes unfamiliar structure, conflicting evidence, revisions, duplicates, missing/late evidence, actual restart checks and untrusted document instructions. No expected outcomes were sent to implementation workers or inserted into prompts. No hidden first pass has occurred. Root should call D back with integrated runtime and a fresh company/run; D will run and seal outputs, score privately and send aggregate first-pass outcomes first.

## Pending acceptance and limitations

1. Root supplies clean integrated runtime with A/B persistence, chunked original bytes, and runtime attestation. A's types were inspected at `a8d81dc6924498f5827d18ef5817570532cbdb97`; compatibility must be verified against the final integrated commit. Runner fails closed on wire/config mismatches.
2. Root creates isolated fresh workspaces; original and held-out runs must use separate companies/runs. First actual app score remains NOT RUN. Source import can be costly in storage/runtime despite zero API cost.
3. Restart comparison needs actual gateway AND backend restart plus recorded operator attestation. It does not itself restart processes. Reconnecting a client is insufficient. Human replay/stale approval remain explicit secondary evaluation work, not automatically satisfied by the scorer.
4. No authorized spend or model credential exists. Live baseline and live app are NOT RUN, with null metrics. Credential name only: `ANTHROPIC_API_KEY`. Proposed $7.50 batch is in the protocol and is not approval.
5. Existing baseline A transport cannot guarantee the proposed hard pre-request cap. README specifies a new bounded wrapper preserving historical A/B/C unchanged. Root explicitly asked D not to delay C for this optional preparation; no live wrapper is falsely claimed runnable. The new app adapter deliberately rejects live mode until equivalent approved cap/telemetry gates are implemented and tested.
6. Missing model usage is null. Tool-call counts alone are not model-call counts. B's runtime telemetry additions can be incorporated after integration.
7. No reviewer is implemented; no reviewer comparison or multi-role value claim exists. Original fixtures were previously seen; new private cases have different structures and temporal interactions.

## Contract deltas routed through root

Runtime attestation `GET /api/invoice-mvp/runtime` was requested and approved by root, implemented by B; no shared contract was edited by D. Original byte size exceeded a single Convex document after base64; root routed chunked storage to A. Model usage/reservation completeness and atomicity were flagged for B/A. Final exact fields will be verified on callback. No further contract changes proposed now.
