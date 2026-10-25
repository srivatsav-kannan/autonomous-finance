# AP agent live sandbox rollout — partially recovered, full flow not passed

The new synthetic $77.00 USD case (`INV-AGENT-20261025-01`, `kd70djc8wdam76s7dxz0jxdgv98gzmq4`) has **not completed the full flow**.

The original local Convex SQLite database is malformed. The parent recovered a copy which passes SQLite structural integrity and starts a separate backend on port 3262. The isolated recovery backend was stopped after readbacks. The original database remains preserved and has not been replaced. This is partial recovery: `apCaseAgent:inspect` still fails with **`Dangling index reference`** while reading the new case's agent work queue. Passing SQLite integrity does not prove Convex documents and indexes are fully consistent.

## Independently recovered business evidence

The saved scoped-query responses from the recovery backend were independently read and sanitized into `recovered-business-checkpoint.json`. The checkpoint records original response hashes and the exact dangling-index error, without credentials or personal actor identities.

- **Existing INV-1001:** execution `settled`, reconciliation `matched`, outstanding **$0.00**, one payment and two case-associated journals. These are recovered local records; no new Increase or QBO readback is claimed.
- **New INV-AGENT-20261025-01:** revision 2, document `reviewed`, business `held`, authorization `not_requested`, execution `not_started`, accounting `unposted`; **zero payments and zero journals**.
- Its recovered timeline independently confirms revision 1 → `agent_missing_evidence` for missing receipt → revision 2 with receipt → `agent_field_review` → recorded `field_review` → `agent_bill_approval`. It has a field-review decision but no bill approval or payment authorization.

Prior browser bill-approval execution was rejected by automatic approval review and required the user. No workaround was taken. No settlement mutation was performed during recovery. The original temporary checkpoints and fixtures remain absent; their disappearance and database corruption causes are unknown.

## Source verification

The live checkout is based on `71853508db2bb95d6d87929ab46c79db1d7b2a0f`, with the minimal agent source delta from `6438103e28c0374110e3d6fb971319555a568690`. Eleven of thirteen inspected files match the reference exactly. The schema preserves the live base and adds the two agent-work tables; Convex API declarations are regenerated. `verification-summary.json` records source SHA-256 hashes, original database hash/size, and the recovered checkpoint hash. Fresh `npm run typecheck` and `npm run typecheck:backend` both passed at approximately 2026-10-25 13:54 UTC (06:54 PDT), based on the parent's direct command results. CI remains skipped.

## Remaining work

1. Resolve and validate the dangling agent-work index on a recovery copy; verify broader state consistency before replacing or resuming the existing backend.
2. Restore missing fixture originals or establish their availability, then confirm both case states through the restored application.
3. Complete bill approval and retain separate payment authorization.
4. Execute only this sandbox payment; verify settlement, accounting entries, and bank reconciliation.
5. Verify QBO readback separately if QBO synchronization is included in the completion claim.
6. Preserve fresh runtime evidence in this persistent directory.

No new-case Increase payment/settlement, bank reconciliation, or QBO Bill/BillPayment sync is claimed. The source is a synthetic native PDF; this is not a new LlamaParse validation. CI is skipped at the user's request. There is no Claude independent model review or practitioner sign-off. Earlier INV-1001 provider success is a separate result.
