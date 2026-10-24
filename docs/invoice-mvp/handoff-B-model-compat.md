# Worker B model compatibility follow-up

New native goal created with `create_goal` and confirmed **active** with `get_goal` before work. Worker scope is complete; native completion is reported after committing this handoff. Root retains integration/deployment and any authorized evaluation.

- Worktree: `/Users/junjiexiong/.codex/worktrees/a729/calhacks`.
- New branch: `codex/invoice-mvp-model-compat`; original delivered branch preserved.
- Exact integration base: `f1f03512528772a21da2445f0f698eb3511c88ce`.
- Implementation and tests: **`02e397096b17edc648abda61e7278c8a2e1e2f65`**.
- Owned files changed: `src/invoice-mvp/model.ts`, new `model.test.ts`, root-authorized minimal `investigator.ts` usage-error handling and `server.ts` attestation field, plus `INVESTIGATOR.md` and this handoff. No A backend/service files changed.

The configured model default remains unchanged. Anthropic requests now use `tool_choice: {type: "auto", disable_parallel_tool_use: true}`; Opus 5.5 does not support forced `any`/named-tool selection. No-tool, malformed, multiple-tool, truncated, refused or unsupported outputs end the bounded investigation after one request. SDK retries/fallbacks remain disabled. The model error retains usage, not provider content or hidden thinking; the investigator persists known cost/usage exactly once before recording the failure and leaving evidence unresolved.

The adapter requires an explicit `ANTHROPIC_API_KEY`. The SDK receives that key explicitly, `authToken: null`, and pinned `baseURL: "https://api.anthropic.com"`. Ambient `ANTHROPIC_BASE_URL`, auth token and profile cannot replace that endpoint/credential choice. Normal process-level proxy behavior is not rewritten. The runtime exposes this approved shape for the live adapter, or null when none is configured:

```json
{
  "modelProvider": {
    "baseURL": "https://api.anthropic.com",
    "authentication": "explicit_api_key",
    "pricing": { "inputMicros": 4, "outputMicros": 20 },
    "servedModelValidated": true,
    "cacheUsageValidated": true
  }
}
```

The prices above illustrate the operator-supplied settings; they are not hardcoded. Configuration copies/freeze the supplied prices, so a later mutation cannot alter the rates behind the startup attestation. The validation booleans describe implemented checks, **not a live-provider validation result**. The [official Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview#pricing), checked 2026-10-24, lists ordinary uncached input/output at $4/$20 per million tokens (4/20 USD micro-dollars per token). Verify current prices before any authorized spend. [Official tool-choice compatibility](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5#forced-tool-use-is-not-supported) was checked on the same date.

Every completed response must have `result.model === configured model` and zero cache usage. Unexpected model identity or cache tokens stop dispatch. Known ordinary input/output counts and latency persist as `model_usage_unavailable`; the audit omits the unknown `costMicros` and the processing result sets `usage.costMicros` to null. It never reports an unknown cost as zero. The full conservative reservation remains held. Failed transport requests without a response do not fabricate usage.

Verification at the exact implementation commit:

```sh
npx vitest run src/invoice-mvp/model.test.ts src/invoice-mvp/investigator.test.ts src/invoice-mvp/server.test.ts
npm run typecheck
```

**41 tests passed across three files; typecheck passed.** The new model suite contains 22 mocked-SDK tests. It checks first-party/key pinning under hostile ambient configuration, no auth-token/profile-only fallback, unchanged model, `auto` selection, no retries, no implicit requests, exact served-model validation, cache rejection, immutable price attestation, malformed/no-tool usage preservation, single usage audit before failure, unavailable-cost semantics and absence of provider prose/thinking in persisted errors.

**No live calls, no API spend, no deployment. Live-model validation remains NOT RUN.** The SDK class was replaced with an in-process mock for every new transport test. Runtime code has no uncommitted follow-up changes; an untracked `node_modules` dependency symlink remains local and is not part of the commit.
