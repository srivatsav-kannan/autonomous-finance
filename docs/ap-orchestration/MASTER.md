# Master orchestrator

This is an execution contract for a future user-started `/goal`. Reading it during preparation is not a request to launch implementation. Follow the active user's scope and current tool/permission rules.

## Objective and inputs

Deliver the complete evidence-backed AP roadmap in issue #97 through verified increments. Read README.md, LAUNCH.md, WORKSTREAMS.md, API-READINESS.md, LLAMAPARSE-GROUNDING.md, plan.json and issue-97.snapshot.md here. At launch, fetch the live issue, compare changes and record the adopted spec and source revision. Preserve its production-minded scope; a single successful invoice completes only the first integration milestone.

Bootstrap directory: `/Users/junjiexiong/Desktop/calhacks/docs/ap-orchestration/`. This launch pack is currently untracked and will not automatically appear in a worktree created from main. During P0, copy only the reviewed launch documents, plan, issue snapshot, checker and empty templates into the owned integration worktree; record hashes and the adopted spec. Do not copy the dirty checkout wholesale, `var/`, private provider files or signed-URL artifacts into Git. Name one canonical registry by absolute path and tell every worker where it is. After that handoff, the bootstrap copy is a reference, not a second mutable registry. Do not copy or reset another active goal's task states.

## Readiness gate

1. Inspect applicable AGENTS.md and git status. Do not stash, reset, overwrite or commit unrelated user work. The Desktop checkout is dirty and was at 5b9ef923ec91a1f329990d3cb058e8316850d4c9 when this pack was prepared.
2. Recheck remote main. It was 5e1126bd20765bad45c22007bb1f67ef25e2375e. The attached main-browser-recovery worktree was actually at 0e98be5aa869149d4147916e47c3a57746b07230. A worktree name is not proof of its revision. Do not modify an existing checkout until its ownership and suitability are clear.
3. Inspect attached worktrees and reuse a suitable one; otherwise create a dedicated integration worktree and isolated implementation worktrees with the managed worktree tools. Record absolute paths and refs. No automatic main merge, production deployment or real-money movement is included in this launch pack.
4. Inspect relevant prior work/PRs before duplicating it. Existing chats include Build credible autonomous-financeMVP and Explore memory layer workflows; their work is not automatically part of this goal. Only message sessions within the user's authorized scope.
5. Validate API readiness without exposing values. Track configured, authentication-verified and workflow-verified separately. A missing provider blocks its dependent verification, not all offline implementation.
6. Freeze the initial contracts: case/source/version/review/bill/payment/journal identity; candidate/evidence schema; independent state dimensions; authority and idempotency boundaries; fixture manifest and expected-result schema. Include content versus geometry status, native/derived/unresolved locations, region granularity, original source hash/revision, coordinate frame/units/origin/orientation/transform, token references, normalization, provider/OCR model/config versions and failure reason. Record a version and named owner. Resolve contract disagreement before parallel edits depend on it.

## Team and scheduling

Use one Master goal and four logical workstream owners from WORKSTREAMS.md. The default launch dispatches bounded subagents within this goal. A/B/C/D are responsibilities, not four permanently active managers or four duplicate roadmap goals. Separate user-owned chats are an optional mode only if the human explicitly requests them; creation and cross-chat messaging authorization must come from the human, not another agent. Do not invent unsupported thread controls.

At most three active delegated workers in the initial cohort. Assign concrete deliverables, dependencies, permitted paths, excluded shared files and acceptance evidence. Each owner can implement as well as coordinate. Further delegation uses available slots and a distinct scope; never recursively spawn management-only trees. Current tree limits override this plan. Reserve or rotate capacity for an independent verifier.

After P0 and C0, a useful initial cohort is A (data/parser), B (AP/policy) and D (UI against frozen contracts). Master inspects existing payment seams, then schedules C and the independent verifier as slots free; the exact order follows ready dependencies. A worker may split a bounded independent task only when capacity exists. It must not hold a manager slot while waiting for unavailable child capacity. Master assigns the independent verifier directly; D supplies browser evidence but is not the independent reviewer of its own UI.

Maintain one authoritative registry from plan.json. Only Master updates the canonical registry; workers return structured reports. Record child session ID, parent owner, worktree, branch, source SHA, state, blockers, next action, commit/PR and evidence. Registry state is not a substitute for inspecting actual work.

Include canonical registry path, adopted spec hash, evidence contract version, absolute working directory, backend/ports/run ID and exclusive file scope in each assignment. A pending task must not be dispatched before its dependencies are accepted. Reusing a finished worker requires a fresh scoped assignment; do not rely on a worker to notice registry changes automatically.

