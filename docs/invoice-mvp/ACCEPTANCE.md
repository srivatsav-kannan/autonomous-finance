# Integrated acceptance evidence

This is the orchestrator's acceptance checklist. Pending entries are not claimed as passing. Final verification must name one integrated source commit; report commits may follow without changing application code.

| Requirement | Status | Evidence |
|---|---|---|
| UI imports batch and persists customer totals | Pending | Browser + real Convex |
| Every included amount traces to original source | Pending | Detail + contribution references |
| Duplicate and superseded document handled | Pending | Browser and backend tests |
| Unfamiliar/conflicting source triggers investigation | Pending | Runtime trace |
| Insufficient evidence asks a useful human question | Pending | Browser case detail |
| Human decision resumes correct case | Pending | Browser + stored decision |
| Decision replay has no duplicate effect | Pending | Real-backend replay |
| New proposal rejects old approval | Pending | Real-backend stale decision |
| Restart preserves completed and unresolved cases | Pending | Restart backend + gateway, compare snapshots |
| Actual application runs through original benchmark harness | Pending | New service-boundary adapter |
| Reports distinguish measured and missing validation | Pending | Evaluation report |

## Reused-base checks (not MVP acceptance)

Source base: `951b2df51fccbb3c380eb84abff08b4b1aee068a` (#51), with documentation-only bootstrap at `705e9d4`. Node v24.22.0, npm dependencies installed from committed lockfile. No model API calls.

- `npm test`: 18 test files, 179 tests pass.
- `npm run typecheck`: pass.
- `npx tsc --noEmit -p convex/tsconfig.json`: pass.
- `npx vite build --config console/vite.config.ts`: pass.
- `AGENT_LLM=off npm run smoke`: 25 kernel + 17 Git-memory checks pass against separate local Convex at :3230. Run IDs `smoke-1792875700609` / `smoke-1792875700985`. Interface-only commit `cf6dedf` was present; no MVP implementation yet.

The legacy smoke suite includes simulated payment lifecycle checks; no external bank calls occurred. New MVP workflow has no payment execution endpoint.

## Validation boundaries

Local identities are simulated human/agent seats with backend-enforced permissions, not production identity-provider login. Live-model API calls are NOT RUN unless later evidence explicitly replaces that status. Original benchmark fixture exposure in #51 is known; only the independent custom scenario suite can be described as held out before its first score. No claim of production readiness or payment execution follows from invoice totals.
