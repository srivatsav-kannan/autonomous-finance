# V13 — immutable tax adjustment extension baseline

**New independent checks: 10/11 pass. Unchanged original V13 checks: 20/21 pass. Owner regressions: 67/67 pass. All three TypeScript checks pass.** Combined result is 97/99, with the two failed assertions exposing the same V13-F1 evidence-separation defect through two public proposal paths.

Frozen runtime is `3ee360d747e14a45cd9e39ac0a2f22d76d1d2b77` (adjustment feature originally `a5aaa7189fba9312e24c987fe1af1e470a71c134`). Verification HEAD before this report is `b7f9c0faf015247b64bb081b85f2a839d32fb41b`, adding only the already frozen original V13 tests/evidence. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. This is independent agent engineering review.

## V13-F1 extension — same invoice bytes accepted as adjustment eligibility (P2)

`convex/lib/apSystem/taxAdjustments.ts:515–528` resolves the retained eligibility citation and permits `other`, `contract` or `correction` document kinds, without excluding the original invoice hash. The independent test first posts a valid original bill. It copies the exact original invoice bytes/hash, changes only source ID, delivery ID, filename and kind to `other`, and delivers the copy through actual public case ingestion. After activating a synthetic 50% recovery policy, it submits an otherwise valid remaining-tax adjustment using the copy's printed `10%` as its eligibility support. **Public `apClose:propose` succeeds instead of rejecting `tax_eligibility_evidence`.**

The initial business-proposal manifestation remains reproducible, with its original test sources and assertions unchanged. The new failure proves the same separation gap also exists after recognition and when the alias is separately retained. An invoice cannot become independent eligibility evidence by renaming it. This does not claim automatic posting or payment: financial and tax approval stages remain required. Both probes were sent to Master and the accounting owner. No production code was changed by the verifier; root's repair is not included in this frozen checkpoint.

## Independent positive and negative outcomes

The principal sequence starts with net 7,700 and tax 770 at 37% recovery: receivable 285, embedded cost tax 485, total cost 8,185, and AP 8,470. A prior 100-cent tax credit consumes recovery 37 and embedded cost 63, leaving cost 8,122, receivable 248, and AP 8,370. A reviewed cost correction moves all 8,122 to inventory. The new 100% recovery policy requires explicit attribution of the remaining **422** embedded-tax cents to their original line/allocation and current inventory location. Moving exactly 422 to receivable leaves inventory **7,700**, receivable **670**, AP **8,370**. No bill, AP or cash entry changes; the prior journals remain byte-for-byte equal. Owner and finance votes alone do not post; the separate tax vote posts once, and exact replay has no duplicate effect.

Two later merchandise returns of 3,850 each, with taxes 285 and 385, require current tax and cost snapshot bindings and exact current tax buckets. The obsolete plan is rejected. After explicit attribution, both succeed and leave inventory, cost, receivable and AP at zero; earlier journals remain unchanged.

A final tax-adjustment vote racing a final supplier-credit vote yields exactly one successful transaction, two total journals and no payment commands. The remaining tax capacity and attributed/unattributed bucket total stay equal. This is an isolated transaction-race probe, not a load test.

A separate adjustment establishes a 290/770 recovery basis. Five successive one-cent tax credits must reverse recovery **0, 1, 0, 1, 0**, not independently round every credit or reuse the original 100% rate. The resulting receivable is 288 and AP is 8,465, with five tax cents and two recovery cents consumed.

Six negative probes reject wrong original approval, stale tax hash, stale cost hash, a cash destination, wrong original allocation coordinates, and reuse of an intermediate movement destination as available original capacity. Each preserves the entire observed business state. Public tax-state reads reject unauthenticated and wrong-run callers, while a current scoped finance human can read the original approval binding.

## Reproduction and limits

[Machine-readable evidence](V13-adjustment-baseline-results.json) retains all 99 assertion identities, exact failures, unchanged original-test hashes, new-test hashes and the raw result digest.

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v13-tax-independent.test.ts tests/ap-system/v13-tax-adjustment.test.ts tests/ap-system/tax-policy.test.ts tests/ap-system/tax-business.test.ts tests/ap-system/tax-header.test.ts tests/ap-system/tax-adjustments.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v13-extension-baseline.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

All documents, policies and human identities are synthetic. Actual AP mutations and queries execute in isolated `convex-test`. This checkpoint excludes D's UI, QBO tax export, live backend/provider behavior, credentials, statutory-policy validity and practitioner sign-off. It is additive to the initial V13 baseline, not a replacement for its frozen failure evidence. Only tests and evidence are committed; the canonical registry is untouched.
