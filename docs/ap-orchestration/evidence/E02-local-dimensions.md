# E02 local dimension propagation checkpoint

This follows adapter checkpoint `8894bfb` and E04 source `3242bf6d64d72c2be6ec21a4feefe755f21a265a` (local cherry-pick `02864f7`). Frozen spec remains `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. No canonical registry, runtime config, provider credential, active policy, or tenant was changed.

## Explicit authority and exact propagation

A business policy may now declare `dimensions: {version: "ap-gl-dimensions-v1", scope: "cost_allocations", departments: string[], projects: string[]}`. Activation uses the existing authenticated controller proposal and independent human policy approval. The lists have no defaults and reject duplicate IDs. Absent policy and unknown IDs retain controller-owned holds. These are approved cost allocation dimensions; this declaration does not infer AP/cash dimensions or decide QBO location semantics.

Approved invoice cost/tax-bearing allocations, freight and signed discounts preserve department/project in posted journal lines. Linked credits inherit the exact original dimensions and signed allocation shares. The backend adds optional fields to the journal validator and posting input; it does not rewrite old entries. Historical recognized exports check the original approved allocations against the posted journal including dimensions. Legacy null/null exports keep their prior serialized shape; new extended allocations emit both explicit nullable fields.

Cost-state identity is now `(account, store, department, project)`. Reclassification capacity and correction-path reachability are partitioned by those exact coordinates. A correction can change an approved account along an approved path but cannot transfer an original allocation share to another department/project. Accrual posting, corrected partial reversals and immutable close exports carry the same dimensions. New credits/reversals recheck current dimension policy; retiring permission does not erase historical journal/export facts.

The QBO dimension tests now obtain their dimensional invoice from a genuinely approved local backend allocation and authenticated export. They no longer inject dimensions into a legacy export projection.

## Remaining gates, not completed scope

- QBO Bill/VendorCredit still require the separately reviewed adapter policy from `E02-qbo-dimensions.md`: homogeneous transaction department mapped explicitly as QBO location; store mapped to Class; project/customer/billability mapped with current catalog and entitlement evidence.
- A department-bearing cash/credit/restored-payable settlement remains `department_settlement_authority_required`. No AP/cash location has been guessed from cost allocations.
- A close journal with department/project remains `close_dimension_authority_required` in the external adapter. The local authoritative journal/export is lossless; external replication waits for supported exact JournalEntry mapping.
- Current project catalog adapter, entitlement/scope, real policy selection, UI review affordances and live provider verification remain separate unfinished work. These tests do not establish live QBO acceptance.
- The original first-wave policy remains unchanged and holds extended dimensions. The governed business-acceptance path is the enabled route.

## Validation

All tests use the isolated local Convex test harness and protocol doubles, with no services or provider calls.

- `vitest run tests/ap-system`: 78 files / 559 PASS before the final extra signed-tax/freight/discount probe.
- `vitest run tests/ap-system/local-dimensions.test.ts`: 6 PASS including that final probe.
- `tsc --noEmit`, `tsc --noEmit -p convex/tsconfig.json`, `tsc --noEmit -p tsconfig.tests.json`: PASS.
- `git diff --check`: PASS.

The new authenticated tests cover missing/unknown policy holds with no posting, legacy serialization, exact same-account/store capacity separation across departments/projects, correct reclassification export, linked credit inheritance, rejected cross-project correction, corrected partial accrual reversal, signed header/tax allocation preservation, changed journal dimension rejection, and current-policy retirement with historical preservation. Existing AP tests cover E04 physical identity compatibility and QBO mapping/readback holds.
