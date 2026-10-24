# Worker B: OpenAI Responses preparation

Prepared on 2026-10-24 for issue 66. Historical PR 63 and its evaluation claims are unchanged. This is a free implementation and mocked-verification handoff; account/model access and live-provider behavior remain **NOT RUN / unverified**. Root owns integration, approval recording and any later capped execution. No provider requests, key inspection, deployment, paid action, or remote publication occurred in this worker task.

- Branch: `codex/invoice-mvp-openai`.
- Exact base: `9a1e5ee886d1ffa13f57f0033d0efc0d42f7939b`.
- Implementation and tests: `974b4cb04932302bbce1ea2ec7fa4066f9b8735e`.
- Worktree: `/Users/junjiexiong/.codex/worktrees/a729/calhacks`.
- Native goal was created and confirmed active before implementation. It is completed after the implementation and this handoff are committed and delivered to root.

## Implementation

`src/invoice-mvp/openai-model.ts` adds a fetch-based Responses adapter with no new dependency. The model is fixed to `gpt-6.1-sol`, independent of `AGENT_MODEL`. Requests use only an explicit `OPENAI_API_KEY` and the pinned `https://api.openai.com/v1/responses` endpoint. Ambient endpoint, organization, project, profile and other-provider settings do not select alternate authentication. Redirects fail; timeout is 60 seconds; there are no retries or fallbacks.

The factory selects OpenAI only when both the existing live mode and `INVOICE_MVP_PROVIDER=openai` are explicitly configured. Default mode stays deterministic; default live provider stays Anthropic. Construction, attestation, imports and decisions do not issue model requests. Existing per-batch live opt-in and atomic backend reservation requirements still apply. Root approved this minimal `service.ts` wiring; no Convex or accounting contract files changed.

Each request sets `reasoning.effort=high`, `service_tier=default`, `store=false`, `include=["reasoning.encrypted_content"]`, `tool_choice=auto`, `parallel_tool_calls=false`, and `prompt_cache_options={mode:"explicit"}` without breakpoints. The Responses function schemas use `strict:false` to preserve existing optional arguments; application validation and evidence checks remain authoritative.

Operator pricing and caps remain required through the existing `INVOICE_MVP_*` variables. OpenAI additionally rejects configured input limits above 100,000 or output limits above 4,096. Actual output per request defaults to 4,096 and must not exceed the configured output ceiling. Requests exceeding reservation bounds stop before dispatch. Reservations cover the full serialized request body, all earlier reported output tokens for opaque replay, and 4,096 protocol-overhead tokens. Persistent run-wide call/cost reservations remain held on failure; a replayed reservation cannot dispatch another request after restart.

## Continuation and audit

Every returned output item, including encrypted reasoning and assistant `phase`, is replayed unchanged alongside a native `function_call_output` carrying the exact selected `call_id`. State is private to the investigation's observation array in a WeakMap. The next result must match the selected tool name/arguments and unchanged case, evidence version, decisions and earlier observations. Reused call IDs, unexpected cache breakpoints, absent or malformed continuations fail closed.

Opaque provider state is neither returned to the service nor persisted to the backend. `investigate` releases it in `finally`, covering successful proposals, bounded stops and backend failures. Adapter failures also release it. Restart reconstructs work from durable evidence, never fabricates provider tool history, and remains subject to the existing replayed-reservation block.

Responses must report the exact configured model and default tier, complete consistent input/output/total/reasoning usage, and zero cache reads/writes. Cache-write detail counts, when supplied, must also be zero. Output tokens already include reasoning: pricing counts them once. The audit records the numeric reasoning count in a fixed usage summary, without provider prose, encrypted state or hidden reasoning. Missing usage has unknown cost; known input/output usage with incompatible model/tier/cache details retains counts and uses null cost. Complete but unusable responses retain their operator-priced usage. Malformed/no-tool/multiple-tool, incomplete or failed responses do not execute tools or retry.

Model-origin proposals still require human review. The model cannot approve a proposal or update totals. Existing deterministic processing and Anthropic tests remain intact.

## Runtime contract

`outputTokensPerCall` and `perRequest.maxOutputTokens` expose the actual request limit. Top-level `effort` is `high`; `toolsHash` hashes the actual Responses tool schema. With operator-supplied illustrative rates 2/10 microdollars per input/output token, `modelProvider` is:

```json
{
  "baseURL": "https://api.openai.com/v1",
  "api": "responses",
  "authentication": "explicit_api_key",
  "pricing": { "inputMicros": 2, "outputMicros": 10 },
  "servedModelValidated": true,
  "cacheUsageValidated": true,
  "serviceTier": "default",
  "promptCacheMode": "explicit_without_breakpoints"
}
```

Provider metadata, copied pricing and copied budget are frozen. Validation booleans describe implemented response checks, not a completed live validation. No credential or opaque continuation enters the attestation. Pricing is an operator-provided estimate, not a provider invoice or spending authorization. D owns evaluation-provider compatibility and executable live-command documentation.

## Official documentation checked

The [GPT-6.1-sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documents high reasoning, Responses tool support, and standard prices of $2/$10 per million input/output tokens for inputs up to 272,000 tokens. The prepared input ceiling stays below that pricing threshold. Prices and account access must be verified by root before any authorized spend.

The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) documents stateless encrypted reasoning replay, preserving output items and assistant phases, and reasoning tokens being included in total output usage. The [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents explicit mode with no breakpoints as disabling cache reads/writes, plus cache usage fields. The [function calling guide](https://developers.openai.com/api/docs/guides/function-calling) documents Responses function-call/output pairing and strict schema requirements. These official sources were checked on 2026-10-24; no authenticated API was used.

## Verification

`npm run typecheck`, `npm run invoice-mvp:test`, and `git diff --check` passed for the implementation above. The invoice suite contains **106 tests across six files**, including **52 OpenAI tests** using injected/mock fetch and synthetic credentials only. Coverage includes the transport settings and auth guard, factory defaults, immutable attestation, full continuation replay, isolation/cleanup, pairing and mutation checks, reservation bounds, usage and cache validation, safe failure audit, persistent reservations, and human-review authority.

The local untracked `node_modules` dependency symlink is intentionally preserved and excluded from commits. Root must integrate this implementation plus handoff and D's evaluation changes, then rerun combined verification. No live result or spend approval is implied by this handoff.
