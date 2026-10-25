# E04 — reviewed physical receipt-line identity

Baseline: `9bd420f2cf90a9da9a35b220051cdde809b1aa3c` plus isolated E03 corrections `d470141` and `53eb109`.
Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.
This is a backend/contracts component checkpoint. No UI, HTTP acceptance, real backend/provider, physical receiving observation, or practitioner signoff is claimed.

## Rules and safety boundaries

- Original SHA-256, supplier and economic purpose identify a single immutable physical catalog. Parser IDs, upload names and source IDs cannot create another catalog for identical original bytes. A receipt used for returns cannot silently become receiving capacity, or vice versa.
- A current controller proposes a complete mapping bound to a current field-reviewed case ID/revision/snapshot and exact original SourceBinding. A current independent human in the explicitly configured `receiptIdentityApprovalGroup` approves the exact proposal/policy hash. Neither proposal nor rejection grants capacity authority. The positive decision is immutable, and current reviewer seat/group authority is checked at claim use and at subsequent business/payment authority checks.
- The first positive review freezes physical IDs, SKU/unit/unit price, per-line capacity, and exact source locators. Locators contain page, global extracted-text start/end offsets and quote; quotes must match retained text, state the physical quantity/unit, identify SKU, and not overlap another physical line's span. Page exists in the original. This is evidence for a human comparing the original; it does not claim that text offsets are verified PDF coordinates or that software observed delivery.
- Every parser row must map in full, and every frozen physical row must be covered in full. Links conserve exact decimal quantities and match SKU/unit/unit price. Reordering is harmless; renaming, split and merge representations need their own positive, case-bound mapping to the same frozen catalog. Conflicting quantities/units/prices cannot redefine capacity.
- Accepted quantities explicitly allocate to physical IDs. A partial merged parser row is never distributed automatically. Individual physical consumption cannot exceed frozen capacity; because the complete mapping conserves all rows/columns, aggregate consumption cannot exceed the frozen original total. Final business votes repeat the capacity check in the posting transaction.
- Unmapped originals retain all preexisting semantic-hash/aggregate protection. If a physical catalog exists, a claim without its positive identity mapping is held. Initial catalogs for previously consumed/accrued originals are held (`physical_legacy_usage`), preserving their existing economics instead of guessing attribution. Old B1 whole-line reservations still apply.
- Invoice recognition, explicit supplier-return credit claims, and received/service accruals use the same physical pools. An accrual explicitly selects one physical line; its partial reversal remains within that line. Later invoice applications match the same physical line, so an unrelated sibling can remain accrued. Period close compares each reviewed physical line's capacity with its own invoiced plus outstanding accrued quantity. Unmapped duplicate SKU/unit rows generate an owned close hold.
- The change creates no cash movement or new AP posting type. Existing recognition, credit and accrual journal rules remain authoritative. Payment execution is unchanged; a retired/remapped identity reviewer blocks new authority while the existing engine retains possible-send recovery.

## APIs and UI handoff

`src/ap-system/physical-line-contracts.ts` exports `physicalLineOperationSchemas`, `PhysicalLineInputs`, `PhysicalMappingProposal`, `PhysicalAllocation`, `PhysicalLine`, and `PhysicalLineView`.

| Backend operation | Trusted transport arguments | Result |
| --- | --- | --- |
| `apPhysicalLines:propose` | Server-owned controller `scope/seatId/token`, `idempotencyKey`, `proposal` | `{reviewId,hash}` |
| `apPhysicalLines:decide` | Current human scope, `input:{reviewId,expectedHash,outcome,reason}` | `{reviewId,catalogId,status}` |
| `apPhysicalLines:view` | Current scoped human; optional caseId filters reviews | Catalogs and review history, with no original bytes/refs, tokens or destination secrets |

A proposal contains `caseId`, `expectedRevision`, `snapshotHash`, `source`, `links:[{parserLineId,physicalLineId,quantity}]`, reason, and exactly one of an existing `catalogId` or initial `physicalLines`. Physical lines contain `physicalLineId`, `sku`, `unit`, `capacity`, nullable `unitPriceCents`, and `locator:{page,start,end,quote}`. Link quantities and physical capacities are decimal strings.

The safe view returns each catalog's frozen lines and current posted `capacities:[{physicalLineId,consumedQuantity,accruedQuantity,remainingQuantity}]`, plus immutable proposals/reviews. Displayed remaining capacity is a current observation, not a reservation. Backend rechecks it at posting.

Existing acceptance contracts gain optional `identity:{reviewId,allocations:[{physicalLineId,quantity}]}` on each receipt claim and on an agreement claim. Existing credits gain optional `returnClaims` with the same source/line/quantity/identity shape; when present they must exactly cover the credit return quantity and its declared `returnEvidence` originals. Existing accruals gain optional `identity:{reviewId,physicalLineId}`. Do not add identity fields by guessing from parser order or names.

D should expose positive identity review as a separate human decision after field review, show the actual original and the complete mapping, then allow business acceptance to select approved physical IDs/quantities. Rejected/unreviewed maps must not unlock recognition. The policy editor must expose the explicit reviewer group. Existing `ap-evidence-v1` remains unchanged; only optional domain/close contract extensions are added.

New delegated tables: `apPhysicalSources`, `apPhysicalLineReviews`. `apReceiptConsumptions` retains optional `physicalSourceId`, `physicalLineId`, `physicalReviewId`. Existing root `apSystemTables` wiring suffices; root owns generated API refresh.

## Observed checks

`tests/ap-system/physical-lines.test.ts`: 17 tests passed. Positive paths cover two legitimate same-SKU physical lines; reviewed renamed/reordered/merged/split representations; explicit partial merged allocation; non-PO service acceptance; separate supplier-return credits; and an accrued physical sibling later reversed by its own invoice. Adversarial checks cover missing positive approval, duplicate original catalog, overlapping/fabricated locators, quantity/SKU/unit/price changes, missing partial distribution, wrong/retired reviewer, immutable review, pre-mapping historical usage, two concurrent final approvals on one physical line, and period-close completeness.

Full AP/payment regression selection: `vitest run tests/ap-system tests/payments tests/demo-*.test.ts tests/payment-kernel.test.ts` — **95 files, 702 tests passed**. Root/backend/tests TypeScript checks passed. After adding the safe posted-capacity inventory, the 17 focused tests and backend typecheck passed again; no economic logic changed in that projection addition.

All evidence above is in-memory component behavior with synthetic retained originals. It is not a new HTTP/FakeBank run or independent acceptance.

## Explicit remaining boundaries

- Historical untagged consumption/accrual is not automatically migrated into new physical identities. A future governed migration would need exact original-effect attribution; this checkpoint holds such attempts.
- A mapping needs a field-reviewed case with a complete purchasing line set. A standalone original retained only through the period evidence API has no parser-row mapping here. Its preexisting single-line accrual path remains available; ambiguous repeated standalone lines require the supported case/mapping preparation rather than an invented identity.
- Exact numeric quantity/unit text and retained source spans are required. Unsupported extraction, conflicting OCR text/locators, or a merge across different unit prices stays held. No geometry or OCR result is fabricated to pass identity review.
- Each existing accepted invoice line still references one parsed agreement row; its received quantity may use multiple receipt rows/physical identities. The change does not infer or combine unrelated PO agreements.
- D HTTP/UI composition and independent verification are separate follow-up work; do not label this checkpoint as end-to-end or practitioner accepted.
