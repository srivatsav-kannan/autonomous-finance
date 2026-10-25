# B1/B2 accounting worker handoff

Status: implementation and worker checks complete; independent acceptance remains Master-owned. This report does not mark either task accepted.

- Task IDs: B1, B2. Owner: `/root/accounting`; parent: `/root`.
- Canonical registry (read-only to this worker): `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json`.
- Adopted issue SHA256: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.
- Worktree: `/Users/junjiexiong/.codex/worktrees/ap-system-accounting/calhacks`; branch: `codex/ap-system-accounting`.
- Source baseline: `ac62854`, plus worker table commit `b28764b` and Master's schema wiring cherry-pick `f134f7f` (origin `2bd870d`). Implementation commit is the commit containing this report; Master receives its full SHA separately.
- Contract: `ap-evidence-v1`; synthetic company policy: `golden-state-ap-v1`.
- Run namespace: `ap97-20261025-01a1722e-b`. Worker started no backend, wrote no shared backend, and made no provider or real-money calls. Ports 3270/3271 were not used.

## API and storage

All public input payloads pass the shared Zod schema after scoped authentication. Wire validators use `v.any()` for frozen shared payloads; implementation output is typed, and detail/list return `APCaseDetail`.

| Convex operation | Authority and result |
| --- | --- |
| `apCases.ingest({scope,seatId,token,input})` | Scoped AP clerk. Stores verified original metadata/chunks, immutable case revision and delivery associations; returns caseId, revision, duplicate/replayed flags. Nullable failed candidates remain cases. No bill is created. |
| `apCases.list({scope,seatId?,token?})` / `detail({...readAuth,caseId})` | Scoped AP/controller/payments/auditor/CFO-agent reader or authenticated configured human. Re-reads authoritative scoped bill, payment versions/commands/transactions and journals. Private original/artifact paths and original bytes are removed from the projection. |
| `apCases.source({...readAuth,sourceId,revision,sha256})` | Exact binding only. Reassembles retained chunks and verifies bytes/hash; returns original name, MIME, length, hash and base64 for the HTTP source route. |
| `apCases.reviewFields({scope,input:ReviewRequest})` | Configured authenticated human, never case creator. Requires current revision/snapshot/all source bindings, supported complete content and explicit coverage of every candidate evidence item. Creates a separate retained field-review decision; no bill/payment. |
| `apCases.approveBill({scope,input:BillApprovalRequest})` | Configured authenticated human, never case creator. Requires current field review, full original amount, no business holds and complete reviewed evidence. Atomically creates one existing-engine demoBill plus recognition journal and bill-approval decision. No payment authorization or settlement. |

Tables are exported by delegated `apSystemTables`. New post-wiring table `apCaseSourceChunks` must be deployed with the integrated schema. `apCaseRecords`/`apCaseRevisions` contain sanitized metadata only. Source metadata is immutable per source version, including extracted text, page state and processor provenance. Renaming a delivery does not change its original binding. Reparse changes require an explicit revision; previous decisions and original versions remain retained.

Economic replay returns the original bill/journal/decision; changed idempotency payloads fail. An explicit revision clears review and holds the case. If already recognized, the linked bill version advances and gains an evidence hold. Provably unattempted requests cancel/release through the existing engine. Any attempted/generation/provider-transfer evidence preserves the original operation/key/reservations. Receipt reuse checks the immutable recognized revision even when the case has subsequently changed.

Legacy `acceptBill`, `humanAcceptBill` and `resolveBillExceptions` cannot accept or clear an AP-linked bill outside this case workflow. Master's C1 gate must additionally enforce AP state on direct payment requests and dispatch. B1's separate legacy handler corrections hold missing delivery references and unknown SKU, and require explicit human resolution instead of automatic price/quantity short-pay or fabricated vendor notification.

## Capacity boundary

The backend enforces at most **8 MiB total original binary bytes**, **10 documents**, and **750000 bytes serialized metadata per packet**. Original base64 is stored once in chunks of 200000 characters, keeping each row well below the document limit. A 1.2 MB synthetic original was round-tripped through convex-test and confirmed absent from case/revision/source metadata rows.

