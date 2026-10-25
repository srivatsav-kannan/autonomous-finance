# V13 — frozen recoverable-tax baseline

**20/21 independent tests pass; V13-F1 remains open. All 48 bounded owner tests and all three TypeScript checks pass.** Immutable runtime: `1108afee1091554c2b58ecf8852b79f4139f06b6`. Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`. This is independent agent engineering review with synthetic originals and humans, not practitioner tax advice or live system acceptance.

## V13-F1 — original invoice can masquerade as separate eligibility evidence (P2)

`src/ap-system/tax-policy.ts:49–52` checks that each eligibility citation resolves to a document marked `other`, `contract` or `correction`. It does not check whether that document is byte-identical to the original invoice. The stated contract requires separate eligibility evidence and forbids an invoice from asserting its own eligibility. Original identity is its bytes/hash, not its filename or source ID.

The final independent test starts from the actual tax business fixture, copies the invoice without changing its original bytes or SHA-256, changes only its source ID/delivery/name and kind to `other`, and appends that copy in a public explicit case revision. Public ingest and field review succeed. It points the tax eligibility citation at the copy's printed `10%` and submits the normal business proposal. **The proposal succeeds for 8,470 cents**, although the unchanged negative assertion expects `tax_eligibility_evidence`. Thus relabeling the same original bypasses the evidence-separation gate. This is not an automatic posting or payment defect: independent financial/tax votes remain required.

The failure is retained in `tests/ap-system/v13-tax-independent.test.ts`. Reported to Master and B; no production fix by the verifier. Reject byte-identical invoice material as independent eligibility evidence regardless of source ID/name/kind. Any repair should also consider the newly added adjustment evidence boundary separately, without broadening this baseline's acceptance.

## Independently derived passing outcomes

The new two-SKU example explicitly assigns original freight 200 + 100 and discount 50 + 50; accepted freight is 20 + 30 and discount 10 + 20. Original taxable bases are 1,650 and 1,050; each accepted base is **510**, so each line's tax is **51**. At 50% recovery each line rounds separately to **26**, giving cost **1,070**, receivable **52**, and AP **1,122**. Using aggregate recovery 51 is rejected. Two linked returns consume exactly their separate header shares and leave all three accounts at zero; original journal contents remain unchanged and no command is created.

Duplicate/global-mismatched original or accepted freight/discount shares, quantity-only tax instead of declared header-adjusted tax, and borrowing one cent of another line's still-unused freight capacity are refused.

A stated-amount claim retains `rateBps:null` and no rate citation through partial recognition: accepted net **3,850**, tax **385**, 37% recoverable **142**, cost **4,093**, AP **4,235**. An explicit one-cent tax-only credit followed by the remaining merchandise return reverses recovery **0 then 142** and leaves cost/tax/AP zero. For full recognition, tax credits **1, 384, 385** reverse the original 285 recovery as **0, 143, 142**; a further cent is rejected. These expectations were fixed independently of mapper output.

Two competing final tax votes each seeking 501 of the original 770 tax permit exactly one. The winner leaves tax capacity 269 and recovery 100; the exact remainder succeeds, leaving the original 7,700 merchandise cost/AP and zero tax receivable. Cost reclassification cannot move remaining tax receivable into inventory or cost into the tax account.

Further passing cases reject invoice-kind eligibility, stale eligibility revisions, changed eligibility quotations, numerical facts sourced from eligibility material, foreign invoice citations, invented rates for stated claims, wrong tax-group voting, and retired retained voters. Retiring the final tax reviewer after approval blocks payment authority. Integer half-up ties and safe-integer bounds were tested independently.

## Evidence and reproduction

[Machine-readable results](V13-baseline-results.json) retain all assertion identities, exact failure, source-test hashes and raw result hashes. The test fixture is synthetic text standing in for originals; this is not a parser/PDF experiment. Existing fixture helpers provide established AP setup; the new two-line values, expected account totals, negative mutations and credit sequence are independent.

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v13-tax-independent.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v13-independent-baseline.json
node node_modules/vitest/vitest.mjs run tests/ap-system/tax-policy.test.ts tests/ap-system/tax-business.test.ts tests/ap-system/tax-header.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v13-owner-baseline.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

The initial concurrency harness omitted the required financial variance step for tax-adjustment credits. It was corrected to complete that stage before racing final tax votes, retaining all original financial assertions. This setup correction is not a product finding.

Only independent tests/evidence were edited. No live provider, credentials, shared backend, active policy or canonical registry was touched. D's header UI and new post-recognition eligibility adjustment commit `a5aaa71`/`3ee360d` are excluded from this frozen baseline. Real practitioner eligibility decisions remain an external acceptance item.
