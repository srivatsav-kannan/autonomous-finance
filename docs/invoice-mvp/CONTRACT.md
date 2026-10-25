# Invoice evidence MVP contract v1

Scope: one company per local workspace, USD, net invoiced totals (not outstanding balances or cash). Reuse PR #51 at `951b2df51fccbb3c380eb84abff08b4b1aee068a`, based on main `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`. No live bank operations. The prior thirteen-seat simulation remains historical infrastructure; the new workflow uses one bounded Investigator. Defer a second model reviewer unless measured evidence earns its complexity.

## Ownership and compatibility

Worker A owns `src/invoice-mvp/contracts.ts`, `convex/invoiceCases.ts`, schema additions and generated Convex declarations. A implements the types below; others request changes through the orchestrator. B owns application service/gateway/runtime under `src/invoice-mvp/` excluding contracts. C owns focused UI under `console/`. D owns `evals/invoice-mvp/` and evaluation reports, plus a new Invoice Sandbox system adapter. Do not overwrite unrelated code. All workers read REQUEST.txt. No worker creates other workers, spends API money, deploys, merges main, or accesses held-out answers except D.

## Source and evidence

`SourceInput = {externalId:string, name:string, mimeType:string, text:string, contentBase64?:string, replacesExternalId?:string}`. Preserve original bytes where supplied, extracted text and SHA-256 content identity. Server computes hash; caller hashes are never authoritative. Ingestion is idempotent for same source identity/content. Same external ID with changed content creates an immutable new version, supersedes its earlier version, invalidates pending proposals and removes the earlier accepted effect atomically. Duplicate bytes under another name remain visible as a duplicate with a canonical evidence reference. Revision claims from document text require verification/decision, not blind deletion. Explicit importer replacement is versioning. Every source version has one visible disposition or unresolved state.

`EvidenceRef = {documentId:string, version:number, contentHash:string, quote?:string}`. References must exist in the same workspace, match exact immutable versions and (if given) contain the exact quote. Original source is visible in case detail. Evidence-set version increments when relevant evidence is added; conservative invalidation on any batch source change is acceptable initially.

## Conclusions and lifecycle

`Treatment = 'include_invoice'|'include_credit'|'exclude'|'needs_evidence'`.
`Conclusion = {treatment:Treatment, customerId?:string, customerName?:string, documentNumber?:string, amountCents?:number, reason:string, evidence:EvidenceRef[], contradictions:string[], missingEvidence:string[], question?:string, category?:string, supersedesDocumentId?:string}`.
Amounts are positive safe integer cents; credits subtract deterministically. A recorded contribution must have a customer, document number, amount and source evidence. Supporting emails/bank exports never constitute invoices. No model writes totals. Customer aliases must be supported by source evidence or human decision. Include zero-total registered customers in benchmark output.

`CaseStatus = 'received'|'investigating'|'needs_review'|'evidence_missing'|'recorded'|'excluded'|'superseded'|'duplicate'`.
Validated transitions: received -> investigating; investigating -> needs_review/evidence_missing/recorded/excluded; review -> recorded/excluded/evidence_missing; missing -> investigating when new evidence/answer arrives; any current case -> superseded only through explicit versioning/replacement. Retrying work must not lose completed effects. Unknown layouts and conflicts require investigation, not silent exclusion. Work and audit history survive process/backend restarts. Avoid permanent investigating leases; resume incomplete work safely.

An immutable `Proposal` binds case ID, proposal ID, evidence version, complete conclusion, author/mode, and creation time. Persist proposed and accepted conclusions separately. Deterministic validation may accept supported routine proposals. Model-origin proposals and ambiguous conflicts require human acceptance for this first MVP. Source changes invalidate old approval. Replacing proposals is append-only.

`DecisionInput = {caseId:string, proposalId:string, evidenceVersion:number, idempotencyKey:string, action:'accept'|'exclude'|'request_evidence', note?:string}`. Human decisions are authenticated server-side, exact-replay idempotent, conflicting reuse rejected. No arbitrary human-entered amount gets silently counted. Requests for new evidence remain visible and can resume on new documents; acceptance of a proposal is the recorded response used by resumed processing. Bind decisions to immutable proposal/evidence IDs, never just case ID. One accepted accounting effect per current canonical document, with full source trace. Audit every transition, decision, tool call and concise summary; never hidden chain-of-thought.

## Backend and service API

Convex remains durable source of truth. Protect new queries AND mutations using backend seat auth and workspace/run membership. Human authority is distinct from investigator authority. Existing local human seat is a simulated identity and must be labeled so. Keep secret/token server-side. Gateway binds loopback with same-origin/allowed-origin checks and explicit session auth for writes; browser cannot choose investigator/admin privileges. Preserve existing unrelated endpoints.

B provides `src/invoice-mvp/service.ts` reusable application boundary and a loopback HTTP server (default :8790). UI uses `/api/invoice-mvp` via Vite proxy. Required routes:

- `GET /api/invoice-mvp/workspace` -> persisted workspace snapshot (company, batch IDs, progress, cases, customer totals, runtime mode).
- `POST /api/invoice-mvp/batches` body `{label:string,documents:SourceInput[]}` -> `{batchId:string}`; import originals through this boundary, schedule processing; UI can poll.
- `GET /api/invoice-mvp/cases/:caseId` -> source versions, proposals/current proposal, status, contradictions, missing evidence, question, audit and tool summaries.
- `POST /api/invoice-mvp/decisions` body `DecisionInput` -> persisted result then resume processing.
- `POST /api/invoice-mvp/process` -> bounded resume of pending work (idempotent, operator-authorized).
- `GET /api/invoice-mvp/demo-batch` -> public synthetic demo input, not hidden evaluation fixtures.

Use consistent `{error:{code,message}}` errors, with 400 invalid, 401/403 unauthorized, 409 stale/conflict. B and C coordinate exact snapshot shapes via A's types, no independently invented substitutes. Browser can select demo or upload plain text/JSON/CSV (and PDFs if extraction is available); show supported formats honestly. PDF extraction for benchmarks may happen upstream via existing pypdf, preserving original bytes and provenance, with both baseline and app given equivalent extracted text. Original source download/display is required.

## Investigation and evaluation

B: bounded observe -> select tool -> result -> next action with inspect_source, related_documents/customers, policy, propose_disposition, ask_human. Code calculates totals and enforces invariants. Tool responses are untrusted data. Document instructions never authorize actions. Record mode `deterministic`, `mock_model`, or `live_model`, model/config, tool calls and token/cost usage. Unknown evidence without a model remains unresolved with a useful question. API calls need explicit opt-in and a hard pre-request resource budget; no background spend. Preserve useful parser regression checks but do not execute untrusted generated code in the new workflow.

D freezes protocol before observing new scores. Invoice Sandbox uses only the reset workspace as model input, pinned upstream README rules and unmodified official scorer. Official task: every CRM customer's valid invoice count, gross invoiced total, positive credit total and net gross-minus-credit; exclude voids, superseded originals, duplicate scans, statements, email-only totals and bank deposits. Scorer details must be verified directly by D against pinned upstream. Adapter ingests via B service/HTTP and reads persisted Convex results; no alternate reasoning path. Record commit, config, dataset hash, commands, source access, budget, runtime, usage, coverage, unsupported conclusions, unresolved cases, decisions and duplicate effects. Separate deterministic, mock integration, live app, official benchmark and custom robustness results. Keep hidden expectations outside all implementation contexts until first scored run is recorded. Later changes are post-fix. No live run without authorized spend. No unsupported 18/18 claim.
