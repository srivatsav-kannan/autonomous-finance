# QuickBooks Online US sandbox — operator setup

User decision: QuickBooks Online is the external accounting system; Increase sandbox continues to execute payments. Status: selected, no account/OAuth grant yet; external sync is NOT_RUN. Engineering and contract tests continue independently. No production realm is permitted in this goal.

## Steps requiring the account owner

1. Register/sign in at [Intuit Developer](https://developer.intuit.com/) and create an app using the QuickBooks Online Accounting API. Select the accounting scope `com.intuit.quickbooks.accounting`; QuickBooks Payments scope is not required.
2. Open [sandbox companies](https://developer.intuit.com/sandbox-companies?tab=qbo). Select an existing **United States** sandbox or create a US QuickBooks Online Plus sandbox. Confirm the displayed company/realm is a sandbox. The official [sandbox FAQ](https://static.developer.intuit.com/output_html/qbo/docs/develop/sandboxes/sandbox-faqs.html) describes regional Plus/Advanced options. Record the sandbox realm ID; do not substitute a production company.
3. In the app's Development credentials / Keys & OAuth settings, obtain Client ID and Client Secret. Register the exact development redirect URI `http://localhost:8824/api/quickbooks/callback` (including scheme, host, path and case). This callback port is reserved for this AP goal; the connector service will report readiness before authorization.
4. Save values in the server-only private provider configuration, never chat, Git, screenshots or `VITE_*`: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_REALM_ID`, `QBO_ENVIRONMENT=sandbox`. Existing file: `/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env`. Tokens are stored separately with mode 0600 by the connector, not in frontend storage.
5. After the local OAuth endpoint is implemented and running, open its Connect action, sign in yourself and authorize **only the selected US sandbox**. The callback verifies one-time state and exact redirect binding before exchanging the code. Do not paste authorization codes or refresh tokens into chat. Intuit's [OAuth guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) and [official Node sample](https://github.com/IntuitDeveloper/oauth2-nodejs) describe the authorization flow.
6. Confirm company information and account/vendor mappings with the read-only readiness check. Only then run the authorized sandbox sync scenario. Required evidence: external Bill/credit/payment-accounting IDs, amounts/accounts, persisted operation keys, retry and reconciliation results. Authentication alone does not pass C4.

If sandbox creation is unavailable, record the observed provider error and stop that external step; do not create a paid/production company as a workaround. No additional account is needed for the current FakeBank or Increase work.

## Connector acceptance boundaries

- Persist the exact operation payload, local bill/journal identity, realm, API version, request ID and external response identity before/after a write. Reuse the same operation identity on retry. Intuit documents request-ID idempotency in its [API best practices](https://blogs.a.intuit.com/2018/09/10/quickbooks-online-api-best-practices/).
- QuickBooks Bill records recognize the obligation; an Increase settlement is synchronized as an accounting event after verified bank evidence. Creating a QuickBooks accounting record must not submit another bank transfer or recognize purchase cost twice.
- OAuth state expiry/replay, token rotation, revoked grants, rate limits, timeouts, duplicate responses, stale SyncToken and mapping conflicts require explicit tests. An uncertain external write is reconciled before replacement.
- Local mocks establish connector behavior only. Live sandbox reads/writes, external record reconciliation and practitioner sign-off remain separate gates.

Documentation checked 2026-10-25. Some Intuit dynamic documentation pages redirect to sign-in; official accessible samples/FAQ support these setup steps. Exact UI labels can vary.
