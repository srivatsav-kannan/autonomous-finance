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
