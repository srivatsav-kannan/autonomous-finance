# V11 — independent local settlement-dimension repair replay

**All 12 unchanged independent tests, 8 owner lifecycle tests and 3 unchanged architecture tests pass.** Root, Convex and test TypeScript checks pass. This closes V11-F1 and the previously known V11-K1 for the bounded local `cost_and_settlement` lifecycle. This is an independent agent engineering review, not practitioner or live provider acceptance.

## Immutable evidence chain

| Stage | Runtime | Independent | Owner lifecycle | Architecture |
| --- | --- | --- | --- | --- |
| Frozen baseline | `41a1116575f98460209e4164776363a0fa4e6e50` | 11/12 | 8/8 | 2/3 |
| Credit repair | `a43852e502948db5ad4450f416a8c7103ef822dd` | 12/12 | 8/8 | 2/3 |
| Credit and architecture repairs | `5c3459890499a16d3ed9a895dc9f29d925b2cf47` | 12/12 | 8/8 | 3/3 |

The original baseline report and independent tests are preserved in `8520406ea07a48927fd3e478375e6ff68be62370`. Their cherry-pick onto the integrated credit repair is `f062fa8853853c39d78822aa9933d516470e72d7`. Final runtime `5c345989` adds only architecture repair `8be040b1b022764055016003256332de9be03656`. Both independent source files retain their baseline SHA-256 values. The architecture test is byte-identical to the frozen baseline. Assertion identities, raw result hashes and all category counts are recorded in [V11-repair-results.json](V11-repair-results.json). The frozen failures remain in [V11-baseline.md](V11-baseline.md).

Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Contract: `ap-evidence-v1`.

## Repairs verified

**V11-F1:** B's `f760a90f05809c1fa650db53ceba9baa7a17fd13` derives the expected historical credit AP coordinates from the immutable original recognition AP leg. The original failing probe now creates both legitimate 3,850-cent credits against the 7,700-cent recognition and completes a zero-cash group with exactly 500 + 600 = **1,100 cents**. Each member carries the same complete binding, replay creates no duplicates, no bank command is created, and changing one member's department makes authoritative grouped reading fail. This correction was independently reproduced before notification of B's concurrent repair; this report does not claim sole discovery.

**V11-K1:** A's `8be040b` moves the pure binding helper into `src/payments/domain` and changes eight import paths, including the moved helper's existing canonical-JSON import. No financial logic or architecture allowlist changes. All three original architecture tests now pass. One owner test import follows the helper move; the independent tests require no edits.

The remaining independent tests continue to exercise actual public AP/payment mutations and the production dispatcher/evidence adapters against an isolated in-memory SQLite FakeBank: exact snapshot/command hashes; rejected rehashed foreign department, amount and journal bindings; current human/policy rejection before first send; accepted-but-lost response recovery after both retire; original key and reservations retained under possible-send tampering; exact cash settlement and return coordinates for both `ops` and explicit null department; duplicate evidence without duplicate effects; and single-credit zero-cash binding enforcement.

The independent arithmetic remains fixed: selected bill 3,000, credit 1,000, cash 2,000; cash return reverses 2,000 while leaving bill paid and credit consumed at 1,000. Recovery uses the original one bank transfer and does not issue a second create call.

## Commands and limits

At both repair stages:

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v11-settlement-binding.test.ts tests/ap-system/settlement-dimensions.test.ts tests/ap-system/settlement-payment-binding.test.ts tests/payments/architecture.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v11-final-repair.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

The first repair run used output file `/private/tmp/ap97-v11-credit-repair.json`; final output is `/private/tmp/ap97-v11-final-repair.json`. Both runs used read-only shared dependencies. No production fixes, canonical registry edits, credentials, provider calls or live backend operations were performed by this verifier. Owner commits were replayed only in the isolated verification branch. Synthetic identities do not constitute real Auth0 acceptance. E01 changes present in integrated parent `a43852e` are outside this review; future QBO settlement export, tax integration and external practitioner sign-off remain unaccepted by V11.
