# Worker B handoff

Native goal was created and verified with `create_goal`/`get_goal` at assignment start. Last verified native status during handoff preparation: **active**. Worker implementation and acceptance checks are complete. Per root's final instruction, native completion is reported after this handoff is committed; the separate root goal retains integrated browser/evaluation acceptance. No subordinate chats or agents were created.

## Identity and exact commits

- Original repository: `/Users/junjiexiong/Desktop/calhacks` (`autonomous-finance`).
- Assigned isolated worktree: `/Users/junjiexiong/.codex/worktrees/a729/calhacks`.
- Branch: `codex/invoice-mvp-investigator`.
- Common exact base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c`.
- Worker implementation: `3d00f74222e980f23eb6ab5c27acd16592927d91`.
- Atomic reservation, bounded related-source access, actual handler integration and corrected demo: `6365baefa3d31c52f1f9d44b284f9f5a94e4f334`.
- Deployed HTTP/original-byte smoke: `2a59bc5a87ede1cec8d9cc903f37f56a42bfa9e6`.
- Dependencies already owned/integrated by root: A interface `a8d81dc6924498f5827d18ef5817570532cbdb97` (local cherry-pick `b4c5a06`), A backend `681aa080b0ee5f533aeb484c760295ed06abcd20` (local `2a9ea92`), root grammar fix `af9dfec` (local `44c2ca7`). Do not cherry-pick those local duplicates into integration.

Root should integrate the three B implementation commits above plus this documentation commit. No push, independent PR, deployment, external communication, billing change or paid model request was made by B. The local dependency `node_modules` symlink is untracked and is not part of any commit.

## Owned files and delivered behavior

Owned implementation: `src/invoice-mvp/{backend,demo,investigator,model,parser,server,service}.ts`, focused tests plus test-only backend, `scripts/invoice-mvp-{server,smoke,http-smoke}.ts`, the coordinated package script keys, and this handoff/`INVESTIGATOR.md`. B did not edit `contracts.ts`, Convex schema or backend implementation. Root owns `scripts/invoice-workspace-init.ts`, exposed by the coordinated `invoice-mvp:init` package key.

The reusable `InvoiceService` is the single UI/evaluation boundary. Production persistence goes exclusively through authenticated Convex handlers. Human credentials authorize ingestion/decisions; investigator credentials authorize tools/proposals. Default processing is deterministic, not a model. Supported text is independently validated by the backend; unknown formats stay evidence-missing, and JSON/CSV billing candidates require review. Generic customer CSVs register source-backed identities, aliases and zero-total customers before invoices. Original text/bytes are retained, including documented CRLF-to-LF extracted-text normalization.

One Investigator has an observe/tool/result loop bounded to ten actions, paged original inspection, paged related case summaries, customer/policy lookup, evidence-bound proposals and specific human questions. Routine records remain deterministic when a model is configured. Models cannot approve conclusions or write totals. All model proposals require human acceptance. No reviewer was added because no measured benefit exists.

The Anthropic transport is explicit-opt-in only. A's backend atomically reserves worst-case cost and request count before dispatch with immutable workspace caps. Replayed reservations cannot dispatch again. Crashed/failed requests remain conservatively charged. Per-request input/output ceilings are separately labeled. Retries, fallback and caching are disabled. Actual provider usage is a separate audit event. Test transports marked as live-boundary coverage are injected no-network doubles, **not live model evaluations**.

The loopback gateway on port 8790 has exact-origin/Host/peer checks, HttpOnly SameSite=Strict session cookies, a write header and no browser seat/admin tokens. Routes follow CONTRACT, plus `/runtime` attestation and `demo-batch?stage=late`. Import limits are 100 documents, 9,500,000 encoded bytes per batch, 6 MiB original bytes per source and 750,000 UTF-8 extracted-text bytes. No PDF extraction is claimed; benchmarks supply preserved originals with upstream text.

## Verification evidence

At implementation `6365baefa3d31c52f1f9d44b284f9f5a94e4f334`:

```sh
npm run invoice-mvp:test
npm run typecheck
```

Result: **30 focused tests passed; typecheck passed**. Coverage includes deterministic money/parser regressions, exact-quote rejection, unknown evidence, bounded mock actions, recorded human-response resumption, customer dependency ordering, 30-source/60-detail-read performance regression, no implicit live calls, reservation replay refusal, HTTP origin/session/Host rejection, import-byte validation, visible error fallback and backend seat separation. Tests using A's actual handlers additionally verify routine totals, duplicate tracing, late revisions, stale approval, human replay and atomic budget-before-transport ordering.

The combined worker/backend suite also passed **56 tests across five files**:

```sh
npx vitest run src/invoice-mvp tests/invoice-mvp-cases.test.ts
```

The small test backend and repository DB harness do not prove deployed Convex transaction concurrency, PDF extraction, real-model capability or browser usability.

### Real deployed Convex service smoke

Root initialized a separate empty `invoice-worker-b-check` workspace on its local deployed Convex at `http://127.0.0.1:3230`. This did not mutate root's browser demo or benchmark runs. Run the command against a newly initialized empty synthetic workspace:

