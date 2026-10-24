# Worker D final free-evaluation handoff

The authorized free preparation and actual deterministic application evaluation are complete. Live baseline/application comparison remains NOT RUN because model credentials and spending approval are absent. This is not a claim that the MVP is fully validated.

The native goal was created and verified active initially, then marked blocked after three turns awaiting the integrated runtime. Root explicitly resumed the assignment; `get_goal` still returns **blocked**, because the available goal tool cannot reactivate it. D proceeded under that explicit assignment and has not claimed native reactivation or overall live-evaluation completion.

## Identity and exact revisions

- Worker chat: `01a16fb6-c8b1-7ca1-ad77-b379c61a733c`, local; root chat: `01a16fb4-0204-7780-9d59-1a5d60c4791c`.
- Base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c`.
- Worktree: `/Users/junjiexiong/.codex/worktrees/d500/calhacks`.
- Branch: `codex/invoice-mvp-evaluation`.
- Frozen protocol: `357866ec73dd8a643408e4a3b1ca4db6654e99b7`.
- Final evaluated application: clean `926e4e8899a054c6cc1f2548f84a4ba18469797c`.
- Final evaluation execution code: clean `02bd47d1909cb23b7bd11d950e0729d7ef75c79f`.
- Final report-only handoff commit is supplied in the worker message; it does not change evaluated application code.

## Owned files and changes

D owns `evals/invoice-mvp/`, the new `evals/external/invoice-sandbox/system-mvp.py` adapter, `docs/invoice-mvp/evaluation*.{md,json}`, and this handoff. Historical A/B/C code, library, runner and old results are unchanged, verified against the common base. D made no product/shared-schema edits, pushes, independent PRs, deployments or real financial actions.

The harness verifies pinned upstream fixture/scorer identity, imports original bytes plus equal extracted text through B HTTP, exports only A's persisted totals, seals artifacts before scoring and invokes the unmodified scorer. Independent strict/document/source-retention checks supplement the official metric. Held-out sources and expectations remain evaluator-private outside product worktrees; source/key hashes were frozen before scores. Aggregate first-pass results were sent before detailed failure disclosure. No answer key became a model/tool input or automated human decision.

The capped baseline preserves A's exact prompt/tools/agent loop, replacing only its transport. It uses explicit first-party API-key authentication, no ambient token override, no retries/fallback/cache, verified pricing/model provenance, pre-request reservations in one locked/atomic/fsynced ledger, replay protection, and retained charges for unknown failures. The separate live app runner requires real runtime provenance, matching persistent run caps and complete paired provider-usage records. It recognizes priced unusable model responses, keeps unknown usage null, and allows a ten-turn case up to 360 seconds only when that allowance fits the approved run deadline. Configuration attestation is not evidence of a live invocation.

## Final measured outcomes

See the cohesive [evaluation-results.md](evaluation-results.md) and machine-readable [evaluation-results.json](evaluation-results.json).

- Original Invoice Sandbox, second transport attempt after database-only rate-limit handling: **0/18 official exact customer net totals**, all four fields exact for 0/18. All 18 customers are present with no duplicate/extra/missing rows. All **148 source versions/original bytes/text preserved**; 148 cases unresolved, zero accepted effects/human interventions/model calls/spend. Wall time 67.940 seconds. No incorrectly included effects, but 107 expected accounting contributions are missing. The five excluded-key PDFs remaining uncounted do not establish resolved exclusion.
- Final held-out v1, post-fix: **4/9**, unchanged from first pass. Nine unresolved current cases, one duplicate, zero accepted effects/human decisions/model calls/spend. All **11 source versions preserved**. Wall time 2.796 seconds. Conflict passes show abstention, not conflict recognition.
- Actual backend and owned gateway restart at the same application commit: **PASS for both original and held-out state comparisons**. Subsequent independent byte/text retention audits also pass for 148/148 original and 11/11 held-out versions. Root separately owns browser acceptance for its four accepted effects/two decisions/one missing-evidence case; these are not D's held-out metrics.
- Original failed first attempt at `f1f0351` remains FAILED_UNSCORED after 105 sources. First held-out at `c7774f6` remains sealed at 4/9. Detailed history links are in the final report; no historical result was rewritten.
- No reviewer exists; no reviewer gain or controlled agent-count benefit is demonstrated. Baseline high effort versus app provider-default effort is a chosen configuration difference. Live results are NOT RUN, not zero accuracy.

## Verification and reproducible commands

On the final code revision, **27 Python tests, five dedicated no-network Node tests and TypeScript checks pass**. The dedicated Node test file is named `capped-llm.node-test.ts`; a Vitest discovery check confirms it is not miscollected. All actual provider calls/spend are zero. Root independently reported full product test/typecheck/build/browser acceptance; D's test counts are separate.

```bash
EVAL_PRIVATE=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private
EVAL_PYTHON="$EVAL_PRIVATE/.venv/bin/python"
INVOICE_MVP_UPSTREAM="$EVAL_PRIVATE/upstream" "$EVAL_PYTHON" -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v
node_modules/.bin/tsx --test evals/invoice-mvp/capped-llm.node-test.ts
node_modules/.bin/tsc --noEmit -p evals/invoice-mvp/tsconfig.json
git diff --check
```

Run/score commands are in [the evaluation README](../../evals/invoice-mvp/README.md). Final private artifact folders, each with hash seals:

- `runs/mvp-original-postfix-926e4e8`, `scores/mvp-original-postfix-926e4e8`.
- `runs/mvp-heldout-final-926e4e8`, `scores/mvp-heldout-final-926e4e8`.
- `restart/mvp-original-postfix-926e4e8`, `restart/mvp-heldout-final-926e4e8`.
- `restart-retention-926e4e8`; secret-free root attestation `restart-926e4e8.json`.

All paths above are relative to `$EVAL_PRIVATE`; none contain grading keys in product context. Public final JSON records run/scorer/restart hashes and exact source revisions. Source files contain 100,094,614 original bytes; the largest encoded SourceInput is 1,218,637 bytes. Default HTTP chunks are two million bytes. No source was omitted to fit storage limits.

## Remaining external dependency

The proposed one-time live batch is **$7.50 maximum**: $3 baseline original, $3 actual app original and $1.50 actual app held-out. It may stop with partial results when the conservative budget exhausts. Required model credential name: `ANTHROPIC_API_KEY`. User approval is still absent. The example authorization is disabled; credentials alone never authorize spending. [LIVE.md](../../evals/invoice-mvp/LIVE.md) has exact commands, source/model/pricing parity and deliberate differences. Root can ask once for this concrete batch after its final review.

No additional contract changes are proposed. Runtime provenance and original-byte storage issues were routed through root/A/B and verified through final runs. D remains available for corrections or a separately authorized live continuation.