Use wait_threads for compact persistent-chat progress and collaboration tools for current-tree subagents. Prefer event-based waits; avoid repeated unchanged polling. Reassign or diagnose stuck tasks based on evidence, not arbitrary elapsed-time assumptions. A prepared or idle session is not complete.

## File and environment ownership

- Master owns shared contracts, top-level Convex schema/generated interfaces, dependency manifests/lockfiles and integration merges. Workers propose necessary changes through their owner; a scoped assignment may transfer ownership explicitly.
- A owns fixtures and parser/evidence adapters; B owns AP rules/bridge/accounting; C owns payment/integration adapters; D owns frontend. Shared files such as src/invoice-mvp/contracts.ts or console/src/App.tsx require a single assigned editor per wave.
- Separate worktrees do not isolate databases. Use separate local backends/dev deployments, run IDs, ports and temporary data. Only the integration owner may deploy shared schema/functions or restart the shared preview; do not reset the user's existing runtime state.
- Keep credentials outside commits, reports, prompts and screenshots. Do not blindly copy .env files between environments. Scope test identities/beneficiaries explicitly and use sandbox services only.
- The existing server-only provider file is `/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env`; reference/load it explicitly without copying its values. Invoice-specific live/provider switches still require intentional configuration in the chosen source. Package/pin the local OCR binary and English traineddata for the target runtime; the Mac diagnostic is not deployment readiness.

## Grounding fallback gate

Follow the verified limits in LLAMAPARSE-GROUNDING.md: native description geometry remained absent; raw OCR mismatched two tokens; Tesseract PSM 6 uniquely matched both lines on one scan. This is diagnostic evidence, not completed A2. Planned order: valid native grounding, unique exact raw-word alignment, bounded local OCR alignment, then explicit unresolved state with labeled coarse context. Never silently correct OCR characters/numbers to force a match, substitute field values or label derived text regions as native cell boundaries. B owns the evidence policy for progression; a box neither grants approval nor creates an obligation by itself.

A implements and packages the adapter; D exposes evidence state and version-correct highlights. The independent verifier checks ambiguous/missing text, rotation/frame errors, stale revisions and fallback failure/retry as well as the positive case. Unresolved results stay in the evaluation denominator. Source licensing and the distinction between agent review and AP practitioner review remain explicit.

## Integration waves

Follow plan.json dependencies. Integrate small vertical increments, beginning with a real uploaded synthetic PDF and the same case through review, bill recognition, independent payment authorization, FakeBank execution and reconciliation. Reuse the existing payment engine.

Verify the integrated FakeBank case (I1) and its negative/recovery cases (V2) before Increase workflow verification (C2). Provider authentication and resource readiness checks may happen earlier and do not satisfy C2. After V2, business payment scheduling (C3) and the selected external accounting connector (C4) are separate tasks: only C4 depends on ERP selection/access. Missing ERP access must not block C3. Final acceptance requires both tasks as well as the other FINAL dependencies in plan.json.

Before accepting a contribution, inspect its diff and run the change-appropriate checks. Record exact commands, source SHA, results and artifact paths. Resolve conflicts with component owners; do not erase unrelated work. A verifier who did not implement the relevant change should exercise integrated behavior and negative cases.

Every worker report must state: task ID; code/spec SHA; changed files; public interface changes; test/verification evidence; known gaps; blockers; commit/PR and proposed next action. Attach any created PR to its owning task using the available app tool.

## Decisions and labels

Keep runtime agent proposals, deterministic business controls and independent evaluation separate. Optional Decisions API classification must not become an authority to pay. Configure a model only when authorized; inherit the user's settings by default.

Use policy-derived synthetic outcomes to make engineering progress, clearly labeled. Do not mark practitioner review complete without an actual reviewer and record. Do not let runtime agents read the hidden answer key. Human approval in the workflow, internal test review and independent AP domain review are three distinct things.

## Completion

Maintain a capability matrix with implemented, verified-local, verified-external, blocked and planned states plus evidence. Include PO/non-PO, revisions/duplicates, exceptions/credits, coding/recognition, approvals, payment/recovery, reconciliation, scheduling, period close and the chosen external accounting integration.

Expected negative outcomes count as successful tests when they match policy. Balance alone is not accounting correctness; current scoped close is not full enterprise close. Properly recognized unpaid AP can carry forward.

Never declare the whole goal complete because all worker chats say done. Verify the integrated branch, supported case matrix and startup/recovery instructions. If a credential, human review or provider choice remains missing, report that precise gap and continue independent work; do not replace it with a stub or narrow the roadmap silently.
