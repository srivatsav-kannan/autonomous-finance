# C4 — credential-independent QuickBooks sandbox connector

Source baseline: `4f7d76d65fac31018642217cca96ebbfeade5ad3` (accepted A3/V2 integration). Work branch: `codex/ap-system-qbo`. Frozen AP spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; existing `ap-evidence-v1` shared contracts unchanged. All source content hashes are in `C4-local.json`; this report intentionally does not embed its own eventual commit hash.

## Implemented

- Server-only Accounting API OAuth2 with accounting-only scope, configured realm and exact localhost callback; session/Origin/Host/CSRF protection, ten-minute random one-time state, code consumption before exchange and denial/replay checks.
- Private 0700 directory / 0600 files, no-follow reads, atomic fsync/rename writes and cross-process serialization. Latest refresh token is retained. Ambiguous/revoked rotation requires reauthorization; old locks are not stolen automatically.
- Fixed sandbox endpoint and minorversion 75 baseline, redirect refusal, 15-second request deadline, 2 MiB response cap, bounded 429/401 retries and fixed-code errors with no token/code/raw-body logging.
- Immutable local operations preserve exact payload, realm, mappings hash, request ID, case/bill/recognition journal/payment version/command/bank transaction/settlement journal/credit IDs; exact external ID, SyncToken and response hash persist after success. Stored payload corruption is rejected even if its old hash field remains.
- Unknown timeouts/crash-retained sending reconcile by marker and complete economic payload. No matches remain unknown; duplicates/changed economics conflict. Unknown operations never acquire a new request ID or automatically repost. Read failures cannot downgrade succeeded/unknown receipts into sendable state. Generic updates/deletes are not exposed; stale external edits require review.
- `convex/apAccountingExport.ts:current` is an authenticated human/account-scoped query. It checks current reviewed approval, original bill and posted recognition; payment export additionally verifies frozen command/snapshot hash, settled observation, matching posted negative Increase debit and exact posted settlement journal. Returned, unmatched, scoped-wrong and corrupt evidence are rejected. No caller-supplied settled boolean is accepted.
- `QuickBooksDispatcher` injects a request-bound authoritative export loader. Before a first POST, after mapping/network waits, it re-fetches authority and checks the external Bill for changes. Fake/local exports are dry-run only. BillPayment records the already settled Increase transaction, with no Payments API or bank execution capability.
- Standalone callback at reserved localhost:8824 and CLI `dry-run`, `inspect`, `mapping-check`, `submit`, `verify`. Dry-run accepts saved JSON without credentials; submit rejects JSON and queries the authenticated backend. Operator registration, US sandbox, Development credentials, normal consent, mappings, dry-run, external IDs/readback and recovery steps are in `QUICKBOOKS-SETUP.md`.
- B3 optional `creditPlan` hook creates VendorCredit recognition from approved reversal allocations and original Bill identity; no generic credit submission until B3 authoritative loader is integrated.

## Verification

Final command:

```sh
node_modules/.bin/vitest run tests/ap-system/quickbooks-protocol.test.ts tests/ap-system/quickbooks-export.test.ts tests/ap-system/quickbooks-callback.test.ts tests/ap-system/accounting-backend.test.ts tests/ap-case-payments.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/tsc --noEmit -p convex/tsconfig.json --pretty false
node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
```

Results: **47/47 tests passed in five files**, including **28 C4 tests** and 19 existing accounting/payment regression tests. All three TypeScript checks passed. C4 includes real ephemeral loopback HTTP callback requests, a spawned credential-free CLI process, independent fake Intuit HTTP responses, private temporary filesystem state and actual Convex-test queries; no Intuit call or shared backend write occurs.

Covered controls: exact accounting scope and callback; missing/cross-session/expired/replayed state; wrong realm/duplicate callback params; session cookie/CSRF/Host/Origin binding; token permissions; concurrent refresh; revoked grant; production configuration rejection; one durable request on retry; immutable payload conflict/corruption; unknown timeout with eventual result; unknown with no result; duplicate marker matches; crash-retained sending; stale SyncToken; bounded 429 waits; 401 refresh; redaction; changed mappings; scoped authorization; reversed recognition; missing mappings; valid exact Increase settlement; unmatched/returned/hash/journal/amount/scope failures; authority revalidation after waits; credit allocation sums; credential-free dry-run and rejected file-based submit.

## Measured boundaries and pending external gate

- Live Intuit account/application/grant/company/API writes: **NOT_RUN — no owner account or grant exists**. No provider credentials were loaded or printed. No external IDs are fabricated.
- Shared backend deployment, server/Auth0 composition and read-model external-ID display: Master-owned, not changed here. Query uses existing tables; no schema/generated API/package edits.
- Callback was only exercised on an ephemeral loopback test port and closed. No persistent listener on 8824, shared service or Docker change.
- Narrow USD account-based profile, one full original Bill per settled payment, no applied credits in payment snapshot. QBO tax-engine/class/project/item mappings, partial/multi-bill payments, credit application/refunds/returns/corrections remain explicit unsupported paths. Credits recognition has a typed hook; B3 authority integration is pending.
- Private filesystem is the journal/token authority for this single-host connector. It is not a multi-host distributed store. A process crash with a retained lock requires operator verification before lock cleanup. A normal future remote deployment needs equivalent durable shared storage/locking.
- Exact matching is conservative: provider normalization or unexpected fields/line shapes can hold the operation. Actual sandbox payload acceptance/readback remains an external acceptance gate, not inferred from mocks.

## Primary-source research

Checked 2026-10-25. Current official Intuit dynamic OAuth, Bill, BillPayment, VendorCredit and minor-version pages returned a sign-in shell. Official OAuth SDK/release notes were accessible and support current endpoint/refresh behavior; official static BillPayment types support accounting field shapes. Intuit's indexed API best-practice article describes request-ID idempotency. No third-party schema is treated as authoritative; no claim that minorversion 75 is latest.

- https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- https://github.com/intuit/oauth-jsclient
- https://github.com/intuit/oauth-jsclient/releases
- https://blogs.a.intuit.com/2018/09/10/quickbooks-online-api-best-practices/
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendorcredit
- https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/BillPayment.html
- https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/3929f979-5d03-fcdb-4fc8-bb3c9aa384fa.htm
- https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions

Acceptance remains Master-owned; successful local controls do not satisfy C4 external sandbox acceptance.
