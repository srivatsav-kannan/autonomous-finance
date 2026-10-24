# OpenAI evaluation configuration and baseline status

The user stated on 2026-10-24 that they only have OpenAI API keys, then approved one OpenAI batch under the same $7.50 total in the coordination chat. This replaces the Claude batch; it is not additional spending. The frozen scorer/held-out expectations, sealed deterministic scores and earlier Claude preparation are unchanged. Follow-up tracking: [issue #66](https://github.com/srivatsav-kannan/autonomous-finance/issues/66).

The baseline has now run and stopped before submission. Nine model calls and 85 tool calls completed, with 280,549 aggregate input tokens, 4,002 output tokens and calculated usage cost **$0.601118**. The run lasted 42.956 seconds. It is **UNSCORED_NO_SUBMISSION**, with null official/strict accuracy, not a zero score. All nine actual responses settled within their original reservations. Application runs are coordinated separately by root.

An independent offline replay used the original execution code `e3a2238` (D equivalent `30ab79b`) and reproduced all nine recorded wire hashes. The next input bound was **266,157**, exceeding the approved per-request 250,000 limit by 16,157. The tenth request was never dispatched. This was not dollar exhaustion: $2.398882 remained in the baseline envelope, and the hypothetical next $1.172314 reservation would fit. The byte-derived estimate is conservative; actual turn-10 input tokens are unknown. The result does not demonstrate model inability to complete the fixture.

The original run remains sealed under `fec886169239faf48de4022a075fdc7237761dc45058bcb0a0be90b2b7f8c3c3`. Sanitized independent diagnostics are in evaluator-private `diagnostics/openai-20261024-baseline-original`, sealed under `35c8d88e884d78228f11ad749a36ccad3fba5efa871cc144144fb4189b7300b0`. Diagnosis made zero provider calls, did not read a key or modify the shared ledger, and exposed no opaque reasoning content.

## Proposed configuration and approval envelope

Both roles use `gpt-6.1-sol`, high reasoning effort, the first-party Responses API, standard/default service tier, no caching, no retries and no fallback. The credential name is `OPENAI_API_KEY`; root loaded it without displaying its value. The nine baseline calls confirm model access for that run. D has not inspected the key. Keep the key in the server process environment, outside source control and chat.

The [official model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [pricing page](https://developers.openai.com/api/docs/pricing), checked on 2026-10-24, establish input/output rates of $2/$10 per million tokens for standard short-context requests. Prompts above 272K input tokens have higher rates. The authorization therefore rejects any per-request input bound above 250,000. Output usage includes reasoning tokens. These are calculated usage costs, not a billing invoice.

| Run | Maximum spend | Maximum requests | Input bound per request | Output bound per request | Run deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline, original fixture | $3.00 | 40 | 250,000 | 64,000 | 20 minutes |
| Actual app, original fixture | $3.00 | 160 | 100,000 | 4,096 | 30 minutes |
| Actual app, held-out suite | $1.50 | 64 | 100,000 | 4,096 | 20 minutes |

The **single $7.50 aggregate batch is approved**, with the explicit OpenAI clarification recorded by root in private `approved-openai-batch.json`. Its one shared ledger is `approved-openai-batch-ledger.json`. The committed [OpenAI authorization example](../../evals/invoice-mvp/authorization.openai.example.json) remains disabled and carries exact [pricing provenance](../../evals/invoice-mvp/pricing-provenance.openai.json). Actual approval requires a recorded reference, future expiry and one absolute private ledger path. The immutable, locked ledger enforces the run envelopes. Possession of a key alone is not approval. No baseline rerun, ledger reset, refund or new batch follows from this diagnosis.

## Provider translation and accounting

`baseline-agent.ts` remains byte-identical to historical A except import paths. Its prompt, schemas, source access, file paging, submission validation, and loop are unchanged. The new transport maps these tools/messages to Responses functions and returns calls to that same loop. Responses has no separate `is_error` tool-output flag; error output text is retained. This protocol difference is disclosed, not described as provider equivalence.

The adapter uses `store: false` and preserves every native output item for replay, including function-call IDs, message phase and encrypted reasoning. This follows the [reasoning-history guidance](https://developers.openai.com/api/docs/guides/reasoning). Encrypted reasoning is replayed as opaque provider data, never converted into visible assistant text. Native response output is included in the private baseline transcript. Missing native history is rejected instead of reconstructed from text.

The [prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) specifies that `prompt_cache_options: {"mode":"explicit"}` without breakpoints prevents reads and writes. The request sets that mode and creates no breakpoints. Any reported cache read/write tokens fail settlement. Exact served model, `service_tier: "default"`, input/output counts, and bounded reasoning-token counts are validated. Missing or invalid usage halts the ledger and retains the full reservation. Valid usage is settled before malformed tool output is rejected. Transport failures keep an unresolved reservation; they are never retried.

The HTTP transport pins `https://api.openai.com/v1/responses`, sends only the explicit API key, refuses redirects, bounds each request to at most 60 seconds and the remaining baseline deadline, and ignores ambient provider URL overrides. No built-in web/file/code tools are enabled.

The completed baseline used the original input estimate: complete translated request UTF-8 bytes plus 4,096. Subsequent review found that opaque reasoning encoding is not a proved upper bound on its original tokens. For **future requests only**, the transport now adds every prior native response's reported output-token count to those wire bytes and overhead. This intentionally also counts visible output conservatively. Configuration and per-turn usage record the new policy/allowance; multistep no-network tests cover it. The sealed run and original-guard diagnosis are unchanged. No live run has tested this new guard.

Same model and high effort align two settings. Tool access, per-case versus whole-workspace execution, output limits, human acceptance and reservation reconciliation still differ. The app's 4,096-token output cap is a new chosen setting, not a measured optimum. Neither this preparation nor the earlier deterministic results establishes a controlled agent-count benefit or live model accuracy.

## Product integration contract

Root/B owns the real application adapter. The evaluation runner does not implement or replace it. A clean runtime must attest the approved model and budget plus:

```json
{
  "effort": "high",
  "reasoningContext": "all_turns",
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

For OpenAI only, the persisted completed-request or unusable-response usage sentence may append exactly ` Total output includes N reasoning tokens; no reasoning content is retained in audit.` The evaluator validates the numeric count from zero through total output tokens, preserves the request-ID pairing and usage cost, and rejects altered suffixes. Missing suffixes do not imply zero reasoning usage; the aggregate remains unknown unless every actual record supplies the count. No reasoning content is required or retained by this audit format.

## No-network validation and later execution

```bash
INVOICE_MVP_UPSTREAM=/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/upstream \
  /Users/junjiexiong/.codex/invoice-mvp-evaluation-private/.venv/bin/python \
  -m unittest discover -s evals/invoice-mvp -p 'test_*.py' -v
node_modules/.bin/tsx --test evals/invoice-mvp/capped-llm.node-test.ts evals/invoice-mvp/openai-responses.node-test.ts
node_modules/.bin/tsc --noEmit -p evals/invoice-mvp/tsconfig.json
git diff --check
```

All **30 Python tests, 14 dedicated Node tests and the evaluation TypeScript check pass**. The compatibility suite includes exact reasoning-suffix validation and native prior-output allowances in addition to reservation-before-dispatch, wrong model/tier/cache/missing usage rejection, native-history replay, truncated/refused output handling, transport failure retention, and the actual unchanged baseline loop listing/reading/submitting a synthetic workspace. Tests inject synthetic responses and fetch functions; no API key is read and no provider connection occurs. These are compatibility tests, not live scores.

Root owns the remaining app runs using the existing approved OpenAI authorization and shared ledger. [LIVE.md](../../evals/invoice-mvp/LIVE.md) supplies command structure; use the actual OpenAI run IDs, runtime commit and distinct output folders. **Do not repeat its baseline command for this completed run or create another ledger.** The baseline chooses OpenAI from the approved run's `provider` field. `live_app.py` validates the OpenAI runtime contract before claiming the envelope or importing sources. Use the newly reviewed application commit rather than the earlier measured deterministic application commit. Do not overwrite any prior sealed output. Held-out scoring still remains evaluator-only.

Status: baseline **UNSCORED_NO_SUBMISSION**, observed calculated usage cost **$0.601118**; further app execution belongs to root. D's independent diagnosis and subsequent compatibility/guard corrections made zero provider calls. The corrected guard has not been exercised in a paid baseline run.
