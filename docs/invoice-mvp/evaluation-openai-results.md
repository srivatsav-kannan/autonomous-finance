# OpenAI evaluation results

The approved OpenAI batch completed with limited coverage. The baseline stopped before submission and is **unscored**. The actual app scored **0/18** original-fixture customer net totals and **4/9** held-out checks, with no accepted accounting effects or human decisions in either primary run. All source bytes, persisted states, audit entries and usage totals survived an actual backend/gateway restart.

Calculated provider-usage cost was **$1.201842 across 59 model calls**, within the single approved **$7.50 total**. This OpenAI batch replaced the earlier Claude batch. No paid run was retried, and no budget envelope was reset or reallocated. Costs use standard operator pricing applied to provider-reported tokens; they are not a billing invoice. Complete aggregate evidence and hashes are in [evaluation-openai-results.json](evaluation-openai-results.json).

| Evaluation | Result | Model calls | Calculated cost | Wall time |
| --- | --- | ---: | ---: | ---: |
| Baseline, original fixture | No submission; unscored | 9 | $0.601118 | 42.956 s |
| Actual app, original fixture | Official 0/18; all-four-fields exact 0/18 | 29 | $0.495784 | 164.779 s |
| Actual app, held-out suite | 4/9 frozen checks | 21 | $0.104940 | 32.812 s |

## What the application achieved

The original app preserved **148/148 source versions**, original bytes and extracted text. All 18 customers were present without missing, extra or duplicate rows, but persisted customer totals were zero. The official absolute net error was $3,566,177.15, with 107 expected invoice/credit contributions missing. All 148 cases remained unresolved: six Needs review and 142 Evidence missing.

Only five original cases contained provider usage: one CSV and four emails. The six exclusion proposals all concerned support files outside the invoice grading key; four came from live investigation and two from deterministic parsing. All 12 cited source versions and quotations were valid. There were **no financial include/credit proposals**. This scoped consistency check is not a general semantic proposal-accuracy result. Zero unsupported accepted effects provides little evidence when there are no accepted effects.

The held-out app preserved **11/11 immutable source versions**, including the superseded version and duplicate. Nine current cases remained unresolved. Its 4/9 pass vector exactly matches the earlier deterministic result: duplicate handling, two conflict abstentions and missing-invoice non-counting passed; unfamiliar/revised/credit/late interpretation and statement exclusion did not. Current contradiction arrays were empty, so the conflict passes show abstention rather than conflict recognition. Only three case records contained provider usage. Historical investigation records include two bounded runs without a supported conclusion and 27 persistent-budget stops across repeated phases; those 27 events are not 27 distinct cases.

## Why coverage stopped

The app permanently charges each request's worst-case reservation against its run allowance, even after lower actual usage is known. Original-fixture reservations reached **$2.980790 of $3**, leaving $0.019210. Held-out reservations reached **$1.463234 of $1.50**, leaving $0.036766. Both remainders were below even the next 4,096-output-token reservation of $0.040960. Request-count ceilings were not reached. In the original run, 141 cases received no provider call and one partially investigated case subsequently hit the persistent limit.

All 50 app requests have complete paired reservation and actual-usage records. App usage totals 284,322 input and 3,208 output tokens, including 440 reasoning tokens. Reported cache read/write usage was zero. The primary protocol supplied no human approvals; no accepted accounting effect was added. These runs therefore establish limited model/tool execution, retention and controlled stopping, not reliable autonomous invoice interpretation.

The baseline stopped for a different reason. An independent offline replay through its unchanged loop and original workspace reproduced all nine recorded request hashes. Turn 10's conservative input estimate was **266,157**, exceeding the approved per-request ceiling of **250,000**, and the request was rejected before dispatch. Actual turn-10 input tokens are unknown. The baseline still had $2.398882 in its envelope; the hypothetical next $1.172314 reservation would fit that amount. The input guard, rather than dollar exhaustion, ended the run. No submission exists, so official and strict baseline accuracy remain null, not zero.

That baseline used serialized request bytes plus 4,096. Subsequent review corrected future reservations to add every prior native response's output-token count because opaque reasoning encoding is not a proved token bound. The correction passed no-network checks and was not used to rewrite or rerun the sealed baseline. The incomplete baseline cannot establish either model inability to solve the fixture or app superiority.

## Source identity and restart verification

The baseline execution source was `e3a2238efd21adc9ec3b98144cdb5157c5df84f9` (D equivalent `30ab79b`). Both app runs used clean `d08165c1ad38bb20817ace294c55ed1c50b8c243`. Independent scoring and corrected restart comparisons used clean evaluator `53af871155f0b1b9446f3f208898a47af2ac8353`. Later report commits do not change these measured source identities.

The original scorer remains pinned and unmodified at upstream `b8cb58ff9747486e86c623e867b76fad5d8d075f`. Held-out source/expectation hashes remain those frozen by protocol `357866ec73dd8a643408e4a3b1ca4db6654e99b7`. Scoring ran only after artifacts were complete and sealed. D independently recomputed source retention, structural audits and usage, which matched the stored run records.

