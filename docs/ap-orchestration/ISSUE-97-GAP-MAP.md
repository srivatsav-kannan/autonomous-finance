# Issue #97 scope and evidence gap map

Reviewed 2026-10-25 against review implementation 28837a9 and the current [issue](https://github.com/srivatsav-kannan/autonomous-finance/issues/97), including its [agent capability matrix](https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6396801545) and [agent abstraction](https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6397213862). The issue is CLOSED; this review does not infer complete acceptance from that state. [Read receipt](evidence/issue-97-status-receipt.json) preserves source hashes and timestamps without changing the frozen launch specification.

## Subsequent bounded implementation

The user's next request authorized new AP case automation while retaining separate human payment approval and skipping CI. [The implementation](AP-CASE-AGENT.md) now adds a scoped persistent queue, typed inspect/advance tools, deterministic next-step policy, missing-evidence waits, automatic resume, shared guarded payment preparation and settlement observation. Fifteen new tests and107 relevant local regression tests pass, including actual CLI SIGKILL/HTTP recovery with retained Convex-test state. Human field/bill decisions are still required by current policy. No external runtime rollout or provider result is inferred from these tests.

The gap statements below preserve the prior full-matrix comparison. The narrow C25 wait/advance path and guarded preparation now have this additional local evidence; a complete C01–C30 tool registry, messaging/replies, delegated autonomous business decisions, full T/U crosswalk and broader external acceptance remain open. Legacy handlers are unchanged; the new worker uses scoped APIs because legacy task APIs reject these runs.

## Original roadmap

| Area | Retained implementation/evidence | Remaining proof |
| --- | --- | --- |
| A: originals, ingestion, evidence | A1/A2/A3, provider originals, explicit native/derived/unresolved provenance, bounded OCR packaging | Representative real supplier corpus; production robustness is unclaimed |
| B: validation and exceptions | B1/V1/V2, I1 and I3 same-case missing-receipt arrival and recovery | Independent business interpretation; broader real evidence cases |
| C: coding, approval, accounting | B3/B4/B5 and V4–V14 bounded local controls, actual I2 journals | Claude derivation/comparison; live formal close and additional treatments |
| D: payment and reconciliation | I1/I3 FakeBank same-case recovery; C4 real Auth0/Increase/QBO happy path and funding reconciliation | External failure/return/credit/partial-payment cases, signed webhook; no QBO funding journal export |
| E: operator experience | Desktop source/review/approval/history/recovery UI and actual browser evidence | Final handoff; no additional mobile work requested |
| F: expanded capabilities/integrations | Local scheduling, partial/credit/return, dimensions, tax and close controls; one QBO round trip | Per-capability external acceptance; USD only, FX explicitly moved to #104 |

## Agent matrix: underlying operations versus autonomous use

The repository already has agent handlers, a runtime, control plane and task leases. The new AP service uses guarded `apCases`, `apCasePayments`, `apBusiness` and `apClose` operations. Some calls use scoped agent credentials, others require the request's human identity. However, `src/agents/handlers/ap.ts` still uses `api.ap` and `src/agents/handlers/payments.ts` uses the legacy bill/payment APIs. Current source/evidence does not establish a complete agent tool registry or durable automatic advancement for the newly uploaded AP cases. This is an integration and acceptance gap, not a claim that there are no agents or backend controls.

| Matrix area | Current basis | Gap before claiming the matrix delivered |
| --- | --- | --- |
| C01–C10: evidence, checks, bill and accounting | New service/backend and desktop workflow; versioned decisions, journals and local tests | Map each allowed agent operation to typed schema, real principal/role, truthful status and its T/U tests; verify connected agent use |
| C11–C13: evidence requests, replies, supplier changes | Trusted-contact/supplier-change controls and local evidence handling | Demonstrate durable request/send/reply/reminder ownership with the selected messaging connector; drafts or fixture arrivals are not sent messages |
| C14–C24: payments, observations, repair, returns | Guarded payment engine; same-case FakeBank recovery; one external settled payment; local negative/return tests | Complete matrix-to-implementation mapping and wider external negatives; human release remains outside model-callable tools |
| C25–C26: advancement, waits, escalation, activation/revocation | Generic runtime/control-plane/lease foundation; I3 worker recovery | Connect new AP case persistent owners, event cursors, waits, budgets and escalations; test event-before-wait, redelivery, no-progress and scoped revocation |
| C27–C30: schedule, ERP, period treatment, allocations | Local bounded implementations and exact-accounting tests; actual I2 and C4 records | Validate each activated scenario independently; formal live close and wider ERP lifecycle coverage remain open |
| T01–T30 / U01–U10 / G0–G4 | Numerous retained independent engineering tests and exact-effect reports | No complete current matrix crosswalk or all-gates replay is claimed. Existing successful tests are not automatically evidence for every newer matrix requirement |

The latest capability matrix calls for shared UI/agent operations, backend authority and separate human payment release. Do not satisfy it by exposing human credentials to models, routing agents through UI clicks, or declaring case completion from agent narration.

## Delivery priority

For the currently requested USD sandbox demonstration, review/merge PR #106 and return the external Claude review/findings. For the complete autonomous AP system described by #97, the agent integration and per-capability verification above are substantive remaining work. Do not assign a completion percentage by counting files, tests or closed issues. CI, FX, extra mobile work and hosting remain deferred under the user's explicit scope decisions; other gaps are recorded here, not silently deferred or marked accepted.
