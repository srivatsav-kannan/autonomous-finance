# E02 QBO dimension checkpoint

Baseline: integration b3c3bc64c0564fa7ee5f61bb5d856cdd3883045c. This checkpoint implements credential-independent adapter semantics; it does not enable department/project accounting in the local ledger or report live acceptance.

## Implemented contract

`Mappings.dimensions` is an optional versioned, reviewed operator policy. Department mapping requires literal `department_as_location`, a policy ID, reviewer, decision time, and explicit local department → QBO Department mapping. Bill/VendorCredit allocations must have exactly one common department, including explicit null; mixed values hold instead of splitting or dropping allocations. Existing store → expense-line ClassRef remains unchanged.

Projects require reviewed local → QBO project/customer mapping and an explicit boolean billability decision. They produce `Line.ProjectRef`, expense-line `CustomerRef` and the exact reviewed `BillableStatus`. A realm-bound, expiring catalog receipt includes source-response and entitlement hashes and the actual project/customer relationship. Missing, expired, ambiguous, inactive or contradictory catalog evidence holds. These hashes identify evidence, not an authorization credential.

`QboClient` accepts an optional third argument `ProjectCatalogVerifier({realmId, projectIds}) -> Promise<ProjectCatalog>`. This is a trusted server injection for current provider catalog/entitlement verification. Without it, project submission rejects before any provider call; a static configuration flag/receipt cannot bypass that gate. Current OAuth remains accounting-only, and no project-scope acquisition or real catalog adapter is wired by this checkpoint. Mapping verification also checks active Department/Customer records and enabled location tracking. Ordinary status remains provider-free.

Legacy recognized allocations omit both department/project because the legacy business policy prohibits them. New allocations must carry both explicit nullable fields together; one missing field is rejected. An old candidate cannot gain dimensions via a fallback mapper. All mapping decisions are in the frozen mapping/payload hashes and existing immutable-operation conflict checks.

Readback now rejects unexpected, missing or changed ClassRef, DepartmentRef, ProjectRef and CustomerRef recursively. Unrelated additive provider metadata remains accepted.

## Remaining authority gates

The local backend still holds non-null department/project allocations. Its historical recognition export must be extended after E04 without fabricating dimensions for old approvals. Department-bearing settlement/credit application/restored allocation remains an owned hold until local AP/cash journals and the application authority explicitly carry the location dimensions. Extended close journal department/project fields are held, never silently discarded. Project-cost lines do not automatically assign a project to cash/AP settlement.

Full E02 remains open: local journal/credit/correction/close propagation, operator policy selection, trusted current project-catalog integration and entitlement, and live sandbox readback acceptance are still required. No OAuth expansion, provider call, tenant change or economic policy selection occurred.

## Validation

- `vitest run tests/ap-system/quickbooks*.test.ts`: 12 files, 99 tests PASS (mock/local only).
- `tsc --noEmit`, backend and test configurations: PASS.
- New probes cover location homogeneity including null, explicit policies and billability, catalog scope/realm/expiry/relationship, no-verifier durable prepared state and zero POSTs on retries, provider reference conflicts, recursive readback and unchanged non-dimensional metadata acceptance.

## Primary documentation checked 2026-10-25

The public [Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill) and [VendorCredit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendorcredit) schemas show transaction-level DepartmentRef (location) and Line.ProjectRef; [JournalEntry](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry) also shows Line.ProjectRef. These were read in a dedicated public documentation tab without using API Explorer's Try it operations.

The [official Intuit Projects guide](https://medium.com/intuitdev/unlocking-project-tracking-with-the-projects-api-c0812fafa2dc) separates GraphQL catalog operations using project-management.project from accounting REST association. The [2026 Dimensions announcement](https://medium.com/intuitdev/launch-alert-new-project-management-apis-and-custom-dimensions-enhancements-f9610448fbe7) limits custom Dimensions functionality to Intuit Enterprise Suite; this adapter does not assume that entitlement.
