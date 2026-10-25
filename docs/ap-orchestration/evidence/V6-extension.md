# V6 independent Auth0 bootstrap and grouped-credit extension

Immutable source baseline: `1cd4cc59e172a8ef1a7f9dd8f69e8a1a4764d12b`, containing Auth0 bootstrap `c135f6c` / owner `3f41c68` and grouped-credit UI/read bridge owner `1280bec`. Independent expectations were written before test execution in `V6-extension-expectations.json`. Spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

This is an independent agent engineering check. It uses synthetic temporary local configuration, in-memory Convex handlers, intercepted transport and a mounted component browser harness. No real Auth0 login, existing local backend, Increase call, QBO call, practitioner sign-off or live integration acceptance is claimed.

## Result and boundary evidence

**32 / 32 selected tests passed:** 11 new independent tests (6 bootstrap, 4 grouped-credit backend/helper, 1 mounted browser) plus 21 owner tests. No new production defect was established in this extension. Root and backend TypeScript checks pass. Full tests TypeScript on this immutable baseline reports one pre-existing owner-fixture error: `tests/ap-system-correction-ui.fixture.ts:8` lacks required `allocations[].store`. It has been reported to Master; root `2154234` contains the explicit `store:null` correction. No owner fixture was edited in this baseline.

Bootstrap checks exercised actual `bootstrapSandbox`, `apSandboxBootstrap:inspect`, `admin:createRun`, `demoPayments:configure` and workspace access against isolated Convex:

- Explicit subjects in `prepare` still create no seats and leave the gateway subject allowlist empty. A lost environment-update response reuses the saved secrets, verifies the existing environment and does not repeat its successful update.
- Canonically identical, reordered/deduplicated subject sets replay without mutations; subject removal, another issuer and another run fail before new writes. Bound humans have separate seats; an unbound mock identity has no access. Mock identities do not demonstrate real Auth0 authentication.
- A lost successful create response followed by a retired human seat causes recovery to reject the changed run without configuring or publishing gateway access. An unknown create with no observed run remains fail-closed; it requires operator reconciliation rather than blind recreation.
- A lost configure response is recovered by exact backend hashes without repeating create/configure or regenerating credentials. Gateway access stays empty until this confirmation.
- Default transport sends an unauthenticated instance read first and refuses mismatched instance/redirect responses. The deployment credential is not in that request; transport retains pinned origin and `redirect:error`.
- The actual launcher is invoked in a child process with its `spawn` intercepted before any service can start. Captured child configuration suppresses inherited administrator, dispatch, evidence, human-JWT and Increase credentials and pins the backend URL; intended private QBO configuration remains allowed. No private value is returned to the UI.

Grouped-credit checks use real `apBusiness:applyCredits` and `apAccountingCorrections:creditApplication`:

- Two independent applications use the same bill, two credits and same date, but different request keys. Their groups remain exactly 1100 and 700 cents; either component returns its own whole group, without additional credit consumption, journals, commands or correction authority.
- An inconsistent member actor, nonzero cash in the immutable receipt, or insufficient consumed credit is rejected; no trusted partial total is manufactured. Anonymous, retired-human, wrong-case, wrong-organization and wrong-funding-account reads fail.
- Exact helper sums reject partial component totals, one-cent excess, negative/zero/fractional amounts and overflow, while allowing explicit zero original-bill allocation when the full group is assigned to a restored payable.
- Mounted `APSystemCorrections` is given a synthetic 5275-cent group made of 2500 and 2775 components. Selecting the 2775 component does not make a 2775-cent allocation valid. Only 3275 original + 2000 restored passes and submits the canonical first group ID. Editing clears confirmation; snapshot refresh clears old evidence; a wrong returned receipt identity remains blocked. A late aborted wrong-bill response is ignored. Payment read would throw and no such call occurs.

The first browser harness run used an overly exact `Remedy` accessible-label selector and was interrupted rather than called a pass. It now uses the unambiguous combobox role, bounds locator waits to 10 seconds and waits for React's confirmation-invalidating effect. No financial assertion was relaxed. The earlier new test-only optional-key type inference was corrected with an explicit record-array annotation.

## Reproduction

Worktree `/Users/junjiexiong/.codex/worktrees/ap-system-verification/calhacks`:

```
node node_modules/vitest/vitest.mjs run tests/ap-system/v6-bootstrap.test.ts tests/ap-system/sandbox-bootstrap.test.ts tests/ap-system/v6-credit*test* tests/ap-system/credit-application-read.test.ts tests/ap-system-correction-ui.test.tsx tests/ap-system-correction-transport.test.ts --cache=false --configLoader native --reporter=json --outputFile=/private/tmp/ap97-v6-extension.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tests.json
```

Sanitized test identities and content hashes are in `V6-extension-results.json`. The browser runs headless Chrome with a temporary Vite port and cache under `/private/tmp`, closed/removed in `finally`; the launcher capture intercepts spawn and starts no server. Existing service ports, provider credentials, protected Desktop checkout and canonical registry were not touched.
