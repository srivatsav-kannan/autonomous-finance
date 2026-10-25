# Auth0 development tenant for the AP sandbox

This is the C2 browser-login engineering path. Real Auth0 login, Increase funding, transfers, external-workflow acceptance and practitioner review remain separate acceptance steps. Local FakeBank remains on its existing simulated runtime. No JWT needs to be pasted into chat, a terminal, or a form.

## Register the application

1. Create an Auth0 development tenant. In **Applications → Applications → Create Application**, choose **Single Page Web Applications** and name it for this AP sandbox.
2. In its Settings, save these exact values (do not substitute `localhost`):

   | Auth0 setting | Value |
   | --- | --- |
   | Allowed Callback URLs | `http://127.0.0.1:5192/ap-system` |
   | Allowed Logout URLs | `http://127.0.0.1:5192/ap-system` |
   | Allowed Web Origins | `http://127.0.0.1:5192` |
   | Allowed Origins (CORS), if configured | `http://127.0.0.1:5192` |

3. Under **Show Advanced Settings → OAuth**, confirm **RS256** signing and **OIDC Conformant**. Use a database or social connection enabled for this application; sign up or create the intended human account through Auth0. Do not use a machine-to-machine application or share its client secret with the browser.
4. Copy the application's **Domain** and **Client ID**. The issuer is `https://<Domain>/`, including the trailing slash. This implementation accepts Auth0 tenant domains ending in `.auth0.com`; custom domains are outside this bounded setup.

