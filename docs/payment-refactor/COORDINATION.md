# Payment consolidation — issue #59

Coordinator: `01a16fbe-d1ce-71e0-b6b8-64629fbc7b2e` (local).
Human authorization was verified by reading the latest user turn of source chat
`01a16fac-c4c8-7741-9dde-f8a7d32c3f25`: “create issue for this restage and also create new session that can call other sessions to work on them in parallel.”
Worker chats may coordinate this refactor with this coordinator. No merge, deployment,
paid model use, live money, or unrelated messaging is authorized by this work.

## Baseline decision

- Main: `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`.
- Canonical: #47 persistent scoped bank (`3d762d4`), #49 human approval and evidence (`095bbbe`), #50 Increase and workers (`e556216`).
- Integration starts from #58 `f1a7a73e5865ce86191bd180e1c5a51f76d7ddb2`, then merges final stable #58 `05d3e5fe5a0ce9966096ab2afaff6133bfc8839d` (PR50 `9d4be0f`, including close approval snapshot fixes). This contains the full payment stack and isolated recovery CI.
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
| A contracts | `src/payments/contracts.ts`, `src/payments/domain/`, `src/payments/ports/`, contract docs and rule tests | integrated; 35 pure tests and three typechecks passed on lane revision |
| B kernel | `convex/demoPayments.ts`, `convex/demoEvidence.ts`, `convex/demoSchema.ts`, `convex/lib/demoAuth.ts`, `convex/lib/demoEffects.ts`, `convex/lib/payments/`, generated API, backend integration tests | active after A freeze |
| C application | `src/payments/application/`, `src/payments/adapters/`, dispatcher/evidence/agents compatibility modules, banking adapters, `scripts/ap-worker.ts`, existing dispatcher child/test, relevant human/agent entry points | active after A freeze |
| D independent verification | `tests/payments/` except rules, `scripts/testing/payment-*`, recovery/migration documentation | active after A freeze |
| Coordinator | manifest, integration, package scripts if needed, final evidence, PR | active |

Existing chats notified: invoice MVP `01a16fb4-0204-7780-9d59-1a5d60c4791c`, runtime SRE `01a16fb4-e7c2-79c0-ab1f-9f097cf088e0`, lease fix `01a16fb4-f69d-7991-b067-a71b06afcb32`, AP CI `01a16fb5-050c-7eb0-91d8-1f5721870d1e`. Their checkouts and ownership remain separate.

| Lane | Chat | Branch | Handoff |
|---|---|---|---|
| A | `01a16fc0-6763-7df2-bc9b-1801c668e1aa` | `codex/payment-contracts-59` | `4d8827c` contracts → `6e22066`; `f57031b` rules → `ae39320` |
| B | `01a16fc4-b0a7-7173-8639-b752cf2871d5` | `codex/payment-kernel-extraction` | pending |
| C | `01a16fc6-03d4-72a0-90c3-cb8baf500c0a` | isolated `41f4` worktree | pending |
| D | `01a16fc0-6765-70f0-ba17-069db9a8de00` | `codex/payment-independent-verification` | fixture preparation `7b85cfe`, `66c4803`; final tests pending |

A finished before C started, keeping at most three implementation workers active.
B also owns existing `tests/demo-fixture.ts`, `demo-backend.test.ts`, `demo-reconciliation.test.ts`, and `demo-final-review.test.ts` for explicit executor arguments and earlier reservation behavior. C owns `tests/demo-dispatcher.test.ts`. Coordinator owns CI evidence assertions and fixture updates.

SRE #60 `1008377` changes only generic Team/task transport/drain; it is not required for the dedicated payment workers. #57 `dccec3f` fixes a #51 task deferral regression; payment leases use their own monotonic generation. Both remain independent dependencies for eventual broader integration.

## Verification policy

Independently run all three TypeScript checks, relevant existing/new tests, console build and isolated persistent Convex/FakeBank recovery on integrated code. Report local simulator, provider HTTP contract, and live sandbox separately. Live Increase, real JWT and external webhook delivery remain NOT_RUN without their prerequisites.

Stages and acceptance boxes on #59 are updated only with integrated verification evidence, never on assignment alone.

## Additional CI gates requested by the human

The follow-up human turn in the source chat explicitly requested parallel CI testing and deferred Datadog. No Datadog action, credentials, dependencies or tests are part of this milestone.

| Testing lane | Chat / branch | Exclusive ownership | Status |
|---|---|---|---|
| Unit/contract and migration | D `01a16fc0-6765-70f0-ba17-069db9a8de00` / `codex/payment-independent-verification` | Existing `tests/payments/` and independent coverage inventory | 43 independent cases integrated; auditing added CI requirements |
| Recovery and CI | Existing AP CI owner `01a16fb5-050c-7eb0-91d8-1f5721870d1e` / `codex/payment-ci-gates` | Persistent runner, CI evidence helper/tests, real dispatcher child, narrow local demo interruption, `docs/ci.md` | active from `794a10e`; #58 branch preserved |
| Playwright smoke | `01a16fce-3324-7561-b05b-d30c14cd6259` | `tests/browser/`, payment Playwright config, `scripts/testing/payment-browser-*`, `docs/payment-refactor/BROWSER.md` | local fixture/suite active; staging prerequisites absent |
| Shared CI wiring | Coordinator | `.github/workflows/`, `package.json`, `package-lock.json`, combined evidence | single writer; worker proposals integrated here |

The core integrated revision `794a10e` passed 387 tests, all three TypeScript checks, the console build and persistent local recovery. Convex rejected hyphenated helper filenames during actual deployment; the coordinator changed them to camelCase before this passing run. Its sanitized evidence is recorded separately from the additional CI/browser work.
