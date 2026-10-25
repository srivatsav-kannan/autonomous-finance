# Explicit operator bootstrap for the reserved Auth0 sandbox

This helper is separate from browser authentication and from payment execution. It accepts no JWT input and never impersonates a human. This checkpoint was exercised only with synthetic temporary local files, a mocked loopback HTTP transport, and `convex-test`; it did not read private provider configuration, change the real backend, contact Auth0/Increase/QBO, start services, or move money.

## Operator configuration

Use the dedicated checkout with its already running reserved Convex deployment. Load the operator-reviewed values privately into the process environment. Do not put credentials or human subjects in command arguments or chat.

Existing gateway settings required: `AP_SANDBOX_CONVEX_URL` must be `http://127.0.0.1:3252`; `AP_HUMAN_AUTH_ISSUER` must be the exact HTTPS Auth0 tenant issuer with trailing slash; `AP_HUMAN_AUTH_AUDIENCE` is the actual SPA Client ID; `AP_BANK_SCOPE` and `AP_SANDBOX_TRUSTED_CONTEXT` are the explicit Increase sandbox scope and approved supplier/coding JSON from [AUTH0-SETUP](../AUTH0-SETUP.md).

Additional explicit inputs:

| Variable | Reviewed value |
| --- | --- |
| `AP_SANDBOX_BENEFICIARY` | JSON `{vendor, externalAccountId, version}`; vendor must match trusted supplier and destination must be an Increase `external_account_…` identifier |
| `AP_BOOTSTRAP_DATE` | Valid accounting date `YYYY-MM-DD` |
| `AP_BOOTSTRAP_PERIODS` | JSON list of distinct open `YYYY-MM` periods, including the accounting date's period |
| `AP_CONTROLLER_LIMIT_CENTS` | Explicit positive safe integer cents; no automatic threshold default |
| `AP_SANDBOX_ACTIVITY_SINCE` | Explicit reviewed UTC history boundary for this account/run; no inferred history cutoff |
| `KERNEL_ADMIN_SECRET` | Optional existing private setup secret, at least 32 non-whitespace characters; otherwise generated and retained privately |
| `AP_HUMAN_SUBJECT` / `AP_HUMAN_SUBJECTS` | Required only for `bind`; exact private issuer-qualified identifier(s) from normal browser whoami or the independently reviewed Auth0 user record |

No provider API keys are required by prepare/bind. Structural validation of an Auth0 issuer/client does not prove tenant registration or real JWT verification; the normal browser/Convex test remains necessary.

## Prepare, discover identity, then bind

Deploy `apSandboxBootstrap:inspect` and existing AP/auth functions through the already owned Convex process. From the isolated checkout, with the private operator environment loaded:

```sh
node --import tsx scripts/ap-system/sandbox-bootstrap.ts prepare
node --import tsx scripts/ap-system/sandbox-bootstrap-env.ts gateway
```

`prepare` verifies `.convex/local/default/config.json` ownership, no symlink, exact cloud/site ports 3252/3253, and the responding `/instance_name` before sending a deployment credential. It reads the installed Convex environment-query protocol and sets only absent settings; a conflicting issuer, scope, admin or worker credential stops setup. It writes the exact required issuer/audience/environment configuration but does not create a run, seat, human binding, policy, supplier, case, payment, or worker. The existing Convex development process must finish deploying auth configuration before real browser validation.

Private files under `var/auth0-bootstrap/` have mode 0600 and their directory mode 0700. Generated AP, payments, controller, dispatcher, evidence, and admin credentials are distinct. `gateway.json` contains only the gateway's scoped agent credentials and explicit Auth0 allowlist. Empty legacy-human/admin/worker values deliberately prevent the existing dotenv fallback from adding a different identity or service credential. Worker files contain only their own scoped service credential. `state.json` is operator-only and retains the immutable setup intent and manual binding timestamp.

Start the separate console as in AUTH0-SETUP, and complete normal Auth0 login. Prepared gateway configuration has no approved humans, so it can display verified whoami but cannot enroll the first user. The operator then explicitly supplies the reviewed private subjects and executes:

```sh
node --import tsx scripts/ap-system/sandbox-bootstrap.ts bind
```

`bind` invokes the existing `admin:createRun` and `demoPayments:configure` once for a fresh run. Each explicit human receives a distinct human seat; no human token is issued to an agent. `apSandboxBootstrap:inspect` requires the existing kernel admin secret and returns only hashes of current run/seats/periods and immutable payment configuration. A retained matching local intent can reconcile a successful call whose reply was lost; a previously unknown run, changed configuration, changed human list, retired seat, or changed period state is rejected. No existing run configuration is rewritten. An ambiguous create with no confirmed matching run is held for operator review, not recreated automatically.

Restart only the dedicated gateway after binding so it loads the now-bound private allowlist. The subsequent browser request still needs normal Auth0 verification and current backend human-seat binding. B3 policy, independent group membership, supplier verification, invoice review and payment approval remain separate governed actions.

The launcher has separate explicit worker commands, reusing the existing worker rather than implementing another execution path:

```sh
node --import tsx scripts/ap-system/sandbox-bootstrap-env.ts evidence --once
node --import tsx scripts/ap-system/sandbox-bootstrap-env.ts dispatch --once
```

These are operator actions only after the separately authorized bank workflow is ready. Prepare, bind and gateway do not invoke them. Supply Increase credentials privately only to those worker invocations. The launcher filters inherited environment values, starts the fixed existing script, and does not accept arbitrary executable/arguments.

## Verification and limits

Result: 31/31 bootstrap/Auth0/authenticated-HTTP tests passed (including 9 bootstrap tests); all three app/backend/tests TypeScript checks and `git diff --check` passed.

Local tests cover wrong ports/instance, symlink and permission refusal, missing or foreign humans, distinct scoped secrets, no prepare enrollment, exact immutable bind replay, successful-but-lost mutation replies, pre-existing run refusal, backend configuration drift, inspection authorization, pinned environment protocol and malformed response refusal. CLI output contains only non-secret readiness or stable error codes; raw backend/validation messages are withheld.

Official basis: [Convex's Auth0 integration](https://docs.convex.dev/auth/auth0) binds the configured provider domain and SPA client ID and requires deployed auth configuration. The existing browser code performs normal login and Convex validates the resulting token. The local environment endpoint/query shape was checked against the installed Convex CLI source (`cli/lib/env.ts`) and HTTP client source (`browser/http_client.ts`). No live bootstrap success is claimed here.
