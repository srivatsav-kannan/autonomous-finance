# Independent Increase sandbox identifier compatibility check

Patch: `47f81c3b94b2e9989239e5e515048417d2648dc5`; isolated verification code: `0991683322c0a8e44ff8f9785d4c164ed256de01`. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

**No actionable defect found in this bounded check. 54/54 PASS = 5 independent + 49 selected owner tests.** Counts are separate from the timing and parser reviews. This verifies code with synthetic local transport; it does not independently confirm a live provider account or execute a real payment.

The patch admits an optional literal `sandbox_` prefix for the exact account, external-account, transfer, transaction and webhook event kinds. It preserves original IDs rather than stripping the prefix. Origin remains fixed to `https://sandbox.increase.com`, redirects remain errors, command/body hashes remain immutable, scoped resource IDs must match returned IDs exactly, and settlement/return still require corroborating distinct economic transactions.

Independent tests cover:

- Sandbox debit/return success followed by account prefix stripping, linked transfer prefix stripping, response ID prefix stripping and wrong-signed credit. Each inconsistent return fails closed; every transport request in this case is GET.
- A prefix-stripped command account and altered saved beneficiary request are refused before transport, even when their command hashes are recomputed.
- Empty IDs, slash/query/fragment/encoded-slash/backslash/control-character suffixes, repeated prefixes and wrong resource kinds cannot reach transport.
- The operator simulation harness must first fetch the exact transfer under the exact account. A prefix-stripped foreign account cannot trigger simulation; valid simulation stays at the pinned sandbox origin. Production scope is rejected.
- Webhook signatures bind exact event ID and body. A newly signed unprefixed header paired with the prefixed body is rejected, as are expired timestamps and production scope.

```sh
node node_modules/vitest/vitest.mjs run tests/ap-system/v7-increase-identities.test.ts src/integrations/banking/increase.test.ts tests/ap-system/sandbox-bootstrap.test.ts --cache=false --configLoader native --maxWorkers=1 --reporter=json --outputFile=/private/tmp/ap97-v7-increase.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

All three typechecks pass. `scripts/ap-demo.ts` funding-ID acceptance was reviewed statically, not run against a bank. Exact identities and result hashes are in `V7-followup-results.json`. No actual API keys were read, no real provider calls were made, and no claim of live payment, real Auth0 login or practitioner sign-off is made.
