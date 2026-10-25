# Payment browser smoke — issue #59

The browser journey is `/ap-demo` → signed human JWT → scoped Convex payment
commands → persistent SQLite FakeBank → evidence worker → settled payment and
visible bank transaction/journal link. It uses the canonical `scoped-ap-v2`
executor. It never imports an Increase adapter or invokes a paid model.

## Local command

Requirements: the repository's supported Node version, `npm ci`, an unconfigured
Convex user (no `~/.convex/config.json` or legacy `anonymous-agent` deployment),
and Playwright Chromium. The coordinator owns package/lock/workflow changes;
the required pinned development dependency is `@playwright/test@1.64.1`.

```sh
npx playwright install --with-deps chromium
node scripts/testing/payment-browser-local.mjs
# Package alias after integration: npm run test:browser:local
```

The runner copies only source inputs into a fresh private temporary directory,
starts pinned Convex `precompiled-2026-10-10-72ce13c` with fresh available cloud
and site ports, checks its instance name, builds the console and serves the build
on another loopback port. It does not reuse or modify the checkout's `.env`,
Convex state, existing bank database, or another checkout. Concurrent port races
fail the run; they cannot silently attach it to another backend. Local runs need
network access for uncached Convex/Chromium downloads, but no production secrets.

Only the temporary copied `convex/auth.config.ts` is replaced with a test-only
Custom JWT provider. An ephemeral RSA key signs ten-minute human and unbound
subject JWTs. Convex verifies their signatures against an inline **public** JWKS,
including issuer/audience. This uses Convex's supported
[Custom JWT data-URI configuration](https://docs.convex.dev/auth/advanced/custom-jwt).
The production OIDC configuration stays unchanged. This proves signed test-issuer
JWT verification and the application's human-seat authorization; it does **not**
prove an external identity provider's login, token delivery, or deployment setup.

The private signing key remains in the runner's memory. The backend admin key
stays in the runner/local CLI state; it is never passed to Playwright or the
browser. Generated application/service credentials and human JWTs live in a
mode-0600 temporary fixture consumed by the Node test process, removed during
cleanup. The browser receives only the human JWT via its password field and
Convex Authorization header, held in memory. No storage state, cookies, browser
localStorage, or sessionStorage are used for credentials. Ordinary agent handles
receive only their own scope/seat/token, never bank or simulator authority.

## Assertions

`tests/browser/payment-journey.pw.ts` is selected explicitly by
`playwright.payment.config.ts`; the `.pw.ts` suffix keeps Vitest from collecting it.
The three tests run serially, once, with no retries and an isolated browser
context per test:

1. The built console loads its human-only login and starts with empty credential
   storage and no JavaScript errors.
2. Missing identity cannot query or approve. Invalid JWT, validly signed unbound
   subject, and a bound human with the wrong account are rejected. The rejected
   operations create no command or bank transfer.
3. The human reviews invoice `1001` (the canonical identity of seeded `INV-1001`),
   amount $662.90, exact snapshot/hash, beneficiary and policy. Approval is disabled
   until the checkbox is checked. The **browser** records the human approval and
   queues the effect through the real backend. Node then runs the real dispatcher.
   Accepted/pending leaves paid cents at zero, reserves the bill and creates no
   settlement entry. Settling FakeBank alone still leaves the application pending.
   Only polling verified bank evidence posts one debit and settles the payment.
   A second evidence pass posts nothing. Frozen command/key/request stay equal.
   The UI displays settled/posted/matched, transaction ID, transfer, journal link,
   operation key and request hash. Disconnect/reload requires login again.

No page response is mocked, intercepted, or fulfilled by the tests. The journey
counts real requests to the configured Convex target and fails on page errors or
failed requests. Local completion also reads the persisted `journalEntries` table
through the CLI and asserts exactly one payment settlement with the matching cash
credit. Staging checks the evidence's journal link; it does not claim an independent
raw-journal read. Worker crash/restart and broader accounting cases remain the
separate recovery suite's responsibility.

## Artifacts, failures and cleanup

Only upload these bounded, allowlisted JSON files:

```text
var/ci/payment-browser-local/summary.json
var/ci/payment-browser-local/playwright.json
var/ci/payment-browser-local/proof.json
```

Staging uses the same filenames under `var/ci/payment-browser-staging/`.
`summary.json` records source revision, dirty/untracked-source indicators, Node,
backend pin, identity mode, gate status, and runner phase. `playwright.json`
contains scenario names, status, timings and failure source line numbers, capped
at ten results. `proof.json` contains the last journey phase, synthetic scope,
state/count assertions and browser error counts. A failure before Playwright
starts has only the summary. Previous reports are removed before each run.

Raw subprocess output, assertion values, DOM dumps, private fixture files, SQLite
databases, screenshots, videos, traces, HTML reports and network headers are not
artifacts. In particular Playwright traces would capture `fill()` JWT arguments
and are disabled. Diagnostics are categorical and bounded; use the phase and
source line to reproduce locally. Do not enable raw tracing in credentialed CI.

An assertion, child failure, missing required proof, interruption or timeout
returns nonzero. The runner has a six-minute outer limit; Playwright has a
three-minute suite limit and one-minute per-test limit. It terminates only process
groups it created and removes the temporary project, credentials and bank files.
The required CI check must treat non-execution as a failure. Datadog is deferred.

## Opt-in staging deployment gate

No staging URL, deployed fixture credentials or external IdP fixture were supplied
for this task. The observed staging result is **NOT_RUN**, exit **2**. Local success
must not be presented as a staging promotion check.

The same suite is available without deploying anything:

```sh
PAYMENT_BROWSER_ALLOW_STAGING=isolated-fake-only \
PAYMENT_BROWSER_STAGING_FIXTURE=/absolute/private/path/fixture.json \
node scripts/testing/payment-browser-staging.mjs
# Package alias after integration: npm run test:browser:staging
```

The manifest must be mode 0600 and contain:

```json
{
  "targetEnvironment": "staging",
  "targetRevision": "40-lowercase-hex-characters-for-the-deployed-revision",
  "consoleUrl": "https://isolated-staging-console.example",
  "convexUrl": "https://isolated-staging-backend.example",
  "scope": {
    "organizationId": "payment-browser-smoke",
    "runId": "payment-browser-<fresh UUID>",
    "provider": "fake",
    "environment": "local",
    "accountId": "payment-browser-account-<same UUID>"
  },
  "humanSubject": "https://test-issuer.example|browser-human",
  "humanJwt": "<signed, unexpired human JWT>",
  "unauthorizedJwt": "<valid same-issuer JWT for an unbound subject>",
  "kernelAdminSecret": "<staging-only secret>",
  "dispatcherToken": "<distinct staging-only dispatcher secret>",
  "evidenceToken": "<distinct staging-only evidence secret>"
}
```

Provision the isolated staging backend first with `KERNEL_ADMIN_SECRET`,
`AP_DISPATCH_SECRET`, `AP_EVIDENCE_SECRET`, and `AP_BANK_SCOPE` matching this manifest,
and an auth provider accepting these two JWTs. Build the console with
`VITE_CONVEX_URL` pointing at that backend. The fresh run/account must be dedicated
to this invocation, with no other dispatcher or evidence worker running. No
deployment admin key goes in this manifest. Credentials must never be supplied
through URL query parameters or committed files.

The runner creates the fresh run, binds its human CFO, configures the fixed fake
beneficiary/policy and seeds the deterministic invoice through real APIs. It
verifies service scope binding before browser approval. It always opens its own
SQLite FakeBank in a private temporary path. Any non-`fake/local` scope, incorrect
organization/run/account pairing, non-HTTPS staging origin, missing opt-in, reused
configured run, wrong service binding or identity failure blocks the gate.

Missing opt-in/manifest is `NOT_RUN` with exit 2; malformed configuration or a
failed executed check is `FAILED` with exit 1. A deployment caller may promote only
after exit 0. That caller owns staging deployment and provisioning; this command
does neither and must not be pointed at production. Backend run history remains
available for review and is never reset by the smoke runner. A subsequent run needs
a fresh UUID and corresponding backend scope binding. `targetRevision` is recorded
as operator-supplied, not independently attested by this console. Supply the actual
deployed revision in the deployment workflow.

The coordinator-owned `.github/workflows/payment-staging-smoke.yml` exposes this
as a reusable or manually dispatched check, using `target_revision` and secret
`PAYMENT_BROWSER_STAGING_FIXTURE_JSON`. It checks the manifest revision against the
caller input, writes the manifest to a private runner-temp file, and removes that
file afterwards. A promotion workflow must explicitly depend on the successful
reusable smoke job via `needs`; creating this check alone does not gate an existing
promotion pipeline. No deployment action is included.

## Recorded local evidence

The local suite was executed on baseline `794a10e` plus this browser lane. All three
tests passed: one $662.90 transfer, zero paid cents while pending, one posted debit
and one persisted settlement journal entry with a visible link after verification,
zero additional posting on replay,
nine real browser/backend requests, zero page/network failures, and no stored
browser credentials. The clean committed rerun and full revision are recorded in
the handoff and generated summary. External IdP, staging, live Increase and external
webhook validation remain separate and are not claimed by this local test.
