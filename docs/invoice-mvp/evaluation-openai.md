# OpenAI evaluation preparation — NOT RUN

The user stated on 2026-10-24 that they only have OpenAI API keys. This additive amendment prepares an OpenAI comparison. It does not authorize spending, change the frozen scorer/held-out expectations, rewrite the sealed deterministic scores, or replace the earlier Claude preparation. Follow-up tracking: [issue #66](https://github.com/srivatsav-kannan/autonomous-finance/issues/66).

## Proposed configuration and approval envelope

Both roles use `gpt-6.1-sol`, high reasoning effort, the first-party Responses API, standard/default service tier, no caching, no retries and no fallback. The credential name is `OPENAI_API_KEY`; no credential value has been inspected or used. Account access to this model remains unverified. Keep the key in the server process environment, outside source control and chat.

The [official model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [pricing page](https://developers.openai.com/api/docs/pricing), checked on 2026-10-24, establish input/output rates of $2/$10 per million tokens for standard short-context requests. Prompts above 272K input tokens have higher rates. The authorization therefore rejects any per-request input bound above 250,000. Output usage includes reasoning tokens. These are calculated usage costs, not a billing invoice.

| Run | Maximum spend | Maximum requests | Input bound per request | Output bound per request | Run deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline, original fixture | $3.00 | 40 | 250,000 | 64,000 | 20 minutes |
| Actual app, original fixture | $3.00 | 160 | 100,000 | 4,096 | 30 minutes |
| Actual app, held-out suite | $1.50 | 64 | 100,000 | 4,096 | 20 minutes |

The **new $7.50 aggregate proposal is unapproved**. The earlier Claude question does not approve this provider/configuration. The disabled [OpenAI authorization example](../../evals/invoice-mvp/authorization.openai.example.json) carries exact [pricing provenance](../../evals/invoice-mvp/pricing-provenance.openai.json). It requires a recorded approval reference, future expiry and one absolute private ledger path. The same immutable, locked ledger enforces the run envelopes. No new approval is inferred from possession of a key. Conservative reservations can stop a run before all documents or request slots are used.

## Provider translation and accounting

`baseline-agent.ts` remains byte-identical to historical A except import paths. Its prompt, schemas, source access, file paging, submission validation, and loop are unchanged. The new transport maps these tools/messages to Responses functions and returns calls to that same loop. Responses has no separate `is_error` tool-output flag; error output text is retained. This protocol difference is disclosed, not described as provider equivalence.

The adapter uses `store: false` and preserves every native output item for replay, including function-call IDs, message phase and encrypted reasoning. This follows the [reasoning-history guidance](https://developers.openai.com/api/docs/guides/reasoning). Encrypted reasoning is replayed as opaque provider data, never converted into visible assistant text. Native response output is included in the private baseline transcript. Missing native history is rejected instead of reconstructed from text.

The [prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) specifies that `prompt_cache_options: {"mode":"explicit"}` without breakpoints prevents reads and writes. The request sets that mode and creates no breakpoints. Any reported cache read/write tokens fail settlement. Exact served model, `service_tier: "default"`, input/output counts, and bounded reasoning-token counts are validated. Missing or invalid usage halts the ledger and retains the full reservation. Valid usage is settled before malformed tool output is rejected. Transport failures keep an unresolved reservation; they are never retried.

The HTTP transport pins `https://api.openai.com/v1/responses`, sends only the explicit API key, refuses redirects, bounds each request to at most 60 seconds and the remaining baseline deadline, and ignores ambient provider URL overrides. UTF-8 bytes of the complete translated request plus a 4,096-token protocol allowance form the conservative input bound. No built-in web/file/code tools are enabled.

Same model and high effort align two settings. Tool access, per-case versus whole-workspace execution, output limits, human acceptance and reservation reconciliation still differ. The app's 4,096-token output cap is a new chosen setting, not a measured optimum. Neither this preparation nor the earlier deterministic results establishes a controlled agent-count benefit or live model accuracy.

## Product integration contract

Root/B owns the real application adapter. The evaluation runner does not implement or replace it. A clean runtime must attest the approved model and budget plus:

```json
{
  "effort": "high",
  "outputTokensPerCall": 4096,
  "modelProvider": {
    "baseURL": "https://api.openai.com/v1",
    "api": "responses",
    "authentication": "explicit_api_key",
    "pricing": {"inputMicros": 2, "outputMicros": 10},
    "servedModelValidated": true,
    "cacheUsageValidated": true,
    "serviceTier": "default",
    "promptCacheMode": "explicit_without_breakpoints"
  }
}
```

The existing persistent run reservation, zero retry/fallback, cache-disabled usage, prompt/tool identity and actual-usage audit contracts also remain required. Provider usage must include reasoning within output counts and retain usage for unusable responses. Application calls remain 30-second bounded requests and use the existing case allowance. Root must provide a fresh empty workspace and exact clean application commit for each cohort. Runtime configuration alone is not evidence of successful inference. Product selection is `INVOICE_MVP_PROVIDER=openai`, with `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, and `INVOICE_MVP_OUTPUT_TOKENS_PER_CALL=4096`. Explicit price/budget variables remain mandatory. The fixed model is independent of `AGENT_MODEL`.

The baseline permits parallel function calls to preserve historical A; the app sets `parallel_tool_calls: false` to preserve its sequential investigator. The baseline records opaque native output in its private transcript; the product keeps native continuation only in investigation memory. These are disclosed continuation/execution differences, not parity claims.

## No-network validation and later execution

```bash
INVOICE_MVP_UPSTREAM=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/upstream \
  /Users/junjiexiong/.codex/invoice-mvp-evaluation-private/.venv/bin/python \
  -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v
node_modules/.bin/tsx --test evals/invoice-mvp/capped-llm.node-test.ts evals/invoice-mvp/openai-responses.node-test.ts
node_modules/.bin/tsc --noEmit -p evals/invoice-mvp/tsconfig.json
git diff --check
```

All 29 Python tests, 13 dedicated Node tests and the evaluation TypeScript check pass. Tests inject synthetic responses and fetch functions. They verify reservation-before-dispatch, wrong model/tier/cache/missing usage rejection, reasoning accounting, native-history replay, truncated/refused output handling, transport failure retention, and the actual unchanged baseline loop listing/reading/submitting a synthetic workspace. No API key is read and no provider connection occurs. These are compatibility tests, not live scores.

After explicit approval and product integration, use the existing commands in [LIVE.md](../../evals/invoice-mvp/LIVE.md) with a private approved copy of **authorization.openai.example.json**, a distinct private OpenAI ledger/output directory, and `OPENAI_API_KEY` in the relevant process environment. The baseline chooses OpenAI from the approved run's `provider` field. `live_app.py` validates the OpenAI runtime contract before claiming the envelope or importing sources. Use the newly reviewed application commit rather than the earlier measured application commit. Do not overwrite any prior sealed output. Held-out scoring still remains evaluator-only.

Status: evaluation-owned OpenAI preparation implemented; application integration pending root/B; all paid baseline/application runs **NOT RUN**; API spend **$0**.
