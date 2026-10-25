# V5 independent B4/C4 baseline review

This is an independent agent engineering review by `/root/verifier` of immutable production baseline `391f2e9fc027f79babd736fe83047bc253bab1fa`, with test-only checkpoint `f82ed1f6297c695f1e2baa3c4928e86dbc06fb1f`. Spec SHA256: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contracts `ap-evidence-v1` and `ap-business-v1`. The independent expectations were frozen in `V5-expectations.json` before the new tests. This report preserves the failing baseline; subsequent repair replay must be recorded separately.

## Result

**65 tests: 62 passed, 3 failed, none skipped, across 8 actual files.** Of these, **16 are new independent tests (13 passed, 3 failed)** and 49 are existing implementation-owner regressions (all passed). Test TypeScript compilation passes. Full identities, statuses, source hashes and raw result hash are in `V5-baseline.json`. V4 repair replay and current V3 contract migration remain separately documented in `V5-checkpoint.md` (41/41); they are not double-counted here.

The baseline is not accepted for B4 close or C4 restored-payable export because of the two findings below. Fix candidates were supplied by the implementation owners after these reproductions; their existence alone does not close a finding.

## V5-F1 — high: any historical accrual incorrectly discharges a standalone receipt

`convex/lib/apSystem/periodView.ts` at this baseline uses `accruals.some(...)` to omit a standalone receipt's `received_not_invoiced` blocker. It does not compare received capacity with remaining accrual units or posted reversals for that source.

The two public-API reproductions in `v5-close.test.ts` retain a separate original receipt for two uninvoiced KALE-24 cases at 3,850 cents each. One case accrues only one unit (3,850), while the other accrues both units (7,700) then explicitly reverses both. A separate recognized 7,700-cent bill, exact opening and independently reviewed supplier statement make other closing conditions valid. In both cases the actual close proposal and governor approval succeed, although the remaining original units have no invoice, outstanding accrual or explicit no-obligation disposition. The independent expectation is rejection and an open period. Missing liability is respectively 3,850 or 7,700 cents.

The problem was reported to Master and accounting owner with the unchanged public-API probes. Candidate repair: `354cb3603c2c723d532969be5c593e3f2b03782e`, unverified at this baseline. It moves standalone reviewed capacity through the same as-of invoiced-plus-accrued-minus-posted-reversal unit accounting as parsed case receipts.

## V5-F2 — medium: malformed successful query is treated as zero external consumption

`src/ap-system/quickbooks/client.ts` uses `data.QueryResponse?.BillPayment ?? []` in `journalAppliedCents`. A missing query envelope is treated as complete proof of zero existing application, allowing a replacement BillPayment POST despite absent restored-principal proof. `find` has the analogous identity-reconciliation fallback.

The independent end-to-end protocol reproduction first exports the original Bill, its 2,000-cent cash payment and an approved 2,000-cent return JournalEntry; it verifies readback, then approves a replacement allocation of exactly 2,000 cents against restored principal. The vendor BillPayment query returns HTTP 200 with `{time: "synthetic-response-without-query-result"}` and no `QueryResponse`. Expected: stop before replacement POST. Actual: a fourth accounting POST succeeds. This demonstrates failure to prove unused external capacity; it does not claim an actual live duplicate or payment execution through QBO.

Reported to Master and C4 owner. Candidate repair: `78532b33f0c5752525c7a2f9c148c92887bf6387`, unverified at this baseline. Legitimate official empty `QueryResponse: {}` must remain supported; missing/malformed envelopes must not imply empty results.

## Passing independent coverage

- B4 rejects a close whose snapshot changes after proposal; competing cost-reclassification approval cannot exceed remaining original cost. The approved export preserves exact noncash accounts, dimensions, original journal and bill links; pending actions cannot export.
- Two pending partial accrual reversals cannot both rely on stale capacity. Two valid fresh one-unit reversals consume exactly 3,850 cents each from original allocations 3,851/3,849, preserving allocation vectors 1,926/1,924 and 1,925/1,925. Invoice recognition reverses only the residual accrued unit atomically, and no already invoiced source units can be accrued again.
- Actual AP backend and FakeBank execution distinguish first send from possible-send recovery. Deliberate test-owned credit-link drift prevents a new request/first dispatch with zero bank attempts. After an accepted-but-lost bank response the original command/reservation recovers without a second transfer; repeated reconciliation produces accepted 7,700, credit 1,200, cash 3,800, remaining 2,700, three journals and one transfer.
- QBO signed discount export preserves original positive cost and negative contra-cost: Bill 77 minus 1 = 76 dollars, VendorCredit 38.5 minus 0.5 = 38 dollars. Gross Bill discharge 40 with selected credit 12 uses cash 28, leaving 36 dollars outstanding. Retrying does not mutate the original Bill or create another POST.
- Missing/wrong-plan/stale/future first-write authorization produces zero POST attempts; a changed preview hash rejects before any provider call. An accepted return JournalEntry with a lost response recovers from a reopened private store with the original request ID, approval and one attempt. Return accounting debits bank and credits AP for 20 dollars; the original payment remains unchanged. Ordinary hold inspection makes no provider calls, explicit readback resolves only covered return holds, and an unrelated hold remains active.
- Duplicate external application rows, mixed Bill/JournalEntry links and fractional-cent applications each stop before replacement POST.

## Evidence boundaries and remaining gaps

The close and governed-credit tests exercise real Convex mutation/query implementations in isolated `convex-test`. Configured humans are explicit simulated identities. The governed-credit tests use the actual FakeBank dispatcher and reconciliation kernel. The QBO tests exercise actual AP authority and accounting export plus an in-memory HTTP protocol double; their settlement/return rows are explicitly test-seeded Increase-shaped evidence, not proof of actual bank settlement. No production, shared backend, provider account, credential, browser or live service is accessed. Private test journal files are temporary and removed.

B4 inspection includes `apClose`, `periodView`, accrual capacity, source evidence, authoritative export and correction authority. B4 export derives approved action/application and exact posted journals, including current retained human authority; it is not proof of live external posting. Repeated ambiguous original SKU/unit lines remain held. Credits following cost reclassification and unsupported accrued-cost corrections remain explicit supported-path limits. This review does not accept every roadmap path, actual Auth0 login/JWT verification, live Increase/QBO behavior or an AP practitioner's sign-off. Those external acceptance items remain outstanding.

## Exact commands

```sh
./node_modules/.bin/vitest run tests/ap-system/v5-close.test.ts tests/ap-system/v5-quickbooks.test.ts tests/ap-system/v5-governed-credit.test.ts tests/ap-system/close.test.ts tests/ap-system/governed-payment-credits.test.ts tests/ap-system/quickbooks-business.test.ts tests/ap-system/quickbooks-business-sync.test.ts tests/ap-system/quickbooks-business-protocol.test.ts tests/ap-system/quickbooks-corrections.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v5-baseline-results.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json --pretty false
```

The command included a nonexistent `quickbooks-business-sync.test.ts` filter; Vitest matched eight actual files listed in the JSON, not nine. There is no coverage claim for that nonexistent file. Node modules are a read-only dependency symlink; caching is disabled. No production fixes or canonical registry changes are part of this baseline evidence commit.
