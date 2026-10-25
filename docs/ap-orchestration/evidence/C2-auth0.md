# C2 Auth0 engineering evidence

Base: integration `bf32dd8`. Branch: `codex/ap-system-auth0`. Contract: `ap-evidence-v1`; spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. This is implementation and mock-boundary evidence, not I1/D2, real Auth0, Increase or practitioner acceptance. The canonical registry was not edited.

## Implemented boundary

- Official `@auth0/auth0-spa-js` pinned to **2.29.0**, checked against the official npm registry and SDK docs before installation. SDK loaded only for external auth; tokens cached in memory. Exact callback/logout URL `http://127.0.0.1:5192/ap-system`. SDK-validated callback state can restore only a same-route case identifier.
- The AP route mounts its workspace after explicit local simulated runtime detection, or after Auth0 login and verified owner approval. Local FakeBank retains its separate service and simulated identity. Runtime failure does not infer simulated access.
- Every external protected request, including originals and page rasters, presents its ID token to a new `ConvexHttpClient.setAuth` instance. Convex verifies the token, `apIdentity:whoami` reads `ctx.auth`, and `apIdentity:workspaceAccess` rechecks the existing active scoped human binding before any agent-backed operation. There is no automatic owner enrollment or admin impersonation in the external path.
- Public Auth0 config contains domain/client ID only. The private approved subject must match both the verified token identifier and the immutable run binding. Unbound first login can see its own verified identity only.
- Subject-bound cookies retain origin/CSRF defenses. Logout aborts pending browser work, hides the workspace, revokes the current cookie when reachable, and uses SDK logout. A changed browser session cannot render a late list, detail or source response. Expiry/revocation clears access.
- Separate sandbox composition refuses missing config, backend3250 and fake/local scopes. It neither provisions a run nor calls Increase nor starts a payment worker. It composes the existing ingestion/source/accounting/payment service with the request-owned human client and configured Increase scope.
- Agreed C3/B3 seam: `APWorkspaceService.requestPayment` and `apSystemApi.preparePayment` accept optional `executionDate`, `amountCents`, `credits`, validate calendar/safe cents/distinct references and forward unchanged. `cancelPayment` uses `/cases/:caseId/payments/:versionId/cancel` with current case binding and a request-owned human mutation. Master owns the backend engine and payment UI.

## Checks

2026-10-25 local engineering run:

- `npm run typecheck` — pass.
- `npm run typecheck:backend` — pass.
- `npm run typecheck:tests` — pass.
- `npx vitest run tests/ap-system-auth.test.ts tests/ap-system-auth-http.test.ts tests/ap-system-auth-ui.test.tsx tests/ap-system-server.test.ts tests/ap-system-ui.test.tsx` — **48 tests passed**.
- `npm run build:console` — pass. The Auth0 SDK is a separate 219.01 kB chunk (61.95 kB gzip). Existing main app is 508.37 kB and still emits Vite's 500 kB chunk warning.
- `npm run design:check` — **0 FAIL, 0 WARN**, one existing answered F7.
- `git diff --check` — pass.

Tests cover required Bearer on every route, missing/expired/invalid mocked upstream identity, mismatched issuer, no first-login seat creation, scoped binding failure, unapproved identity-only access, cross-user cookies, expiry/logout/origin/CSRF, token-bearing source reads, safe callback return, stale-response invalidation, local mode and strict partial/credit/date/cancel request boundaries. Signature, JWKS, audience and expiry rejection are delegated to Convex and mocked as upstream failures here; these tests do not claim to exercise a real issuer's cryptography.

## CUA browser evidence

Only the owned UI preview **5192** and a new dedicated Chrome tab were used. Root UI5190/gateway8823/backend3250 were not changed or restarted. No backend mutations or bank calls were made. UI actions and screenshots used CUA only. The standalone rendered Hallmark/Puppeteer command was not run because the current task explicitly requires CUA for computer interactions.

The committed fixture imports the actual `APAuthStatus` component and labels itself **Synthetic Auth0 UI fixture**. Buttons only record local presentation state. Its dark selector reads the actual `tokens.css` dark declarations into the fixture; it does not change or test the OS media preference. The actual app's disconnected gateway state was also checked, including Retry connection.

| Artifact | Evidence |
| --- | --- |
| [Desktop login, light](C2-auth0/desktop-login-light.jpg) | 1280×900; single explicit sign-in action, payment authorization separation |
| [Phone login, light](C2-auth0/phone-login-light.jpg) | 400×844; readable controls and content |
| [Desktop owner pending, dark](C2-auth0/desktop-owner-pending-dark.jpg) | 1280×900; verified identity display, no case/action access |
| [Phone owner pending, dark](C2-auth0/phone-owner-pending-dark.jpg) | 400×844; identity wraps, both buttons visible with 44px targets |
| [Actual app, gateway unavailable, desktop](C2-auth0/app-unconfigured-desktop.jpg) | Real route/wrapper, neutral disconnected state, preserved navigation |
| [Actual app, gateway unavailable, phone](C2-auth0/app-unconfigured-phone.jpg) | Real mobile shell and retry state |

DOM measurements at phone width confirmed `innerWidth === documentElement.scrollWidth === 400`. Login/access buttons measured 44px tall. Fixture login click showed that no Auth0 request was sent; fixture logout hid owner details and showed the signing-out state. The real gateway-unavailable retry returned to a clear error state. All saved images contain only synthetic/public UI text.

Reproduce the fixture by starting the isolated console with the command in [AUTH0-SETUP](../AUTH0-SETUP.md), then opening `http://127.0.0.1:5192/@fs/<absolute-repo-path>/docs/ap-orchestration/evidence/C2-auth0/fixture.html`. Its HTML includes the Vite React dev preamble because `/@fs/` HTML does not receive the normal root HTML transform. Select the state and palette using the labelled fixture controls. Screenshots are JPEG bytes as returned by CUA, with matching `.jpg` extensions. The owned preview was stopped after evidence collection. CUA timed out while resetting/closing its temporary tab; tab cleanup could not be confirmed. No shared/root tab was controlled.

## Remaining acceptance

Real tenant registration/configuration and browser login have not been run. Master must deploy issuer/client-ID auth configuration and the verified identity queries on the isolated backend3252, explicitly bind the human, and validate real callback, token verification, logout/expiry and source access. Same-case external payment authorization requires the user's click after V2 and the other acceptance gates. Scheduled/partial/credit engine behavior and cancellation are covered by Master's separate C3/B3 work, not by this UI mock evidence. See [AUTH0-SETUP](../AUTH0-SETUP.md).