Convex documents a 16 MiB function-argument/return and transaction read/write limit, and a 1 MiB document limit. 8 MiB binary expands to approximately 10.67 MiB base64; the explicit metadata budget leaves theoretical argument/write headroom. This is an inference from published limits, **not measured deployment capacity**. The 5 MiB Node-action exception does not apply to these normal Convex mutations. [Convex limits](https://docs.convex.dev/production/state/limits), checked 2026-10-25.

Actual local-backend request-size, execution-time and maximum-packet verification is pending Master integration. The worker does not claim 25 MiB support. Over-limit packets reject with an explicit error; retaining the upload error is the HTTP/UI layer's responsibility. Tests use text bytes with PDF MIME solely as a backend contract stand-in, not valid PDF parser proof.

## Checks and evidence

Final commands on the implementation in this report:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run typecheck:backend` | PASS |
| `npm run typecheck:tests` | PASS |
| `npm test` | PASS: 82 files passed / 1 skipped; 932 tests passed / 4 skipped; 8.87s |
| `git diff --check` | PASS |

New focused coverage is 6 deterministic policy/accounting tests and 15 Convex backend tests. Backend tests cover decision separation, exact debit/credit recognition with no payment command, replay/new-key duplicate approval, renamed duplicate deliveries, unrelated same filenames, exact original bytes/hash/scope, nullable failures, missing receipt, unilateral short-pay denial, stale source reviews, closed-period atomic rollback, legacy bypass rejection, cross-obligation receipt reuse after revision, unsent cancellation, attempted-operation reservation retention, multi-chunk originals, immutable parser metadata, altered idempotency payloads, incomplete field-review coverage and self/cross-source approval denial. Legacy tests add missing-delivery/unknown-SKU holds and four explicit-human variance cases.

Ignored local logs (hashes make the exact recorded results reviewable):

- `var/ap97-20261025-01a1722e-b/typecheck.log`: `ea44b21851263313366a2a2412f27f2801f680f6e3181841c3ae3d3569052cf1`
- `var/ap97-20261025-01a1722e-b/typecheck-backend.log`: `5c61d18d2a0d7e2a39854e5feb3b3d1421c1ff6a4e1372ec6f9044caf8038cb2`
- `var/ap97-20261025-01a1722e-b/typecheck-tests.log`: `fe6540879c8117febbc081f4ddf6f398a61b10ec5f85c8c08d124b9ec4e33dc1`
- `var/ap97-20261025-01a1722e-b/tests.log`: `6273b222b9f4ea50b8073ddb31e406987d1f237dc8d9ceabd43ca5f345deeebf`

Implementation file SHA256 manifest:

- `convex/apCases.ts`: `148f861ebbc15e5bff54947a8e0df0240cd5aa5beebae0219543258477ca80b0`
- `convex/apSystemSchema.ts`: `e7f183904b221204a53188f77a99aace280af6c3164d16fc19cad15cf26d8e0f`
- `convex/lib/apSystem/shared.ts`: `6df5d32c4ea2d48c2c74b492674b6ddd587177442067aa7398e1a5149369ea53`
- `convex/lib/apSystem/projection.ts`: `a8732c61df9fe093294eb88e664a070f6631ae9086690378850f20e18ea72b3f`
- `convex/lib/apSystem/legacyGate.ts`: `339be967b22c7a25bd932843e6882f0ade6b98bd8bb227fc686b8822d03507c2`
- `src/ap-system/policy.ts`: `2ccc0a61c3cc1fc39a4aac5fdce44428dbf84d39f62a8f1f239beaacf2c1e738`
- `src/ap-system/accounting.ts`: `d207bcfdffb4973296abf2ff3229982310788749594ae2848754f2a07077a060`

## Remaining acceptance and next action

Master should cherry-pick the implementation commit onto the existing integrated table/schema commits, regenerate the shared API, deploy only the Master local integration backend, and run the actual A packet through review → recognition → C1 payment handoff. Independent V1/V2, real browser/source geometry, parser provider behavior, maximum upload capacity and practitioner sign-off are not established by these worker tests. B3 allocation/credits/corrections, C3 due-date scheduling and C4 external accounting sync remain later roadmap work. No worker acceptance status or canonical registry was changed.