```sh
CONVEX_URL=http://127.0.0.1:3230 \
INVOICE_MVP_RUN_ID=invoice-worker-b-check \
INVOICE_MVP_SEATS_FILE=/Users/junjiexiong/.codex/worktrees/invoice-mvp-integration/calhacks/var/invoice-mvp/invoice-worker-b-check/seats.json \
npx tsx scripts/invoice-mvp-smoke.ts
```

**PASS**, exact worker source `6365baefa3d31c52f1f9d44b284f9f5a94e4f334`. Initial Acorn/Birch net totals were 87,500/40,000 cents. Late revision invalidated the old disputed proposal; stale acceptance was rejected. Recreating the service resumed pending work. Accepting the current disputed proposal and replaying the identical decision produced final Acorn/Birch net totals **107,500/45,000 cents**, with four active source-traced contributions, one duplicate, one superseded source, one evidence-missing case and zero pending cases. No model calls.

### Real HTTP and large original-byte round trip

With the same server-side environment, run:

```sh
npx tsx scripts/invoice-mvp-http-smoke.ts
```

**PASS**, exact source `2a59bc5a87ede1cec8d9cc903f37f56a42bfa9e6`. The script starts/closes loopback port 8793, establishes the cookie via workspace, rejects missing-cookie writes with 401 and an untrusted Origin with 403, ingests through the HTTP batch route, and reads back **900,000 unchanged original bytes** via real Convex chunks. SHA-256: `beb546427e52447053bc83bbb7c3cf5e8681b461059ebff41f47971d4deef4da`. The fixture is explicitly synthetic opaque PDF-labeled bytes, not a renderable PDF or an extraction test; it remains evidence-missing. No model calls.

## Boundaries, remaining acceptance and contract deltas

- **Live-model application evaluation: NOT RUN. Official benchmark: not run by B.** API spend was never authorized and credentials are absent.
- Root owns the integrated browser demonstration and benchmark evidence. Passing these worker checks is not project acceptance.
- The demo exposes ordinary invoice/credit, duplicate, late explicit revision, a specific disputed-treatment decision and an unfamiliar recap requiring more evidence or exclusion.
- Local identity is simulated. Supported-format parsing is intentionally narrow and does not establish broad extraction quality.
- Backend/runtime/source restart persistence was checked by service recreation against deployed Convex; B did not restart root's shared Convex daemon.
- Related-source search uses summaries and selects full source only on inspect. Deterministic dependency preparation is linear in pending sources; case detail still returns originals as required for download.
- Accepted deltas through root: atomic `reserveModelRequest`/`modelBudget`; runtime attestation route; late demo stage; valid Currency/status and two-column CRM grammar fixes. No outstanding proposed shared-contract change.

See `INVESTIGATOR.md` for architecture, exact session handshake, service use, startup and opted-in live configuration. Worker scope is complete; root retains project-level acceptance and can request follow-up corrections.
