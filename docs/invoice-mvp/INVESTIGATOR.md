# Invoice investigator and application boundary

The invoice MVP uses one bounded Investigator. The default is **deterministic supported-format processing**, not a language model. Unknown formats remain unresolved with a specific evidence request. Synthetic mock-model tests exercise the observe → tool → result → next action loop. Live model and official benchmark evaluations are **NOT RUN**.

## Startup

The root integration worker owns provisioning the existing local Convex backend and `scripts/invoice-workspace-init.ts`. Do not deploy a worker checkout's signature-only backend. Initialize a run with one simulated human CFO and one `ar_clerk` investigator. Save the resulting token mapping to a mode-0600 file outside source control.

```sh
CONVEX_URL=http://127.0.0.1:3230 \
INVOICE_MVP_RUN_ID=invoice-demo \
INVOICE_MVP_SEATS_FILE=/absolute/path/to/seats.json \
npm run invoice-mvp:server
```

Defaults: `INVOICE_MVP_PORT=8790`, `INVOICE_MVP_HUMAN_SEAT=human-cfo`, `INVOICE_MVP_INVESTIGATOR_SEAT=invoice-investigator`. Seat tokens can alternatively come from `INVOICE_MVP_HUMAN_TOKEN` and `INVOICE_MVP_INVESTIGATOR_TOKEN`. They are never returned to the browser. The runtime does not accept an admin secret or create seats.

The Vite UI proxies `/api/invoice-mvp` to this loopback server. The allowed browser origins default to `http://127.0.0.1:5173`, `http://localhost:5173`, and the two loopback gateway origins. Set `INVOICE_MVP_ALLOWED_ORIGINS` to a comma-separated exact list when using another port. Preserve Origin in the proxy.

1. GET `/api/invoice-mvp/workspace` establishes the local `HttpOnly; SameSite=Strict` session cookie.
2. POST with that cookie, `X-Invoice-MVP-Session: 1`, an allowed `Origin`, and `Content-Type: application/json`.
3. The browser uses `credentials: "same-origin"`; it never chooses a backend role.

Read routes enforce loopback Host, loopback peer, allowed Origin when present, and reject cross-site fetches. Write routes additionally require the session and exact Origin. Local identity is simulated; this is not production authentication.

## Routes and reusable service

Required workspace/batch/case/decision/process/demo routes follow `CONTRACT.md`. `GET /api/invoice-mvp/runtime` additionally returns startup source commit/dirty state, mode/configuration, prompt/tool hashes, usage provenance and import limits. It contains no credentials. Restart the gateway after a source change; attestation identifies what was loaded at startup.

`InvoiceService` and `createServiceFromEnv()` in `src/invoice-mvp/service.ts` are the application entrypoints for both browser and evaluation work:

```ts
const service = createServiceFromEnv();
await service.ingestBatch({ label, documents, idempotencyKey });
const result = await service.processPending({ maxCases: 25 });
const persisted = await service.workspace();
```

`ingestBatch()` persists input. The HTTP route schedules bounded processing; direct service users call `processPending()` explicitly. Decisions persist first and then resume eligible pending work. Startup resumes durable received/investigating cases. Evidence-missing work does not retry automatically without backend eligibility changing. Processing failures become a visible evidence request when the backend is reachable; outages leave durable work for retry.

## Public demo

GET `/api/invoice-mvp/demo-batch` returns eight public synthetic sources: customer records, an invoice, a credit, a duplicate scan, an original invoice, a disputed invoice and an unfamiliar service recap. Import this body via the batches route, then process or poll.

GET `/api/invoice-mvp/demo-batch?stage=late` returns the corrected invoice in a separate batch with the original external ID. This deliberately exercises late arrival and immutable versioning. The disputed invoice's exact proposal can be accepted or excluded; the unfamiliar recap asks for an issued invoice or exclusion. Case detail contains original sources, proposals, decisions, contributions and tool/audit summaries.

## Source and parser limits

The application preserves supplied original bytes. PDF input requires original base64 and upstream extracted text; there is no PDF extractor in this gateway. Plain text, JSON and CSV are supported uploads. Other MIME types remain visible as unsupported evidence. UTF-8 text originals must match extracted text exactly, except documented CRLF-to-LF normalization. Neither original bytes nor document instructions authorize backend actions.

Limits per request: 100 documents and 9,500,000 UTF-8 encoded JSON bytes. Each original is at most 6 MiB; each extracted text is at most 750,000 UTF-8 bytes. Import large collections in bounded batches; do not strip originals to meet limits.

