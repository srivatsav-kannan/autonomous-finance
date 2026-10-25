# Workstream assignments

These are logical owner instructions for Master to dispatch after the readiness/contract gate. Each scoped assignment must include actual paths, IDs, refs and acceptance criteria from the registry. No worker is launched by this file.

## A — Evidence & Data

Own the Golden State reproducible packet and document ingestion. Reuse supplier identity, USD, Net 14, contract prices and supported account mapping. Export the matching receiving event; author a clearly synthetic PO only where required; render PDFs from frozen facts. Preserve original amounts, document IDs, source hashes/versions, timing and correction relationships.

Implement LlamaParse behind a replaceable adapter with saved raw output and source grounding. Map to the shared supplier-bill candidate. Keep uncertainty visible and reimports idempotent. Never claim synthetic files are real supplier originals, nor parser success equals business approval. Work offline on fixtures/adapters when credentials are absent; label live parsing NOT_RUN until measured.

For A2, follow LLAMAPARSE-GROUNDING.md: request native word/line/cell grounding and raw words at job creation. When native regions are missing, attempt unique exact raw-word alignment, then a bounded local OCR fallback; otherwise return explicit unresolved geometry. Preserve normalization, token references, source version, coordinate frame and transform, engine/model/config versions and failure reason. Do not force fuzzy letter/number corrections, overwrite invoice values or invent cell borders. Return multiline text as separate derived regions. Package/pin Tesseract and traineddata in the target runtime; PSM 6 succeeded on one diagnostic scan, not all invoices. Test OCR failures, unavailable dependency, ambiguity and reparse/version binding. Retain licensing/provenance; the archival scan is not an automatically publishable fixture.

Deliver: reproducible input packet, provenance manifest, parser adapter, extraction/evidence tests and same-case candidate output. Independent expected-outcome review belongs to a separate reviewer, not the runtime agent.

## B — AP & Accounting

Own the reviewed-document-to-bill bridge, matching/exception decisions, explicit company policy and accounting treatment. Reuse the AP checks and scoped bill APIs, without treating customer net-invoiced totals as AP.

Persist case/source/review/bill links; distinguish field review, bill acceptance and payment authorization. Cover missing references, unknown SKU/units, duplicate/revised documents, credits and owned exceptions. Proposed short-pay requires explicit policy authority or an authorized decision. A note cannot stand in for sent/delivered communication. Preserve invoice, accepted, disputed and outstanding amounts. Prevent double expense recognition and duplicate credit use.

Define which missing/ambiguous field or location states hold each workflow step, with an owner and permitted resolution. Geometry quality and business validity are separate; native or fallback coordinates do not bypass review or authority. Changed source/review versions cannot retain stale evidence bindings. Unresolved geometry must neither silently approve a bill nor introduce an undocumented blanket rejection policy.

Deliver: backend bridge and controls, precise permissions, journal assertions and negative tests. Master owns shared schema/migration changes unless specifically delegated.

## C — Payments & Integrations

Own same-case payment handoff and external readiness. Preserve saved requests, durable keys, reservations, fenced workers, bank observation and journal deduplication. Keep unknown bank outcomes unresolved until observed; never issue a replacement payment merely because a response was lost.

First verify the integrated FakeBank path (I1) and its negative/recovery cases (V2). C2 then verifies Increase with an explicitly configured sandbox account/beneficiary and authenticated human authorization. Provider authentication and resource readiness checks may happen earlier; they do not satisfy C2. Polling and webhook verification are separate evidence. Record configured/authenticated/workflow-verified states.

After V2, implement business payment scheduling as C3 and selected external accounting sync as C4. C3 has no ERP access gate; distinguish business due dates from retry times and preserve payment authorization and durable execution controls. Only C4 requires the selected ERP provider and verified access, with external record IDs, idempotent sync and reconciliation evidence. Coordinate later partial-allocation support with B3. Keep C3 and C4 independently trackable; both remain required for final acceptance.

Deliver: authorized payment integration, crash/recovery evidence, bank/journal reconciliation and later provider-specific acceptance. Do not rewrite the existing engine or initiate real-money transactions.

## D — Experience & Assurance

Own the case workspace, original-document highlights, exception/approval queues, accounting views and observable case timeline. Use actual linked case records, not unrelated seeded screens. Preserve accessibility and a polished demo. Explain the 13 accounting terms from issue #97 at relevant evidence-backed moments.

Expose native, derived and unresolved grounding distinctly, with source/version and fallback method available. Map actual page dimensions, pixels/points and rotation correctly. Use separate line regions; an amount-only row box must never highlight the description. If precise geometry is absent, show explicitly labeled page/table context. Verify all three states in the real browser, including stale-version and ambiguous cases.

Supply browser evidence to the independent verifier assigned directly by Master; self-checks are not independent acceptance. Cover exact amounts, identity/version binding, authorization denial, duplicate inputs, corrections and recovery. Model judges may assist qualitative scoring, but exact financial invariants use deterministic assertions. Domain reviewer sign-off is recorded separately.

Deliver: browser-verified same-case flow, source/journal drill-down, screenshots where useful, measured outcomes, startup instructions and a capability matrix. Shared App.tsx edits need one owner per wave.

## Worker handoff format

Task ID / owner and parent / session ID / canonical registry path / adopted spec hash / worktree / branch / source SHA / backend and ports/run ID / files changed / contract version / commit or PR / checks and results / evidence paths / unresolved gaps / next action. Master alone writes the canonical registry.

Return real evidence even for a partial contribution. State what was not run and why. Do not mark live verification passed from mocks, previous runs or a test that merely repeats the implementation.
