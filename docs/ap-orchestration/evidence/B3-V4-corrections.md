# B3 V4 corrections

Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.
Scope: B3 corrections for independently reproduced V4 findings F1, F2 and F3. No acceptance claim, provider calls, deploy, canonical registry edits, or shared payment-engine changes.

## Economic capacity

PO, contract, receipt, service and return consumption now retain a fingerprint of the full original semantic line set: original bytes hash, purchasing kind/supplier, SKU, unit, exact quantity and unit price. Parser line IDs, document filenames, source IDs and invoice-line links cannot create another capacity pool. A copied original with changed SKU/unit/quantity/price is held as conflicting evidence. Historical consumptions without fingerprints derive the fingerprint from their exact approved source revision; unavailable history fails closed.

A two-unit original at 3,850 cents/unit can recognize 3,850 and then the remaining 3,850 after parser renumbering. A second two-unit claim is denied. A one-unit return already credited 4,235 cents cannot be credited again after original/source/line renaming. Linked original allocation and tax limits remain in force.

Repeated SKU/unit physical lines within one original are explicitly held until an immutable physical-line mapping is available; arbitrary parser line IDs do not prove independent capacity. Different original documents retain separate capacities. Changed original bytes under an explicit source revision may change capacity while prior same-source/SKU/unit consumption remains deducted.

## Current human authority

Supplier callback and activation retain `verifiedSeatId` and `approvedSeatId`. Activation checks the retained verifier is still an active configured human in the current verification group and is distinct from proposer and approver by seat. Current supplier authority repeats these checks at business/payment gates. Supplier replacement can read the old immutable contact even when its old verifier is unavailable; a new independently verified/approved supplier revision followed by exact business recertification restores authority without a second recognition journal.

Business votes retain `subjectSeatId` and `principalSeatId`. Each pending vote and final recognition/payment validation resolve the current subject bindings and require distinct underlying seats across all positions/stages, including delegated principals. A subject rebind cannot transfer an earlier vote. Delegations retain grantor/delegate seats and reject self-alias delegation or subsequent rebinding. Proposer/case creator checks include the delegated principal seat. Historic supplier approvals, votes or delegations without the required retained seat binding require explicit recertification; they do not acquire authority from today's mapping.

## Validation

- 14 new focused regressions: 13 in `business-authority-regressions.test.ts` and the renamed return-original case in `business-credits.test.ts`.
- 50 focused tests passed, including unchanged copies of the independent verifier's `v4-business.test.ts` and `v4-credits.test.ts` (not committed here), existing business/credit/payment boundary and integration tests.
- Frontend, backend and test TypeScript checks pass.
- Full working-tree suite: 1,120 passed / 4 skipped, including the separate uncommitted B4 draft and the nine independent V4 cases. Isolated staged B3 export: 1,103 passed / 4 skipped (101 passed files / 1 skipped); all three TypeScript checks also pass without B4 files or the copied V4 cases.

Next: independent V4 rerun on this correction commit; resume the separately preserved B4 period-close work. Full end-to-end provider/practitioner acceptance remains with Master and the independent verifier.
