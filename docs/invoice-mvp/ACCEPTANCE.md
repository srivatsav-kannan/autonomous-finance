# Integrated acceptance evidence

Application source: `926e4e8899a054c6cc1f2548f84a4ba18469797c`, clean when all runtime processes started. Later report/screenshot commits do not change application code. Verification date: 2026-10-24. Runtime: Node 24.22.0, real local Convex on :3230, loopback invoice gateway on :8790, browser console on :5173. No model API calls or payment actions occurred.

The deterministic/manual workflow passes the functional checks below. **The MVP is not fully validated: live-model evaluation and a current live baseline comparison are NOT RUN.** The original benchmark scores 0/18 with models disabled, and the held-out suite passes 4/9. Infrastructure correctness does not establish unfamiliar-document interpretation.

| Requirement | Measured result | Evidence |
|---|---|---|
| UI imports batch and persists customer totals | Pass | Fresh `invoice-acceptance-v1`; browser imports 8 public synthetic sources. Acorn $875, Birch $400 after deterministic processing. |
| Every included amount traces to a source | Pass for demo | UI expands all four final contributions: AC-100 $1,000, AC-C10 −$125, AC-101 $200, BI-20 v2 $450. Each has an immutable proposal, source version and SHA-256. Structural audit found zero unsupported effects or arithmetic mismatches. |
| Duplicate and superseded documents | Pass | Exact scan copy marked Duplicate; late Birch correction replaces $400 with $450, earlier version Superseded. Four active contributions remain. |
| Unfamiliar/conflicting source triggers investigation | Pass for deterministic/manual path; live NOT RUN | Disputed AC-101 produces explicit contradictions and review; unfamiliar recap runs source/related-record/policy tools and stays Evidence missing. Mocked-model tests exercise adaptive tool choice, not live capability. |
| Insufficient evidence asks a useful question | Pass for public demo | Requests issued invoice/credit, customer ID, document number, USD currency and a single final total. Frozen held-out questions are more generic; 4/9 is not proof of recognizing those conflicts. |
| Human answer resumes correct case | Pass | Browser accepts the exact $200 AC-101 proposal with rationale; Acorn becomes $1,075. A second decision requests evidence for the recap without booking it. |
| Replayed answer has no duplicate effect | Pass | Browser replays acceptance; one acceptance receipt and one AC-101 contribution. Separate deployed-backend smoke verifies stable decision ID and four final contributions. |
| New evidence/proposal rejects old approval | Pass | Real Convex smoke captures a proposal, imports late evidence, receives `stale_proposal` on the old approval, then accepts the current version. Focused tests cover conflicting answers and same-key payload changes. |
| Restart preserves completed/unresolved work | Pass, actual processes | Stop gateway processes and Convex CLI/backend; verify port :3230 unbound; restart same storage/runtime files. Persisted cases, proposal pointers, customer totals and two decisions compare exactly. UI displays real HTTP 502 during outage and reconnects with $1,525 total and one missing-evidence case. |
| Actual application runs through original benchmark | Pass for harness execution, accuracy 0/18 | All 148 original files enter the same HTTP gateway, retain original bytes/text, and export persisted totals to the unmodified scorer. All 148 remain unresolved in deterministic mode. First failed transport attempt is retained separately and unscored. |
| Reports distinguish measured/missing validation | Pass | Unit/mock tests, deployed deterministic checks, original scorer, held-out checks and absent live comparison are separately labeled in the evaluation report. |

## Exact-commit checks

- `npm test`: 269 tests in 25 files pass.
- `npm run typecheck`: pass.
- `npx tsc --noEmit -p convex/tsconfig.json`: pass.
- `npx vite build --config console/vite.config.ts`: pass, 98 modules.
- Python evaluation harness: 27 tests pass against pinned upstream; no provider calls.
- `tsx --test evals/invoice-mvp/capped-llm.node-test.ts`: 5 injected-transport tests pass.
- `tsc --noEmit -p evals/invoice-mvp/tsconfig.json`: pass.
- `scripts/invoice-mvp-smoke.ts` against fresh `invoice-acceptance-smoke`: pass, real Convex, stale approval/replay/version recovery/evidence checks.
- `scripts/invoice-mvp-http-smoke.ts` against fresh `invoice-acceptance-http`: pass. Original 900,000-byte opaque synthetic PDF roundtrips exactly; missing session returns 401 and forbidden Origin returns 403. This is storage evidence, not PDF extraction accuracy.

A test-discovery collision between Node's test runner and Vitest was found during integration and fixed before the final clean run; both suites now execute separately. Model transport compatibility and failure accounting were verified with a mocked SDK only. Database throttling has bounded retries; model requests have no automatic retries or fallbacks.

## Restart and browser records

[Machine-readable verification](verification-926e4e8.json) includes smoke outputs, structural audit, commands and restart process IDs. Stable state SHA-256 before and after restart: `b1871486728b2ea71a22cbe9760a905f420fbab5214a862ed75d8258a35f743f`.

The browser run contains 9 source versions: 4 recorded, 2 supporting records excluded, 1 duplicate, 1 superseded and 1 evidence-missing case. Acorn gross $1,200 minus $125 credit gives $1,075; Birch is $450. Two operator decisions persist. Original/held-out evaluation restart checks are separately recorded by the independent evaluator.

![Workspace after actual restart](screenshots/final-workspace-after-restart.png)

Additional screenshots: [recorded case/replay](screenshots/final-recorded-case.png), [missing evidence](screenshots/final-missing-evidence.png), [real service outage](screenshots/final-backend-stopped.png). Worker C's earlier screenshots are supplementary and identify their earlier source commit in its handoff.

## Validation boundaries

Local identities are simulated operator/agent seats with backend-enforced permissions. Production SSO, public deployment, mobile viewport/file-picker/download roundtrip, live banking and real financial transactions were not tested. The browser imports text/CSV/JSON; PDFs require original bytes plus externally extracted text. Original benchmark extraction uses pinned pypdf, not native browser OCR.

No second model reviewer exists. No controlled live comparison shows that multiple product agents add value. Four Codex development chats are unrelated to the product's optional single Investigator role. Historical 18/18 Claude-only results do not measure this MVP. The capped $7.50 comparison is prepared and disabled pending explicit approval and an API credential; credentials alone never authorize spending.
