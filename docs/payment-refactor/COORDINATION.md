# Payment consolidation — issue #59

Coordinator: `01a16fbe-d1ce-71e0-b6b8-64629fbc7b2e` (local).
Human authorization was verified by reading the latest user turn of source chat
`01a16fac-c4c8-7741-9dde-f8a7d32c3f25`: “create issue for this restage and also create new session that can call other sessions to work on them in parallel.”
Worker chats may coordinate this refactor with this coordinator. No merge, deployment,
paid model use, live money, or unrelated messaging is authorized by this work.

## Baseline decision

- Main: `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`.
- Canonical: #47 persistent scoped bank (`3d762d4`), #49 human approval and evidence (`095bbbe`), #50 Increase and workers (`e556216`).
- Integration starts from #58 `f1a7a73e5865ce86191bd180e1c5a51f76d7ddb2`, containing that full stack and isolated recovery CI.
- #48 `d1fbfc2` is an alternative legacy executor. Do not merge its handler. Retain its failure cases: pre-send death, lost acceptance, local posting failure, changed destination, stale workers and closed periods. The selected stack already preserves immutable bank commands and separates acceptance from posted evidence.
- #51 `951b2df` is owned by the invoice MVP coordinator. Its receivables/evaluation changes and #57 task leases are not a dependency of this isolated payment slice. Preserve its future integration requirements: evidence-only cash, verified vendor destinations and task lease generations. Payment snapshots already bind the configured human-verified beneficiary.
- Shared main and its untracked `artifacts/` are untouched. Integration branch: `codex/payment-module-consolidation` in the managed `payment-refactor` worktree.

## Scope and contract gate

Consolidate the existing `demoPayments`/`demoEvidence` implementation rather than introduce another state machine. Keep public endpoints and persisted table/command identities compatible. Extract pure contracts/rules and application ports, and leave financial commits atomic in Convex.

Existing `BankCommand`, `BankScope`, `TransferObservation`, `BankTransaction` and request hashing are authoritative compatibility contracts. Do not weaken scope, saved request bytes, posted evidence, return links, human JWT identity, reservations, bounded budgets or fencing.

Required extensions: explicit executor version per configured run; frozen execution policy/beneficiary versions checked before first dispatch; reconciliation before reclaim resend; provider capability/retention gate for same-key resend. Historical ambiguous runs remain gated; no backfill or regenerated operation key.

## Ownership

| Lane | Exclusive files | Status |
|---|---|---|
| A contracts | `src/payments/contracts.ts`, `src/payments/domain/`, `src/payments/ports/`, contract docs and rule tests | contract preparation |
| B kernel | `convex/demoPayments.ts`, `convex/demoEvidence.ts`, `convex/demoSchema.ts`, `convex/lib/payments/`, generated API, backend integration tests | waits for A freeze |
| C application | `src/payments/application/`, `src/payments/adapters/`, dispatcher/evidence/agents compatibility modules, `scripts/ap-worker.ts`, relevant human/agent entry points | waits for A freeze |
| D independent verification | `tests/payments/`, `scripts/testing/payment-*`, recovery/migration documentation | fixture preparation; implementation waits for freeze |
| Coordinator | manifest, integration, package scripts if needed, final evidence, PR | active |

Existing chats notified: invoice MVP `01a16fb4-0204-7780-9d59-1a5d60c4791c`, runtime SRE `01a16fb4-e7c2-79c0-ab1f-9f097cf088e0`, lease fix `01a16fb4-f69d-7991-b067-a71b06afcb32`, AP CI `01a16fb5-050c-7eb0-91d8-1f5721870d1e`. Their checkouts and ownership remain separate.

## Verification policy

Independently run all three TypeScript checks, relevant existing/new tests, console build and isolated persistent Convex/FakeBank recovery on integrated code. Report local simulator, provider HTTP contract, and live sandbox separately. Live Increase, real JWT and external webhook delivery remain NOT_RUN without their prerequisites.

Stages and acceptance boxes on #59 are updated only with integrated verification evidence, never on assignment alone.
