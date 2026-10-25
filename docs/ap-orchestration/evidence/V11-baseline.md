# V11 — frozen local settlement-dimension baseline

Independent agent engineering review at `41a1116575f98460209e4164776363a0fa4e6e50`; spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`, contract `ap-evidence-v1`. This report preserves the baseline even after repairs. No production source, canonical registry, live backend or provider was changed. The new tests use actual public AP/payment mutations, production dispatcher/evidence adapters and an isolated in-memory SQLite FakeBank. Human identities and business evidence are explicitly synthetic, not practitioner sign-off.

**Independent tests: 11/12 pass.** **Owner/architecture: 10/11 pass** (8/8 settlement tests and 2/3 architecture tests). Test TypeScript compilation passes. Exact assertion names, failure summaries and source-test hashes are in `V11-baseline-results.json`.

## Expected outcomes and passing checks

The independently fixed example recognizes 7,700 cents, creates a 3,850-cent linked credit, and selects a 3,000-cent bill portion with 1,000 cents of credit. Only **2,000 cents** may reach the bank. Cash return must reverse the same 2,000 and original department while leaving **1,000 credit consumed** and **1,000 bill paid**. A second evidence import must not duplicate journals or effects. This executes through FakeBank for both `ops` and explicit null department; each produces one transfer, one debit journal and one return journal with exact coordinates.

Snapshot and binding digests are independently recomputed with Node SHA-256 over canonical JSON. Command request hash is checked, and Increase body construction excludes the local-only binding hash. Exact request replay produces one version. Forged department, credit coverage amount and recognition-journal identity cannot obtain human authorization even when the snapshot is rehashed.

Retiring the current approving human or active policy before first send prevents dispatch with attempt count zero, no bank transfer and the original command/binding preserved. Once FakeBank accepted the transfer but its response was lost, retiring both current policy and approving human does not rewrite that obligation: recovery finds the same transfer, does not issue another create call, and posts the frozen department. Rehashing a foreign binding into that possible-send command blocks recovery and retains reservations.

A verified bank return with a changed original settlement department is refused before return effects; restoring the exact original journal permits the same retained return evidence to post. A single-credit zero-cash application retains the exact complete binding, creates no payment command, and refuses an authoritative read after its stored binding is stripped.

## V11-F1 — successive credit blocked by stale AP dimension expectation (P2)

The test `stores one exact zero-cash binding on every group member and rejects a partial changed member during grouped read` creates an invoice with policy `cost_and_settlement`, department `ops`, then two legitimate half-credit notes of 3,850 cents each. First credit succeeds. Second credit is rejected with `cost_credit_mismatch` before its intended grouped zero-cash assertions can run.

`convex/lib/apSystem/costState.ts` around lines 240–268 compares prior credit journal lines to a derived expected journal. Cost lines retain dimensions, but the expected AP debit still has only supplier and null store. The new actual AP debit correctly includes department `ops`. Thus valid history is declared corrupt, blocking subsequent credits, cost-state reads and dependent correction work. This is a capability regression with a safe rejection, not unauthorized money movement.

The issue was independently reproduced and reported before receiving notice that B had concurrently repaired it in `f760a90f05809c1fa650db53ceba9baa7a17fd13`. Repair remains unverified in this frozen report. The original failing test must pass unchanged on the additive repair.

## V11-K1 — known dependency boundary regression

Parent identified this before review. The unchanged architecture test confirms that `src/payments/contracts.ts` and `src/payments/domain/validation.ts` import `src/payments/accounting-binding.ts`, outside the permitted domain/contracts/ports dependency layer. A owns the repair. No test allowlist was changed.

## Reproduction and limits

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v11-settlement-binding.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v11-independent-baseline.json
node node_modules/vitest/vitest.mjs run tests/ap-system/settlement-dimensions.test.ts tests/ap-system/settlement-payment-binding.test.ts tests/payments/architecture.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v11-owner-baseline.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

A preliminary test expected corrupt possible-send claim to return null; the established kernel intentionally throws before mutation. That harness assertion was corrected to require `command_accounting_binding_mismatch`, preserving its no-retry/no-release checks. It is not a product finding. No baseline business assertion was weakened. Two-credit grouped zero-cash coverage remains blocked at this baseline; single-credit application passes. Future QBO export, tax integration, real sandbox and browser/practitioner acceptance remain outside V11.
