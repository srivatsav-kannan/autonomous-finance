# OpenAI evaluation — app results pending

The completed baseline spent **$0.601118** and stopped before submitting an answer. It has **no accuracy score**. Root reports the original-fixture app run is running; the held-out app run has not started. This report will be finalized only from completed, sealed artifacts and separate restart evidence.

The user approved one OpenAI batch on 2026-10-24, replacing the earlier Claude batch, under **one $7.50 total cap**: $3 baseline original, $3 app original, $1.50 app held-out. Root records the approval and uses one private shared ledger. D has made no provider requests or inspected the key. Current machine-readable status is in [evaluation-openai-results.json](evaluation-openai-results.json).

| Evaluation | Status | Accuracy | Calculated usage cost |
| --- | --- | --- | --- |
| Baseline, original fixture | Stopped before submission | Unscored | $0.601118 |
| Actual app, original fixture | Running, reported by root | Pending | Pending |
| Actual app, held-out suite | Not started, reported by root | Pending | Pending |

## Independent baseline finding

The baseline ran on integrated source `e3a2238efd21adc9ec3b98144cdb5157c5df84f9`, equivalent to D's `30ab79b`. Nine provider calls and 85 file-tool calls completed in 42.956 seconds. Provider-reported usage totals 280,549 input and 4,002 output tokens. Every reservation settled. No submission file exists, so the scorer refuses to fabricate official or strict accuracy.

An offline replay through the unchanged baseline loop and original workspace reproduced all nine recorded request hashes. Turn 10's conservative input estimate was **266,157**, above the approved per-request ceiling of **250,000**. It was rejected before dispatch. Actual turn-10 token usage is unknown. The baseline had $2.398882 left in its $3 envelope; the hypothetical next reservation of $1.172314 would fit that amount. The input guard, rather than the spending envelope, ended this run.

The run used serialized request bytes plus a 4,096-token allowance. A later correction adds all prior native output tokens to bound opaque reasoning replay conservatively. That correction was verified without network access and did not change or rerun the completed baseline. This partial result does not establish model inability to solve the fixture or app superiority.

The original run seal verifies before and after diagnosis: `fec886169239faf48de4022a075fdc7237761dc45058bcb0a0be90b2b7f8c3c3`. Sanitized diagnostics are sealed as `35c8d88e884d78228f11ad749a36ccad3fba5efa871cc144144fb4189b7300b0`. Their paths relative to evaluator-private storage are `live/openai-20261024/baseline-original` and `diagnostics/openai-20261024-baseline-original`. No opaque reasoning appears in this public report or sanitized diagnosis.

## Application evidence pending

Root reports both app workspaces were fresh and attested clean source `d08165c1ad38bb20817ace294c55ed1c50b8c243`, with the approved exact model and limits. D has not yet inspected their in-progress artifacts. Accuracy, proposal/check outcomes, accepted effects, unresolved cases, source retention, actual usage and restart results remain pending. The primary runs make no automatic human decisions.

Scoring will use the pinned, unmodified Invoice Sandbox scorer and independent strict/document checks for the original fixture, and the frozen private nine-check expectations for held-out sources. Missing or incomplete provider telemetry prevents a complete scored result. Restart verification requires actual backend and gateway restart evidence plus persisted-state/source comparisons. A passing startup attestation alone proves neither inference success nor restart durability.

## Interpretation and earlier evidence

The [earlier deterministic report](evaluation-results.md) remains separate: original 0/18, held-out 4/9, exact source retention and actual restart comparisons passed at application `926e4e8`. Those are real application storage/control-path results with zero model calls; they are not live OpenAI results. Historical 18/18 experiments are also not new MVP outcomes.

Both new roles use `gpt-6.1-sol` with high effort, but tool access, whole-workspace versus per-case orchestration, output limits, human acceptance, parallel tool policy and reservation reconciliation differ. The original fixture was previously seen. No reviewer is implemented and no reviewer gain or controlled agent-count benefit is established. [Configuration and source documentation](evaluation-openai.md) records these differences and the guard correction.

D's compatibility checks pass: 30 Python tests, 14 no-network Node tests and evaluation TypeScript. Root separately reports 331 repository tests, application/Convex/evaluation typechecks and Vite build passing on the integrated implementation. Neither set of tests substitutes for live outcomes.