The application type, RS256 setting and URL configuration follow [Auth0's Vite/React setup](https://auth0.com/blog/adding-google-login-to-react-app-with-auth0/). Auth0 [requires exact callback matching](https://support.auth0.com/center/s/article/Callback-URL-Mismatch-Error-Is-Not-in-the-List-of-Allowed-Callback-URLs).

## Prepare the isolated backend and private configuration

The reserved endpoints are UI **5192**, AP gateway **8825**, Convex cloud **3252** and Convex site **3253**. Do not reuse or restart the existing FakeBank backend 3250/3251 or integration UI/gateway 5190/8823. Master provisions the isolated backend and explicit run/agent seats using the existing trusted setup workflow. This new server does not provision a run, create roles, change deployment configuration, or call Increase.

On that isolated Convex deployment, set `AP_HUMAN_AUTH_ISSUER` to the exact HTTPS issuer and `AP_HUMAN_AUTH_AUDIENCE` to the SPA **Client ID**, then deploy the existing `convex/auth.config.ts` plus `apIdentity.ts` and the AP functions. The provider's `applicationID` is this SPA client ID. The installed official Convex Auth0 provider obtains `getAccessTokenSilently({ detailedResponse: true }).id_token`; the AP browser uses the SPA SDK equivalent. Convex performs token signature, issuer, audience and expiration validation before `ctx.auth` returns the identity. See [Convex's Auth0 integration](https://docs.convex.dev/auth/auth0).

Keep these gateway settings in an ignored private environment file or private process environment. Do not commit credentials or copy them into chat. Non-secret domain and client ID are the only Auth0 fields returned by the public `/runtime` endpoint.

| Environment variable | Required value |
| --- | --- |
| `AP_HUMAN_AUTH_ISSUER` | Exact `https://<tenant>.auth0.com/` issuer |
| `AP_HUMAN_AUTH_AUDIENCE` | Auth0 SPA Client ID |
| `AP_SANDBOX_CONVEX_URL` | `http://127.0.0.1:3252` |
| `AP_BANK_SCOPE` | JSON with explicit `organizationId`, owned `ap97-…` `runId`, `provider:"increase"`, `environment:"sandbox"`, and the configured Increase sandbox `accountId` |
| `AP_SANDBOX_AP_SEAT_ID`, `AP_SANDBOX_AP_SEAT_TOKEN` | Existing scoped AP agent seat and private credential |
| `AP_SANDBOX_PAYMENTS_SEAT_ID`, `AP_SANDBOX_PAYMENTS_SEAT_TOKEN` | Separate existing scoped payments preparation seat and credential |
| `AP_SANDBOX_TRUSTED_CONTEXT` | JSON supplier and coding context shown below; explicitly reviewed for this run |
| `AP_HUMAN_SUBJECT` | Omit for first identity display; backward-compatible single approved `tokenIdentifier` |
| `AP_HUMAN_SUBJECTS` | Optional private JSON array of explicit approved `tokenIdentifier` strings for independent B3 approvers; no automatic enrollment |
| `LLAMA_CLOUD_API_KEY` | Private parser key for PDF/image ingestion; absence is reported in readiness and parsing fails honestly. XML does not use LlamaParse. |

Trusted context shape (fill the actual reviewed supplier/coding; these are placeholders, not seeded values):

```json
{"supplier":{"supplierId":"<approved supplier ID>","legalName":"<approved legal name>"},"coding":{"account":"<approved GL account>","store":null,"department":null,"project":null,"treatment":"expense"}}
```

The gateway needs no Increase API key and does not run the dispatcher. Increase credentials, scoped dispatcher/evidence secrets, beneficiary, policy and account validation belong to the separately configured workers and immutable backend run configuration. Do not use the legacy `demo:sandbox` manual-token flow for this login path.

With private configuration loaded and the isolated backend deployed:

```sh
npx tsx scripts/ap-system/sandbox-server.ts
```

Start the independent console in another terminal:

```sh
AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8825 VITE_CONVEX_URL='' npm run console -- --port 5192 --strictPort
```

Required config is validated before opening the gateway or writing source files. It refuses backend 3250, fake/local scopes, absent account bindings and missing or shared agent credentials. Original bytes and intake receipts are kept under the ignored private `var/auth0-sandbox/<runId>/` directory. The HTTP runtime response contains readiness flags, not the account, subject, agent credentials or storage paths.

## Sign in and explicitly bind the human

1. Open `http://127.0.0.1:5192/ap-system` and click **Sign in with Auth0**. Complete the normal Auth0 login. The official SDK performs redirect/state/PKCE handling and holds tokens in memory (`cacheLocation:"memory"`, refresh-token persistence disabled). No application code signs, parses, or asks for JWTs. The SDK's temporary redirect transaction state is separate from the token cache. [Auth0 SPA SDK](https://auth0.com/docs/libraries/auth0-single-page-app-sdk).
2. Before owner binding, the page shows **Your account needs workspace access** and the verified `tokenIdentifier`. The identity query reads only `ctx.auth`; it creates no role or seat. Give that identifier privately to the workspace owner. Alternatively, the owner can take the Auth0 Dashboard User ID and construct `<issuer>|<User ID>` (an Auth0 database User ID may itself contain `auth0|`).
3. For one approver use `AP_HUMAN_SUBJECT`. For multiple independent B3 approvers use `AP_HUMAN_SUBJECTS` containing the exact identifiers as a JSON string array. If both are configured, their explicit entries are combined. The list accepts at most 100 entries from the configured issuer, and grants no backend roles. Master explicitly binds each intended identifier to the intended active `human_cfo` seat in the fresh run's immutable `humanSubjects` configuration, with the reviewed Increase account/beneficiary and policy, and includes the same identifier in the gateway's private allowlist. Each identity also needs its existing active allowed human seat and explicit policy-group membership. There is no first-user enrollment. If immutable run configuration is already wrong, prepare a fresh isolated run instead of silently broadening access.
4. Restart only this sandbox gateway after changing its private owner setting, then click **Check access again** or sign in again. Every AP request checks both the verified identity and the current scoped human binding. A second user cannot reuse the first user's cookie. The original files and rendered pages require the same Bearer identity and subject-bound cookie as case data.
5. Upload/review the intended case and approve the bill separately. Prepare and inspect its payment proposal: gross obligation, any credits, net cash, funding account, beneficiary and intended initiation date. Only the human's explicit **Authorize this payment** action authorizes the exact immutable payment snapshot. Signing in, field review and bill approval do not authorize a payment.
6. Master continues the external sandbox funding/worker/settlement workflow only after its remaining gates. A scheduled date is the intended UTC initiation date, not a guaranteed settlement date. To reschedule an eligible never-sent proposal, cancel it and prepare/authorize a fresh snapshot; a possibly sent payment must reconcile rather than be canceled locally.

**Sign out** immediately hides case data and aborts old browser requests, revokes the subject-bound gateway cookie when possible, and uses the SDK's Auth0 logout redirect. Token renewal/expiry is handled by the SDK; any verification failure or owner revocation hides the workspace. Silent sign-in may be restricted by browser cookie settings; the explicit redirect button remains available. Tokens never appear in URLs or download links and are forwarded only to the same-origin AP gateway and its request-owned Convex client. Gateway redirects are rejected.

## Acceptance still required

The automated suite uses explicit mocks and `convex-test` identities; it does not prove a real Auth0 signature, JWKS retrieval, real tenant audience/expiry behavior or bank execution. Before external acceptance, use the actual configured tenant to check login/callback/logout, approved and unapproved accounts, cold direct-link loading, expired/wrong-issuer/wrong-audience token rejection by Convex, original/raster access and a user-click authorization of the same case. Keep tokens private throughout. Record actual bank observations separately from C2 UI/transport evidence.

For governed policy proposals, optionally configure distinct `AP_SANDBOX_CONTROLLER_SEAT_ID` and `AP_SANDBOX_CONTROLLER_SEAT_TOKEN` values privately for an existing scoped controller agent. Both are required together and must differ from AP and payments credentials. Their absence disables policy proposal without disabling human reads or existing approved case operations. No role, seat or allowlist entry is created automatically.