Root stopped the actual Convex backend and owned gateways, confirmed their ports unbound, and restarted them. D independently verified both fresh runtimes still attested the exact clean app source, then performed GET-only comparisons. **Both restart comparisons passed**. All case states, totals, decisions, source bytes/text/versions, entire audit dictionaries and recalculated provider-usage totals were unchanged. No new inference appeared after restart. These primary workspaces contained no accepted effects or decisions, so their restart checks do not establish durability of accepted amounts by themselves.

Root separately verified a deterministic browser workflow at the same app source: nine source versions, four active contributions, two human decisions, replay stability, late revision, stale-approval smoke and one unfamiliar unresolved case. Its accepted amounts and decisions survived restart. This is separate demonstration evidence, recorded in the integrated `verification-d08165c.json`; it is not a hidden-suite or live-model score.

## Comparison limits and reproducibility

Both model roles used `gpt-6.1-sol` with high effort. Tool access, whole-workspace versus per-case orchestration, output limits, parallel-tool behavior, human acceptance and reservation reconciliation differed. The original fixture was previously seen; the held-out live cohort is post-fix after earlier deterministic exposure. No reviewer is implemented and no reviewer gain or controlled agent-count benefit is demonstrated.

The [earlier deterministic report](evaluation-results.md) remains separate: original 0/18, held-out 4/9, exact source retention and restart checks passed at app `926e4e8` with zero model calls. Historical 18/18 experiments are not new MVP results. [Configuration](#configuration) below records the approved limits and the future-only guard correction.

A local limitation remains: simultaneous gateways on the same browser hostname overwrite the shared session cookie. Root isolated the demonstration with `localhost`; evaluation clients used separate cookie jars. No product code was tuned after these measured runs. Production SSO is not implemented; the demonstration uses simulated local identity.

D's checks pass: 30 Python tests, 14 no-network Node tests and evaluation TypeScript. Root independently reports 331 tests in 26 files, all application/Convex/evaluation typechecks and the Vite build passing on the measured app code. These checks support the implementation but do not replace measured accuracy or broaden coverage.

Private sealed artifacts are under `live/openai-20261024/{baseline-original,app-original,app-heldout}`, `live-scores/openai-20261024/{app-original-independent,app-heldout-independent}`, and `live-restart/openai-20261024/`. Sanitized diagnostics are in `diagnostics/openai-20261024-*`. The companion JSON records exact run, score, diagnostic, restart and retention/usage hashes. Source documents, grading keys and opaque provider reasoning remain outside public reports. D made no provider calls during scoring or diagnosis.

## Configuration

This section was `evaluation-openai.md`. The user approved one OpenAI batch on 2026-10-24, capped at $7.50 in total. It replaced the earlier Claude plan; it was not extra spending. Follow-up: [issue #66](https://github.com/srivatsav-kannan/autonomous-finance/issues/66).

| Run | Maximum spend | Maximum requests | Input bound per request | Output bound per request | Run deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline, original fixture | $3.00 | 40 | 250,000 | 64,000 | 20 minutes |
| Actual app, original fixture | $3.00 | 160 | 100,000 | 4,096 | 30 minutes |
| Actual app, held-out suite | $1.50 | 64 | 100,000 | 4,096 | 20 minutes |

- **Model.** Both roles use `gpt-6.1-sol` at high reasoning effort through the Responses API: default service tier, no caching, no retries, no fallback. Pricing ($2 / $10 per million input / output tokens, short context) was checked against the [model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [pricing page](https://developers.openai.com/api/docs/pricing) on 2026-10-24. Prompts above 272K input tokens cost more, so any input bound above 250,000 is rejected.
- **Approval.** The committed [authorization example](../../evals/invoice-mvp/authorization.openai.example.json) stays disabled and carries [pricing provenance](../../evals/invoice-mvp/pricing-provenance.openai.json). A real approval needs a recorded reference, a future expiry and one absolute private ledger path. A key alone is not approval. Do not rerun the batch, reset its ledger or reuse its run IDs.
- **Transport.** `baseline-agent.ts` is byte-identical to historical A except import paths; only its transport is replaced. Requests use `store: false`, replay every native output item (including encrypted reasoning) as opaque data, set `prompt_cache_options: {"mode":"explicit"}` with no breakpoints, pin `https://api.openai.com/v1/responses`, refuse redirects and bound each request to 60 seconds. Served model, service tier, token counts and zero cache usage are validated; missing usage keeps the full reservation.
- **Input guard.** The completed baseline bounded input as request UTF-8 bytes plus 4,096. For future requests only, the bound also adds every prior response's output-token count, because encrypted reasoning size is not a proven token bound. No paid run has used the new guard.
- **Product settings.** `INVOICE_MVP_PROVIDER=openai`, `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, `INVOICE_MVP_OUTPUT_TOKENS_PER_CALL=4096`, plus explicit price and budget variables. The model is fixed and independent of `AGENT_MODEL`. The app sets `parallel_tool_calls: false`; the baseline allows parallel calls, as historical A did.
- **Differences that remain.** Tool access, per-case versus whole-workspace execution, output limits, human acceptance and reservation accounting differ between baseline and app. This is not a controlled agent-count comparison.

No-network checks (30 Python tests, 14 Node tests and the evaluation TypeScript check) are listed in the [harness README](../../evals/invoice-mvp/README.md#no-network-tests).