Routine text starts with exact `INVOICE` or `CREDIT MEMO`, with explicit `Customer ID`, `Customer`, document number, and `Total: USD 123.45` or integer cents. The backend independently validates the supported routine grammar. JSON/CSV billing extraction yields candidates requiring human review. Repeated fields, status disputes and revision claims require review. Customer CSV accepts unique `customer_id` plus `legal_name`, `customer_name` or `name`, with optional literal aliases separated by `;` or `|`. Customer records are processed before invoice sources, including customers with no invoices.

## Model boundary and evidence

Tools: `inspect_source` (offset/limit paging), `related_documents`, `related_customers`, `policy`, `propose_disposition`, and `ask_human`. The loop has a ten-action default bound and records concise tool results/usage, not hidden chain-of-thought. Proposals must cite inspected exact source versions and match source quotes. Code and the backend calculate amounts and enforce permissions; models cannot approve proposals or write totals. Every model-origin proposal requires a human decision. No second reviewer is implemented because no measurable benefit has been established.

The Anthropic adapter uses existing `AGENT_MODEL` configuration, explicit opt-in, maximum token prices supplied by the operator, max output tokens, no SDK retries and no fallback. Before every provider call, A's backend atomically reserves a request and worst-case cost against immutable run-wide caps. Replayed reservations never authorize another call, including after a crash. Reservations are not refunded automatically. Input/output token ceilings apply per request; total requests and cost apply to the persisted workspace. No model request should be made until the user authorizes a concrete batch budget. Merely providing a credential does not enable model calls.

The invoice adapter specifically requires `ANTHROPIC_API_KEY`; ambient auth-token/profile credentials are not accepted. Its SDK client explicitly pins `https://api.anthropic.com`, so `ANTHROPIC_BASE_URL` cannot redirect source data. Standard process network proxy configuration is not rewritten; the API endpoint and explicit credential are pinned. Runtime metadata exposes `modelProvider: {baseURL, authentication, pricing: {inputMicros, outputMicros}, servedModelValidated: true, cacheUsageValidated: true}`. The booleans describe implemented response guards, not evidence of a live provider run. Pricing is copied and frozen when the model is constructed.

Opus 5.5 rejects forced tool selection; the adapter uses `tool_choice: auto` and stops without a retry if the provider returns no usable tool action. This is documented in the [official model changes](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5#forced-tool-use-is-not-supported), checked on 2026-10-24. The [official model pricing](https://platform.claude.com/docs/en/models/opus-5-5/overview#pricing), checked on the same date, lists ordinary uncached input/output at $4/$20 per million tokens, equivalent to 4/20 USD micro-dollars per token. Those are dated preparation references, not hardcoded billing guarantees; authorized evaluation preparation must verify current prices before setting the caps.

Completed responses retain provider token usage even when their action is malformed, missing, refused or truncated. An exact served-model mismatch or nonzero cache usage stops the loop. Such responses preserve known input/output counts but mark cost unavailable: audit event `model_usage_unavailable` omits `costMicros`, and the processing result has `usage.costMicros: null`. The full reservation remains charged. Known, priceable usage is persisted once as `model_usage` before `model_failure`. Neither error path records provider prose or hidden thinking.

To configure an authorized live batch, set `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, `INVOICE_MVP_MAX_MODEL_CALLS`, `INVOICE_MVP_MAX_COST_MICROS`, `INVOICE_MVP_MAX_INPUT_TOKENS`, `INVOICE_MVP_MAX_OUTPUT_TOKENS`, `INVOICE_MVP_INPUT_TOKEN_MICROS` and `INVOICE_MVP_OUTPUT_TOKEN_MICROS`. Token prices must be conservative operator-verified upper bounds for the configured model. `INVOICE_MVP_OUTPUT_TOKENS_PER_CALL` defaults to 1200. Then explicitly POST `/process` with `{ "live": true }`. Startup, ingestion and decisions do not make background live calls. Routine supported documents still use deterministic processing. These live settings have not been exercised against a provider.

Actual provider usage and conservative request reservations are separate audit events (`model_usage` versus `model_reservation`). Mock usage is explicitly `mock_model`. Zero deterministic usage is not evidence of successful model extraction. No API credits were used during this worker's verification.

## Verification

```sh
npm run invoice-mvp:test
npm run typecheck
```

The focused tests cover both a small test-only backend double and the actual Convex handlers inside the repository's DB harness. They verify bounded deterministic/mock behavior, source preservation, import validation, recovery orchestration, HTTP security, deterministic accounting, late revisions, stale approvals, and replay. The harness does not simulate Convex transaction concurrency. A separate deployed-backend smoke check is recorded in the handoff. Root owns integrated browser acceptance; a passing mock suite is not that acceptance or an official benchmark score.
