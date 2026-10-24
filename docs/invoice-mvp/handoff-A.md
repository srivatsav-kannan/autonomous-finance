# Worker A handoff — durable invoice case backend

## Goal and source control

Native `create_goal` activated this assignment and `get_goal` confirmed `active` in the first progress update. The goal covers Worker A implementation, focused verification and this committed handoff; integrated real-backend/browser acceptance belongs to the root. Scope completion is reported using the native lifecycle after the handoff commit.

- Base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c` (includes PR #51).
- Worktree: `/Users/junjiexiong/.codex/worktrees/0a5f/calhacks`.
- Branch: `codex/invoice-mvp-cases`.
- Shared interface commit: `a8d81dc6924498f5827d18ef5817570532cbdb97`.
- Exact implementation/test commit: `681aa080b0ee5f533aeb484c760295ed06abcd20`.
- Final follow-up commit contains this handoff. Its SHA is sent to the root after commit.

Owned changes: `convex/invoiceCases.ts`, additive `convex/schema.ts` definitions, `convex/_generated/api.d.ts`, `src/invoice-mvp/contracts.ts`, `tests/invoice-mvp-cases.test.ts`, this handoff. No other worker files changed. No deployment, provider call, API spend, cash/bank operation, push or independent PR.

## Contract and backend

All new functions authenticate `runId`, `seatId`, `token` server-side using existing seat authentication and run membership. Human authority requires both role `human_cfo` and kind `human`; investigator authority requires agent-kind `ar_clerk` or `controller`. `auditor` can read. Human identity is explicitly simulated in the workspace snapshot. Existing run bootstrap is `admin.createRun`, with SHA-256 seat token hashes.

Backend responses uniformly use `BackendResult<T> = {ok:true,value:T,replayed?:boolean} | {ok:false,code,error}`. B unwraps the value for HTTP. Exact types are in the shared contracts file, with validators in schema and endpoint arguments in `invoiceCases.ts`.

- Queries: `workspace`, `caseDetail({caseId})`, `pendingCases`, `modelBudget`.
- Human mutations: `ingestBatch({label,documents,idempotencyKey})`, `decide(DecisionInput)`.
- Investigator mutations: `beginInvestigation({caseId})`, `submitProposal(SubmitProposalInput)`, `recordToolCall({caseId,evidenceVersion,call,idempotencyKey})`, `reserveModelRequest(ReserveModelRequestInput)`.
- Human or investigator mutation: `registerCustomer(RegisterCustomerInput)`.

Sources, proposals, decisions and audits are append-only. Source identity is server-hashed SHA-256 of original decoded bytes where supplied, otherwise exact extracted text. Every immutable source version has a case and visible state. Different names with identical bytes become visible duplicates with a canonical source pointer. A retry of an older version returns that historical version and cannot remove a newer accepted effect. Changed content for the same external ID, or explicit `replacesExternalId`, supersedes the old case and deactivates its contribution in the same mutation. Textual revision claims require a source-cited proposal and human acceptance; they cannot silently delete prior contributions.

New evidence invalidates pending proposal pointers and increments evidence versions; immutable history remains. `evidence_missing` resumes only on new evidence. `investigating` can be resumed immediately after a process restart without a permanent lease. Completed work is not reset by retries or unrelated evidence. Human decisions bind exact proposal, case and evidence version; exact idempotent retries return the stored historical result without a new effect. Different payload reuse and second conflicting decisions are rejected.

Exact evidence identity, source quotes, same-workspace membership, current versions, positive safe integer cents, registered customer identity, own-source trace, supporting-document exclusions and USD are validated server-side. A customer/document number can have only one active contribution. Aggregate integer overflow is rejected before acceptance. Invoices and credits affect deterministic gross/credit/net totals; zero-total customers from the existing customer master are included.

## Accounting boundary

The approved `invoiceContributions` table is a focused accepted-evidence subledger for **net invoiced totals**. It does not represent outstanding balances or prove payment. It does **not** post receivables, revenue, cash, tax, or reversals into the existing GL, and it does not modify `customerDocuments`. Existing PR #51 `customers`, seat authentication, idempotency and document-number normalization are reused. Thus the original journal and banking workflows are not duplicated or reconciled by this MVP. Replacement deactivates the old contribution while retaining its trace; it is not a cash or GL reversal.

## Deterministic validation versus judgment

`mode: deterministic` alone grants no acceptance. Auto-inclusion requires the backend's narrow routine grammar: first line `INVOICE` or `CREDIT MEMO`, one `Customer ID:`, one `Invoice Number:` / `Credit Memo Number:` / `Document Number:`, `Total: USD 123.45` and/or matching `Amount Cents: 12345`, optional `Customer:` and `Currency: USD`. Extra unknown lines, printed voids, revision claims, contradictions or missing evidence require review. Only explicit supporting email/statement evidence and the standard customer-master CSV header can be deterministically excluded. Unknown exclusions require review.

Model proposals always require human acceptance. Unfamiliar layouts can be accepted by a human when the original source contains the registered customer (ID/name/known alias), invoice/credit title, number and proposed amount. Missing evidence remains visible and cannot be accepted into a contribution. Unsupported source fields, fabricated quotes, supporting email invoice spoofing and explicit non-USD currency fail validation. The grammar is deliberately conservative, not an autonomous semantic verifier of arbitrary PDFs.

## Large originals and budget preparation

Root approved `invoiceSourceChunks`: original base64 is stored in immutable 128,000-character chunks scoped by run/document. Source records retain extracted text and metadata, so workspace queries never return all original bytes. Authenticated case detail reconstructs originals. The test roundtrips **1,100,000 original bytes**, above Convex's per-document limit. Each mutation accepts at most 10 MB of source-envelope JSON; each source's extracted text is limited to 750 KB. B/D should submit bounded batches (D selected <=2 MB HTTP batches). Repeated historical versions in a single detail response remain subject to Convex's 16 MiB transaction/result limits; the known benchmark per-file sizes fit. Original PDFs are preserved as bytes; this backend does not perform PDF extraction.

Root approved persistent budget tables and API:

`reserveModelRequest(auth + {caseId,evidenceVersion,idempotencyKey,model,maxCostMicros,budget:{maxRequests,maxCostMicros}})` returns a reservation ID and persistent counters. The initial run-wide limits are immutable; every reservation atomically charges one request and full worst-case cost before any provider call. Counters survive application restart. No automatic refund exists. Exact retry returns `replayed:true`; **B must not call a provider for a replayed reservation**, because a prior dispatch may already have spent money. The authenticated read-only `modelBudget` query returns current limits/counters or null. This is preparation, not spend authorization.

## Verification tied to implementation commit

At `681aa080b0ee5f533aeb484c760295ed06abcd20`:

```sh
npm test
# 19 files, 203 tests passed; 24 new focused invoice tests.
npm run typecheck
# passed
./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json
# passed
git diff --check
# passed before commit
```

The focused suite covers duplicates and retries, same-ID revisions and atomic replacement, textual revision decisions, old-version replay, stale proposal/evidence approval, conflicting human answers/idempotency, missing evidence and resume, persisted handler recovery, unsupported amounts/quotes/currencies, canonical business-number conflicts, safe-integer aggregation, authenticated reads/writes and human/investigator separation, original-byte chunks, source metadata conflicts, immutable tool telemetry, zero-total customers, and persistent budget reservation/replay/exhaustion.

These are **deterministic in-memory handler tests** using the existing kernel harness. That harness persists DB state across new handler contexts but does not emulate transaction rollback, OCC retries, deployment/runtime constraints, actual backend process restart, HTTP sessions, model calls or browser behavior. The tests therefore do not claim live durability or concurrency validation.

## Root-owned live acceptance

The root requested direct integrated API checks rather than an additional worker smoke entrypoint. Live Convex smoke: **NOT RUN by Worker A**. Application/backend process restart, transaction concurrency, HTTP sessions and the browser flow must be verified on the integrated backend by the root. Live-model evaluation: **NOT RUN**. Official benchmark score: **NOT RUN**. Browser acceptance: **root-owned, NOT RUN by A**.

## Integration notes and limitations

No unresolved API dependency remains for B. Root approved additive schema, source chunks and persistent model-budget reservations. The actual integrated deployment and browser flow remain the root's acceptance work. Existing unrelated APIs retain their prior permission behavior; the new invoice API does not claim to harden the whole historical simulation. New writes require an active workspace. Customer names cannot be silently renamed; unsupported customer aliases require human registration. Large-scale pagination, general source extraction, semantic PDF authenticity and live payment/GL integration are outside this scope.

## Follow-up: measured original-import write throughput failure

A new native goal was activated after root reported a sealed full-input import failure. The isolated branch was rebased onto root's integrated `f1f03512528772a21da2445f0f698eb3511c88ce`; Git recognized the earlier A commits already present and preserved them through the integrated history. Root explicitly approved the narrow ownership exception for the application backend adapter. Fix commit: **`11168b846581189cf82baebcb975db9d28e145d8`**. Files: `src/invoice-mvp/backend.ts`, `tests/invoice-mvp-transport.test.ts`; no Convex function/schema, service scheduling, provider/model or evaluation implementation changed.

The original failed workspace `invoice-original-first` was read only. Its sealed snapshot remained 72 batches, 105 documents, 18 customers, 104 evidence-missing cases and 1 review case. No hidden expected outcomes or answer keys were accessed. Root supplied only the failing source envelope at `/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/diagnostics/original-failed-batch-72.json` (one PDF, 893,926 raw bytes / 1,191,904 base64 characters / 23,973 text bytes). That envelope succeeded unchanged in a fresh diagnostic workspace and with 105 synthetic accumulated sources, so a per-file regex/size failure was not reproduced.

The reproducible low-level error emerged while replaying the sealed run's **source inputs only** in their original batch order into another fresh diagnostic run, with the same background 25-case processing behavior. After 36 successful batches, the unmodified adapter threw:

```text
{"code":"TooManyWrites","message":"Too many writes per second. Your deployment is limited to 4 MiB bytes written per second. Reduce your write rate or upgrade to a larger deployment."}
ConvexHttpClient.mutationInner (convex/src/browser/http_client.ts:388)
ConvexHttpClient.processMutationQueue (convex/src/browser/http_client.ts:421)
```

This is a measured backend write-rate failure, distinct from per-document and per-transaction limits. The original sealed HTTP 503 discarded its inner error; the exact original event cannot be retrospectively inspected, but the same input workflow reproduced this specific failure. No speculative schema or concurrency changes were made.

The fix retries **only** an `Error.message` that parses as JSON with exact code `TooManyWrites`. All authenticated mutation payloads and idempotency keys remain identical across attempts. Delays are explicitly 250, 500, 1,000 and 2,000 milliseconds: at most five attempts and 3.75 seconds of waiting per write. Exhaustion throws `InvoiceError` code `backend_rate_limited`, status **429**, with guidance to retry the same key or import smaller batches. Other errors, returned stale/conflict results and reads are not retried. This wrapper never calls or retries a model provider. Budget-reservation replay remains marked `replayed: true`, preventing accidental fresh provider authorization. The runtime's existing model retry count of zero is unchanged; backend transport retry policy is separate.

Verification at the fix commit:

```sh
npx vitest run tests/invoice-mvp-transport.test.ts src/invoice-mvp/service-backend.test.ts
# 13 passed (10 new transport regressions + 3 existing service/backend integrations)
npm test
# 24 files, 245 tests passed
npm run typecheck
# passed
npx tsc --noEmit -p convex/tsconfig.json
# passed
npx tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target es2022 --module esnext --moduleResolution bundler --types node --skipLibCheck tests/invoice-mvp-transport.test.ts
# passed
git diff --check
# passed
```

The injected-failure tests use injected waits without sleeps. They verify identical payload identity, bounded exhaustion and 429, exact error classification, unrelated/non-rate errors receiving no retry, stale decisions receiving no retry, one durable source/batch/case after a persisted attempt is replayed, and retained budget-reservation replay flags. These remain deterministic handler/transport tests rather than provider evidence.

A **live local-backend diagnostic**, using the patched adapter without changing the deployed Convex functions, then succeeded in fresh run `invoice-a-diagnostic-backoff`:

- Replayed all 72 original source-prefix batches plus the supplied failing batch: **73 batches / 106 persisted documents**.
- Encountered and recovered from **3 measured write-rate-limit responses**, with **750 ms** total injected production-equivalent wait, in **23,969 ms** elapsed import time.
- Concurrent background processing reported 50 retryable case errors during import. A subsequent bounded processing call after import processed 106 cases with **zero errors and zero remaining pending cases**. Final states: 105 evidence-missing, 1 review, 0 recorded. This is transport/resume evidence, not accounting accuracy or a benchmark score.
- Metadata-only result record: `/Users/junjiexiong/.codex/invoice-mvp-evaluation-private/diagnostics/worker-A-write-backoff-result.json`.
- The original sealed run was untouched. No deployment, model call, API spend, scoring or hidden-answer access occurred. The full 148-document second transport attempt and official evaluation remain root/D-owned.

The diagnostic can be repeated by initializing a fresh local run with `scripts/invoice-workspace-init.ts`, reading only `workspace.batches`/case source inputs from the sealed run in batch order, importing those envelopes through `InvoiceService`, and running bounded `processPending` during and after import. Preserve the original failed run; use new run IDs and fresh import keys. Original-byte and extracted-text content must be copied unchanged. The live diagnosis created separate runs `invoice-a-diagnostic-20261024-1`, `invoice-a-diagnostic-originalprefix` (failed reproduction) and `invoice-a-diagnostic-backoff` (successful post-fix verification), retained for audit.
