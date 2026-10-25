# E02 journal locations and authorized project catalog

This checkpoint follows `ae0a3d90f24ec72ae783603853b5528ea9bab1cf`. Frozen spec remains `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. All validation below used synthetic local authority and protocol doubles. No provider request, credential access, OAuth grant expansion, active policy change, or canonical registry edit occurred.

## Journal location mapping

The approved close export already retains exact per-line department, project and store. The QBO close dispatcher now maps each department to `JournalEntryLineDetail.DepartmentRef` using the explicit reviewed `department_as_location` policy. Store remains `ClassRef`. Different lines may have different departments; a classless/locationless liability line remains classless/locationless. The dispatcher does not infer a transaction-wide location or split journals. Current reference checks require enabled location tracking and exact active Department identity/name. Missing mappings hold before any write.

The regression uses an actually approved local accrual and its partial reversal, then proves exact per-line mapping and rejection of externally added or changed location references. Recursive readback still permits unrelated provider metadata.

Project-bearing close journals remain `journal_project_entity_or_billability_unsupported`. The public JournalEntry schema permits `Line.ProjectRef`, but the line's single Entity must preserve Vendor on AP and its BillableStatus is read-only. This checkpoint does not substitute a Customer for the approved Vendor or pretend to set writable billability. A proven supported representation remains required; this is an explicit unresolved part of E02.

## Bounded project catalog adapter

`src/ap-system/quickbooks/project-catalog.ts` implements `ProjectCatalogVerifier`. It accepts only 1–25 distinct decimal project IDs in the configured realm. Requests are static GraphQL queries to `https://qb-sandbox.api.intuit.com/graphql`, never mutations. Each result must contain the requested ID, exact account/realm, a customer ID, bounded name and one of the operator's explicitly selected usable statuses (`ACTIVE` and/or `IN_PROGRESS`). HTTP-success partial GraphQL errors, malformed envelopes, missing nodes and identity/status conflicts fail closed. Projects are not inferred from Customer names or accounting-only access.

The configured factory is `configuredProjectCatalog(env, transport?)`. Absent `QBO_PROJECTS_PRIVATE_DIR` returns no verifier; a configured path must be absolute. Construction is lazy and performs no network or file reads. On an explicit mapping verification, it uses the existing private-store permission checks to read:

- `project-catalog-config.json`: version `ap-qbo-project-catalog-v1`, environment `sandbox`, realmId, explicit `acceptedStatuses`, and `ttlMs` from 1,000 through 300,000.
- `project-grant.json`: version `ap-qbo-project-grant-v1`, environment `sandbox`, realmId, grantId, SHA-256 clientHash, scopes including `project-management.project`, authorizedAt, accessToken and expiresAt.

The trusted normal-OAuth owner supplies that separate grant only after actual authorization. The adapter neither acquires/expands consent nor imports the accounting token. There is no manual JWT or entitlement-boolean shortcut. A 401 can reload a token rotated by that owner only if the immutable grant identity matches; otherwise reauthorization remains required. HTTP 403 is an entitlement hold. Successful authenticated project reads produce a realm-bound catalog with response and grant-proof hashes; a configured receipt alone does not authorize submission.

Bounds are 15 seconds per request, 60 seconds per verification, 256 KiB per response, at most three attempts per ID, and at most five seconds of delay per bounded 429/5xx retry. No partially populated catalog is returned. Token values and provider diagnostics are not placed in errors. Successful raw response bodies and catalog receipts are retained only in the private store with SHA-256 references and mode 0600; request headers are not saved.

Runtime integration seam: pass `configuredProjectCatalog(...)` as the third argument to `new QboClient(oauth, sleep, verifier)`. The transport is supplied to OAuth; argument two is the retry sleeper. Root owns that wiring. Ordinary accounting status must remain provider-free. An explicit preview/submit verification requires a fresh catalog; this checkpoint did not configure a live path or grant.

## Validation and remaining gates

- `vitest run tests/ap-system/quickbooks*.test.ts`: 13 files, 106 PASS.
- `tsc --noEmit`, `tsc --noEmit -p tsconfig.tests.json`, `tsc --noEmit -p convex/tsconfig.json`: PASS.
- New catalog probes cover private permissions/no token leakage, lazy configuration, wrong/missing/expired grant, wrong realm/scope, negative grant time, partial/malformed GraphQL, ambiguous IDs, response bounds, entitlement denial, bounded retry, exact grant-preserving rotation and fresh QboClient catalog verification.
- No live API acceptance is claimed. The separate project grant, tenant entitlement, operator mapping/status policy, actual reference data and live readback remain pending.
- Payment location authority remains a hold. The specific proposed immutable policy/command/return chain is in `E02-settlement-dimension-proposal.md`; no payment-kernel file was changed here.

## Primary documentation checked 2026-10-25

The public [JournalEntry schema](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry) documents per-line DepartmentRef, Line.ProjectRef, Vendor/Customer Entity constraints and read-only BillableStatus. [BillPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment) documents transaction DepartmentRef and Bill/VendorCredit/JournalEntry links. These schemas were read without using API Explorer execution.

The [official Intuit Projects guide](https://medium.com/intuitdev/unlocking-project-tracking-with-the-projects-api-c0812fafa2dc) distinguishes Projects GraphQL scope and entitlement from Accounting REST. The implementation uses the official sample's [sandbox endpoint](https://github.com/IntuitDeveloper/SampleApp-Project-NodeJS/blob/master/routes/project.js) and [by-ID query](https://github.com/IntuitDeveloper/SampleApp-Project-NodeJS/blob/master/graphql/project/getProjectById.js), avoiding unsupported list-ID filters. Published examples use ACTIVE and IN_PROGRESS; accepting either still requires explicit operator selection. The sample and schema are implementation evidence, not evidence of this tenant's authorization or API acceptance.
