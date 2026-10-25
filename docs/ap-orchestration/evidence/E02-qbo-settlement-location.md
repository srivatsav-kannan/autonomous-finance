# E02: exact QBO settlement location checkpoint

Frozen spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`.
Dependency: local lifecycle checkpoint `41a1116575f98460209e4164776363a0fa4e6e50`. This follow-up does not change active policy, run configuration, worker configuration, OAuth scopes or provider state. All execution below is local; external accounting acceptance remains unmeasured.

The existing opt-in `cost_and_settlement` policy and explicit `homogeneous_approved_department` decision now propagate their immutable recognition authority through QBO exports. Authenticated export checks the frozen snapshot and command hash, exact bill/credit recognition bindings, original posted settlement journal coordinates and, for the new binding, the stored journal hash. Return evidence validates both debit and return journals with the same exact department. A controller's replacement allocation must retain the original restored payable's scope and department; no split or guessed assignment is introduced.

BillPayment uses the approved transaction-level `DepartmentRef`. Return JournalEntry uses the same location on each bank/AP line and retains the Vendor entity on AP. Replacement cash and zero-cash credit application link the approved restored JournalEntry and actual VendorCredit while preserving location. Existing payloads without dimension authority retain their prior shape. Department-bearing cost-only records still hold for settlement; missing/changed source authority, mappings or tracking entitlement still hold. Projects remain cost dimensions under separately reviewed catalog/billability mappings; this change does not manufacture a project Entity on an AP journal or a project dimension on cash payments.

The pure binding schema/helper moved from `src/payments/accounting-binding.ts` into `src/payments/domain/accounting-binding.ts`. This satisfies the existing payment dependency boundary without relaxing its test or importing backend code into the domain.

## Primary API basis

- [Intuit BillPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment): transaction DepartmentRef; linked Bill, VendorCredit and JournalEntry; explicit TxnDate/APAccountRef. The adapter never enables merchant processing.
- [Intuit JournalEntry](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry): per-line DepartmentRef; AP Vendor Entity retained. Project combinations that cannot preserve Entity/billability semantics remain held.

The primary references were researched in the earlier E02 lifecycle/catalog checkpoint. This follow-up makes no live API call and does not claim tenant/API acceptance from documentation or mocks.

## Local verification

Five new tests in `tests/ap-system/quickbooks-settlement-dimensions.test.ts` cover authenticated actual local request/approval/posted-journal export: partial cash with credit, approved return plus zero-cash restored credit, forged journal dimension rejection, independently approved replacement cash, and ambiguous external response recovery. The last uses an injected protocol double: one POST, durable unknown state, same request ID, original authenticated authorizer preserved during recovery, and changed location rejected on readback.

Existing frozen-binding tests cover first-dispatch authority, validly rehashed forged command binding, retired-policy possible-send reconciliation, exact returned cash coordinates, credit consumption surviving cash return and legacy absence/hash behavior. Existing QBO dimension and payment architecture tests remain unchanged. The first broad AP/payment run found one authority error-order difference; the preflight was restored and all 38 affected tests then passed unchanged.

The separate independent V11 successive-credit finding is repaired by B's `f760a90` in `costState.ts`, deriving the expected AP dimensions from the immutable original recognition. That repair is not duplicated in this checkpoint. Master must integrate it alongside the lifecycle dependency.

Final validation: `vitest run` passed 1,599 tests with four skipped (172 files passed, one skipped). All three TypeScript checks passed (`tsc --noEmit`, tests config and Convex config), as did `git diff --check`. The architecture-only correction was separated as `8be040b1b022764055016003256332de9be03656`; this checkpoint depends on it. Remaining gates: independent V review, operator policy/mapping selection, real authorized sandbox accounting verification, and project entitlement/catalog verification. No live policy or account change is implied.
