# Increase sandbox AP contract

This fixture set supports issue #39: one USD account and outbound ACH credits. It is **contract evidence**, not a recording of successful provider execution. The runtime adapter is `src/integrations/banking/increase.ts`; simulation controls live separately in `scripts/testing/increase-sandbox-harness.ts`.

## Pin and provenance

`provenance.json` records the exact upstream SHA-256, generated subset SHA-256 and fixture SHA-256. The upstream is Increase's published [OpenAPI 3.0 specification](https://increase.com/openapi_3_0.json), retrieved 2026-10-23. Its declared version is `0.0.1`, so the content hash is the meaningful pin. `openapi.json` selects the endpoints used here and their transitive component references, preserving constraints and required fields. The extraction strips documentation prose/extensions and restores required response descriptions; it does not fabricate a provider API version header.

To review an upstream refresh deliberately:

```sh
curl --fail --silent --show-error https://increase.com/openapi_3_0.json -o /tmp/increase-upstream.json
node scripts/testing/pin-increase-spec.mjs /tmp/increase-upstream.json
npx vitest run src/integrations/banking/increase.test.ts src/integrations/banking/increase-prism.test.ts
```

Review the schema and hash diff before committing a refresh. The tests verify the pinned files' hashes. Fixtures are synthetic examples adapted from the upstream examples; they contain no credentials or customer account details.

## Reproducible contract checks

Use Node **24.18.0 or newer**, as required by Prism 5.16.0. From the repository root:

```sh
npm ci
npx vitest run src/integrations/banking/increase.test.ts src/integrations/banking/increase-prism.test.ts
npm run typecheck
```

The Prism suite starts a local fixture HTTP server and the pinned `@stoplight/prism-cli` 5.16.0 validating proxy on ephemeral loopback ports. Real adapter requests traverse that proxy. The suite checks successful request/response schemas, malformed outgoing requests, malformed incoming responses, and the documented rate-limit error. It makes no Increase network calls. A missing Prism dependency fails the suite instead of silently skipping it.

The adapter suite checks saved-request replay, lost responses and fresh worker instances, request hashes, cross-account/environment/organization/run denial, private credentials, HTTP error classification, raw signed notification integrity and freshness, distinct return evidence, unmatched activity, missing provider evidence, and pagination. Full application authorization, accounting atomicity and worker lease recovery are covered by the AP backend/demo suites.

### Development dependency audit

The lockfile pins Prism 5.16.0. Scoped `postman-collection` overrides select patched `lodash` 4.18.1 and CommonJS-compatible `uuid` 11.1.1; the real Prism proxy tests pass with those overrides. On 2026-10-24, `npm audit --omit=dev` reports **zero vulnerabilities**. Full `npm audit` still reports **six high findings arising from one advisory**, [GHSA-qxc2-j82w-r537](https://github.com/advisories/GHSA-qxc2-j82w-r537), in the development-only chain:

```text
@stoplight/prism-cli@5.16.0
  -> @stoplight/prism-http@5.16.0
    -> @stoplight/http-spec@7.1.0
      -> postman-collection@4.5.0
        -> @faker-js/faker@5.5.3
```

The sixth finding is propagated through `@stoplight/prism-http-server`. Postman's legacy Faker API is incompatible with the patched Faker 10.5+ release, so an override to that major version would break its parser. Even current Postman Collection 5.3.1 retains Faker 5.5.3. These tests pass only the checked-in OpenAPI subset to Prism and never load a Postman collection; this limits the test exposure but does not resolve the advisory. Keep this development tool out of production installs (`npm ci --omit=dev`) and revisit when the upstream parser removes or updates the legacy dependency. The remaining full-audit failure is an explicit toolchain blocker, separate from passing application and contract tests.

Reproduce the audit independently with `npm audit --omit=dev` and `npm audit`. Do not use `npm audit fix --force` to replace this with an incompatible package tree.

## Saved request and provider evidence

T2 must save the exact `providerRequest` string built from the approved command before calculating `requestHash` and queueing it. Both the string and stable `idempotencyKey` survive retries and worker restarts. The adapter validates those original bytes against the immutable command, then transmits them verbatim. Missing saved bodies pause for explicit migration; changed bodies quarantine. No list-by-key recovery or made-up expiry window is used. See [Increase idempotency](https://increase.com/documentation/idempotency-keys).

A `submitted` status by itself is pending evidence. The adapter reports settlement only when `settlement.settled_at` exists and a separately fetched posted Transaction matches the account, transfer, currency, negative principal and original transaction ID. Returns require both distinct transactions; a return seen first still fetches the original debit. See [ACH settlement lifecycle](https://increase.com/documentation/sending-ach-transfers).

The adapter uses only `https://sandbox.increase.com` and rejects redirects. Provider credentials are private fields. The ordinary provider exposes no simulation APIs. The harness verifies transfer account ownership before its narrowly defined simulation operations. Agent tooling receives neither object.

## Notifications and polling

`verifyIncreaseWebhook` authenticates the original bytes, message ID, timestamp and HMAC-SHA256 signature before JSON parsing. It binds the authenticated notification to the server-configured sandbox subscription scope. Increase events have no account ID, so that initial scope is the subscription expectation: the evidence worker must retrieve the referenced transfer or Transaction and confirm the account before effects. An event is only a hint; it cannot establish cash movement. Ingress persists the hint before HTTP success.

The signature implementation follows Increase's documented manual algorithm: the configured endpoint signing secret is used directly as the HMAC key. It checks the signed header ID equals the parsed event ID, accepts a valid signature during rotation, and rejects timestamps outside five minutes. See [Increase webhook verification and polling](https://increase.com/documentation/webhooks).

Events are polled in ascending creation order and retain the provider's tail cursor, including on an empty page. The adapter also supports full account Transaction scans, preserving unmatched activity as a close blocker. Transaction listings have no incremental tail cursor: at the end of a scan the saved cursor resets to null, so the next poll scans again with backend economic-event deduplication. This favors correctness for the single-account demo; a large production account would need bounded overlapping statement windows. Transaction scans also cover outages beyond the provider's 30-day event retention. Failed sandbox webhook delivery is not retried by Increase.

## Real sandbox profile

Sandbox activity is a separate result. The existing account must be funded in sandbox, with an approved External Account configured as the beneficiary. Supply secrets through the operator's environment, never through an agent tool or checked-in file:

- `INCREASE_SANDBOX_API_KEY`: sandbox-only API credential.
- `INCREASE_SANDBOX_ACCOUNT_ID`: the single source account.
- `INCREASE_SANDBOX_EXTERNAL_ACCOUNT_ID`: the independently approved receiver.
- `INCREASE_SANDBOX_WEBHOOK_SECRET`: subscription signing secret when exercising notification delivery; polling does not require it.
- `AP_ORGANIZATION_ID` / `AP_RUN_ID`: explicit application scope, with isolated Convex credentials configured as described by the AP demo documentation.

Check readiness without printing credentials:

```sh
npx tsx -e 'import {sandboxConfiguration} from "./scripts/testing/increase-sandbox-harness.ts"; const r = sandboxConfiguration(); console.log(JSON.stringify(r.status === "not_run" ? r : {status:"ready"}));'
```

Missing key/account/beneficiary prints `status: "not_run"` with missing variable names. It does not mean the provider contract or real ACH lifecycle passed. The AP demo runner uses the same dispatcher and evidence worker with this adapter; the operator harness supplies `submit`, `settle` and `return` controls outside agent capabilities. See [Increase sandbox documentation](https://increase.com/documentation/sandbox) for test-account setup and funding.
