# Orchestration record

Owner: root chat `01a16fb4-0204-7780-9d59-1a5d60c4791c`, local host.

Repository verified: `/Users/junjiexiong/Desktop/calhacks` remote is `srivatsav-kannan/autonomous-finance`; main at `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`. Untracked `artifacts/` preserved. No applicable AGENTS.md found. Node v24.22.0. Configured Codex model settings retained (no overrides). No API credentials or explicit spend budget discovered in this environment. Track brief read via Google Drive; emphasizes narrow seats, conflicting sources, durable recovery, permissions and evidence.

PR status refreshed 2026-10-24: #51 OPEN head `951b2df51fccbb3c380eb84abff08b4b1aee068a`; #47 OPEN `3d762d496faa2b3cdd841c26133439c00dd397a7`; #48 OPEN `d1fbfc2d693514d99b153d49691c53f6d2d63c7f`; #49 OPEN `70d6723b5431b3e004eb9b82326f581ae614d75d`; #50 OPEN `f6cd52431b959630b3d483ef167a9f464ed15438`. #47 -> #49 -> #50 is bank/AP stack. #48 overlaps its legacy payments work. Banking stays out of critical path; do not combine competing implementations.

Integration worktree: `/Users/junjiexiong/.codex/worktrees/invoice-mvp-integration/calhacks`, branch `codex/invoice-mvp-integration`. Upstream reuse base: #51 exact head above. Common worker base: contract bootstrap commit (record next). Contract owner A; changes require root approval. At most 3 active worker chats, 4 total. Launch A/B/D; C follows when a slot opens. Workers must use native create_goal and provide evidence of activation.

Integration status: backend, bounded investigator, HTTP service, browser workspace and independent evaluation harness integrated. Required final evidence is all eleven acceptance checks on one integrated source commit. Live-model validation is a distinct external dependency, not inferred from free tests. Root owns final review, integration, startup, browser acceptance, README/architecture and draft PR.

## Workers

All four authorized chats were created with isolated worktrees, configured model settings unchanged, and native goal activation verified. A/B/D started first; C started after an evaluation dependency opened a slot. A brief goal auto-continuation overlap was corrected by asking C to wait. No worker recursively created chats. Handoffs distinguish their own source commits from later integration evidence.

Common worker base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c`.

| Worker | Chat ID / host | Worktree | Branch | Goal and evidence |
|---|---|---|---|---|
| A | `01a16fb6-6aa9-7e63-9225-96a9181b021a` / local | `/Users/junjiexiong/.codex/worktrees/0a5f/calhacks` | `codex/invoice-mvp-cases` | Original backend goal complete; new native follow-up goal active for full-fixture import failure. Owns schema, contract and lifecycle. Integrated `a8d81dc`, `681aa08`, `98bc408`; [handoff](handoff-A.md). |
| B | `01a16fb6-c8b1-7ca1-ad77-b38830f3d893` / local | `/Users/junjiexiong/.codex/worktrees/a729/calhacks` | `codex/invoice-mvp-investigator` | Complete. Owns runtime, parser, model adapter, HTTP boundary and smoke commands. Integrated `3d00f74`, `6365bae`, `2a59bc5`, `334e29e`; [handoff](handoff-B.md). |
| C | `01a16fbf-6432-7d61-94f4-8859f3fa2a97` / local | `/Users/junjiexiong/.codex/worktrees/c2b3/calhacks` | `codex/invoice-mvp-operator` | Native goal complete. Owns invoice React workspace, detail, API client, styles, Vite route. Integrated `ac310f6`, `75fe3ab`; [handoff](handoff-c.md). |
| D | `01a16fb6-c8b1-7ca1-ad77-b379c61a733c` / local | `/Users/junjiexiong/.codex/worktrees/d500/calhacks` | `codex/invoice-mvp-evaluation` | Evaluation and capped live preparation ongoing. Owns protocol, private fixtures, harness and reports; no product tuning. Initial native goal reached blocked after three runtime-dependent turns; explicitly resumed work when runtime arrived. [Handoff](handoff-D.md). |

Approved A additive schema proposal: invoiceBatches, invoiceSources, invoiceCaseRecords, invoiceProposals, invoiceDecisions, invoiceAudit, invoiceContributions; reuse existing customers and seat auth. Contributions are a focused net-invoiced subledger, no general-ledger/cash claim. API names invoiceCases.workspace/caseDetail/pendingCases, ingestBatch/beginInvestigation/submitProposal/decide/recordToolCall/registerCustomer.

Root approved additive original-byte chunks and persistent model-budget/reservation tables through A. Root corrected the narrow routine grammar for an ordinary `Currency: USD` line and two-column customer CSV; duplicate/conflicting currency remains reviewable. No reviewer role was added because no measured evidence justified it.

## Verified checkpoints and pending evidence

- Integrated application `f1f03512528772a21da2445f0f698eb3511c88ce`: 235 tests pass; app/Convex TypeScript and Vite production build pass. Worker B verified real Convex replay, stale proposals, source versions and a 900,000-byte HTTP original roundtrip; worker C verified browser import, human acceptance, replay, refresh, late correction and visible HTTP 409 error. Root repeats final acceptance after any application correction.
- First held-out run at `c7774f6`: 4/9 frozen checks pass, 11 source versions retained exactly, zero model calls. These are mostly safe abstention checks, not evidence of successful unfamiliar-format interpretation. A post-fix run at `f1f0351` remains 4/9. First-pass seals were preserved.
- First full original-fixture attempt at `f1f0351`: failed unscored after 72 successful import chunks / 105 sources. A is diagnosing using an isolated run; failed workspace and artifacts are preserved. No accuracy is assigned to a failed transport run.
- Backend/gateway process restart, corrected full original run, final source commit, draft PR and capped live preparation remain in progress. API spend has not been authorized; no credentials were exposed or model calls made. Live-model results are NOT RUN.
