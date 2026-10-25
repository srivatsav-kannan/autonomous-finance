# AP agent sandbox rollout — runtime restored, full flow not passed

The existing sandbox now runs from a repaired recovery copy on ports **3252 / 3253**. The new synthetic **$77.00 USD** case (`INV-AGENT-20261025-01`, `kd70djc8wdam76s7dxz0jxdgv98gzmq4`) still waits for bill approval. **The complete new-case flow has not passed.**

## Recovery and evidence

A targeted forensic repair removed exactly **five orphan index versions** from a copy. The audit preserves all **1,672 surviving documents**, persistence globals and unaffected index-row hashes; latest dangling index references fell from four to **zero**. A separate database agent reviewed the targeted repair successfully, as reported by the parent. This is not an official Convex repair and cannot establish that SQLite `.recover` lost no completely missing records.

The original malformed database is preserved and has not been replaced. The repaired copy currently serves the existing sandbox ports. The earlier `Dangling index reference` blocker is resolved for the checked queries. Full historical database completeness remains unproven.

`recovered-business-checkpoint.json` contains sanitized audit data, response hashes, current work state and four original PDF hashes, all of which match the recovered originals. Saved readbacks were independently read during evidence preparation; no provider request or database mutation was performed by the evidence preparer. Normal Auth0 login and the Chrome page on port 5192 are restored, as confirmed by the parent: originals, 17 fields and review controls render. The case still shows reviewed / held / authorization not requested / execution not started. A screenshot is preserved as `recovered-ap-page.png`.

## Observed business state

- **INV-1001:** settled, matched, outstanding **$0.00**, one payment and two case-associated journals. These are recovered local records; no fresh Increase or QBO success is claimed.
- **INV-AGENT-20261025-01:** revision 2, document reviewed, business held, authorization not requested, execution not started and accounting unposted; **zero payments and zero journals**. Its agent work item is `waiting` at `bill_approval`, requiring `current_bill_approval`.
- The timeline confirms revision 1 → missing-receipt wait → revision 2 with receipt → field-review wait → recorded field review → bill-approval wait. The normal AP agent `--once` run returned `[]`, reported by the parent; it did not advance past the approval gate. The resident AP worker has since restarted. A saved readback at **2026-10-25 14:21:51 UTC (07:21:51 PDT)** independently confirms the wait survives that restart, with authorization still not requested and zero payments/journals. It also confirms the original malformed database hash remains unchanged; see `post-restart-checkpoint.json`.

The previous browser bill-approval action was rejected by automatic approval review and required the user. No workaround was taken. Separate payment authorization remains intact. No new payment or settlement was created during recovery.

## Source and checks

The live checkout is based on `71853508db2bb95d6d87929ab46c79db1d7b2a0f`, with the minimal agent source delta from `6438103e28c0374110e3d6fb971319555a568690`. Eleven of thirteen inspected files match the reference exactly; the live-base schema adds two agent-work tables and Convex API declarations are regenerated. Source hashes remain in `verification-summary.json`. Fresh `npm run typecheck` and `npm run typecheck:backend` passed at approximately 2026-10-25 13:54 UTC (06:54 PDT), based on the parent's command results. CI is skipped.

## What remains

The user must enter a review reason, confirm the checkbox and click **Approve bill $77.00** in the restored authenticated page. The earlier automatic-review denial of agent clicking still applies. After bill approval, retain separate payment authorization, then run the new Increase sandbox payment through settlement and reconciliation. Issue 108 also requires new-case QBO Bill/BillPayment readbacks and linked QBO/Increase IDs before closure. Broader agent-delivery gaps are enumerated in `ISSUE-108-REMAINING.md`.

The current agent progression is deterministic; a real model decision/tool loop is not established by this run. The originals are synthetic native PDFs, not a fresh LlamaParse validation. No Claude independent model review or practitioner sign-off is claimed.
