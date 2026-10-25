# QuickBooks Online US sandbox — runnable C4 operator setup

Status on 2026-10-25: connector and independent protocol/backend tests are implemented. The operator has configured Development credentials and selected a US sandbox privately; configuration presence is not proof of valid credentials or consent. Master reached the real company consent page, with the owner’s Connect action still pending at this checkpoint. Live OAuth completion, company reads, Bill/VendorCredit/BillPayment writes and external reconciliation remain separately evidenced acceptance steps. Mock success is not sandbox acceptance. Increase sandbox remains the payment rail; this connector only records accounting after independent settlement evidence.

## 1. Register and select the sandbox

1. Sign in or register at [Intuit Developer](https://developer.intuit.com/), create an application for the **QuickBooks Online Accounting API**. Request only `com.intuit.quickbooks.accounting`.
2. Open [sandbox companies](https://developer.intuit.com/sandbox-companies?tab=qbo) and create/select a **United States** QuickBooks Online sandbox. Confirm the sandbox label and realm ID. The official [sandbox FAQ](https://static.developer.intuit.com/output_html/qbo/docs/develop/sandboxes/sandbox-faqs.html) describes regional sandbox options. Do not substitute a paid/production company.
3. In the app's **Development** credentials/Keys & OAuth settings, register exactly `http://localhost:8824/api/quickbooks/callback`. Copy Development Client ID/Secret into your private server configuration, never chat, Git, `VITE_*`, browser storage or screenshots.

The current operator-owned provider file is `/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env`. Add privately:

```dotenv
QBO_ENVIRONMENT=sandbox
QBO_CLIENT_ID=<Development client ID>
QBO_CLIENT_SECRET=<Development client secret>
QBO_REALM_ID=<selected US sandbox realm ID>
QBO_REDIRECT_URI=http://localhost:8824/api/quickbooks/callback
QBO_PRIVATE_DIR=/absolute/private/path/to/quickbooks-state
```

Choose a dedicated directory outside tracked source. It must be owned by the current user, mode 0700; the connector creates new directories as 0700 and files as 0600. Existing permissive directories/files are rejected. Tokens and sync journal are separate files. Keep and back up this private directory: losing it loses local operation receipts and requires reconciliation before any replacement write.

## 2. Run the callback and grant consent

From the integration checkout, after dependencies are installed:

```sh
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-callback.ts
```

Open `http://localhost:8824/`, select **Connect sandbox**, then **Continue to Intuit authorization**, sign in yourself and grant the selected company access. The callback listens only on 127.0.0.1:8824; Host, Origin, session cookie, CSRF token and one-time OAuth state are checked. Use `localhost` in the browser, matching the registered redirect exactly. State lasts ten minutes. The callback consumes state before exchanging the code and checks the configured realm. It redirects away from callback query parameters; no third-party assets or code/token logging are used.

The requested scope is accounting only. Access tokens are refreshed from the most recently saved refresh token. Rotation is serialized across processes and persisted atomically with fsync. A crash/timeout during rotation blocks reuse and requires a new normal grant. Revoked/expired grants also require reconnection. This conservative policy avoids guessing whether a refresh token was consumed. A stale lock is not automatically stolen: stop all connector processes, verify the recorded operation/token status, and remove only the corresponding lock directory after confirming no process owns it.

OAuth protocol references: [official Intuit OAuth guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0), [official OAuth Node SDK](https://github.com/intuit/oauth-jsclient), [official SDK release notes](https://github.com/intuit/oauth-jsclient/releases). Runtime uses the documented endpoints directly; no new SDK dependency is installed.

## 3. Inspect and explicitly map the company

```sh
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts inspect
```

This is read-only. It lists company name/country and selected vendor/account fields (maximum 1,000 of each; `complete:false` requires operator investigation). Confirm the realm is the intended US sandbox. Account and vendor IDs must be explicitly selected; the connector never creates or fuzzy-matches them.

Save a private mappings JSON file. Replace every placeholder with the actual ID/name/type returned by `inspect`; placeholders deliberately fail validation:

```json
{
  "version": "operator-reviewed-2026-10-25",
  "realmId": "REPLACE_REALM_ID",
  "country": "US",
  "vendors": {
    "golden-state-produce": {"id": "REPLACE_VENDOR_ID", "displayName": "REPLACE_EXACT_DISPLAY_NAME"}
  },
  "accounts": {
    "2000": {"id": "REPLACE_AP_ID", "name": "REPLACE_EXACT_AP_NAME", "type": "Accounts Payable"},
    "1000": {"id": "REPLACE_BANK_ID", "name": "REPLACE_EXACT_BANK_NAME", "type": "Bank"},
    "5000": {"id": "REPLACE_COST_ID", "name": "REPLACE_EXACT_COST_NAME", "type": "Expense"}
  },
  "apAccount": "2000",
  "bankAccount": "1000"
}
```

Include every local recognition account. The local first-wave AP/cash accounts are 2000/1000. Account-based lines carry the approved gross allocations, including explicitly allocated tax; the connector does not ask QuickBooks to calculate an additional tax charge. QBO class/project/inventory-item/tax-engine mapping is not implemented. Local treatment/dimensions remain in the authoritative recognition record; these mappings must be reviewed before expanding beyond this account-based USD profile.

```sh
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts mapping-check --mappings /private/path/mappings.json
```

This verifies US company, active vendor/account identity, exact names, account types and USD currency where supplied. No accounting writes occur. One local account cannot silently map to the same external account as another. Mapping changes after an operation is frozen produce an immutable-operation conflict.

## 4. Use the AP browser workspace

The preferred user path is normal Auth0 browser login, described in [AUTH0-SETUP](AUTH0-SETUP.md). No manual JWT is required. The AP gateway creates a new human Convex client for each authenticated request and injects it into `createQBOBridge(human, scope)`; current case exports are loaded through that verified identity. Agent credentials, OAuth grants and mappings remain server-only.

After the owner completes the company consent and mapping steps above, save the reviewed mapping as `mappings.json` in the configured private QuickBooks directory. Start the isolated AP gateway with the same private QBO configuration. Open the case's **Accounting → QuickBooks accounting sync** panel. Inspect configuration, company authorization and mapping readiness. Select bill recognition or an already verified settlement, then **Preview accounting plan**. Check the exact amount, vendor/account mappings, company and linked records. The preview makes no external writes.

Check the explicit approval box and choose **Submit reviewed accounting plan** only for that intended sandbox record. The gateway re-derives and compares the exact preview hash before submission. Successful external IDs come from saved provider receipts; they are not inferred from local settlement. Use **Verify external record** to compare the receipt with QuickBooks. Unknown/conflict states require inspection before retrying. Local FakeBank can preview only with explicitly configured private mappings; external submission and verification are disabled there. Accounting setup failure does not authorize or block the independent bank execution path.

## 5. Optional advanced CLI and synthetic dry-run

A saved synthetic export can be used without credentials for a dry-run:

```sh
node --import tsx scripts/ap-system/quickbooks-cli.ts dry-run --input /private/path/synthetic-export.json --mappings /private/path/mappings.json
```

This only validates and prints a proposed Bill. It is not evidence that a saved JSON file is authoritative. **Submit rejects `--input`.** Real writes load current facts through the authenticated `apAccountingExport:current` Convex query; its `requirePaymentHuman` + account scope checks cannot be replaced by caller booleans. Deploy that query through the normal integration deployment before using the CLI; this workstream does not deploy it.

For advanced standalone authenticated CLI use only, configure private `QBO_CONVEX_URL`, exact `AP_BANK_SCOPE` JSON and a short-lived `QBO_AUTH_TOKEN` issued by the application's normal human sign-in tooling. Do not paste tokens in chat or command arguments. The normal browser path above needs no `QBO_AUTH_TOKEN`. Never ask an operator to paste a JWT into chat or a browser form.

```sh
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts submit --case CASE_ID --mappings /private/path/mappings.json
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts verify --case CASE_ID --mappings /private/path/mappings.json
```

Bill submission requires a fresh authenticated export from an Increase sandbox case, reviewed/approved current snapshot and matching posted recognition journal. Fake/local exports can dry-run only. The connector preserves the original invoice number in PrivateNote, uses a stable operation marker as QBO DocNumber, and saves the local case/bill/recognition journal IDs with the immutable payload, mapping hash, realm, minorversion and request ID before sending.

Only after the existing Increase engine has produced independently verified matched settlement:

```sh
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts submit --case CASE_ID --payment-version PAYMENT_VERSION_ID --mappings /private/path/mappings.json
node --env-file=/Users/junjiexiong/Desktop/calhacks/var/ap-environment/providers.env --import tsx scripts/ap-system/quickbooks-cli.ts verify --case CASE_ID --payment-version PAYMENT_VERSION_ID --mappings /private/path/mappings.json
```

This creates an Accounting API BillPayment, linked to the successful external Bill, with the mapped bank/AP accounts and `PrintStatus: NotSet`. It records the already settled Increase debit; it never calls QuickBooks Payments, sends a bank instruction, prints a check or initiates payment. The backend verifies the payment snapshot/hash, command/request hash, transfer observation, posted negative debit, amount/currency, bill links and posted settlement journal. Returns, unmatched/exception evidence, FakeBank, partial/multi-bill/credit-applied payments are blocked in this first-wave profile. Authority is fetched again immediately before the first external POST after network/mapping waits, and the referenced external Bill is checked for edits.

## 5. Reconcile and record acceptance evidence

After any successful write, save the operation request ID, local IDs, external ID and SyncToken, then use `verify` to read the exact external record. Inspect the same Bill/BillPayment in the selected sandbox and confirm amounts/accounts and absence of duplicate cost recognition.

A timeout/5xx or crash after durable `sending` produces `unknown`. Repeating the same `submit` performs a read-only query by the stable marker and checks exact economic fields. One matching external record resolves the original operation; none leaves it unknown, and duplicates/changed data become conflicts. It does **not** repost an unknown operation or mint a fresh request ID, even if a query currently finds nothing. Resolve persistent unknowns through operator/provider investigation. Never delete the journal or change the ID to make a retry succeed.

Definite 429 responses use at most two waits/retries, honor Retry-After within the 60-second per-wait bound, and otherwise return `qbo_retry_later`. One 401 may refresh and retry the same bytes/request ID. POST 5xx/transport errors are not automatically retried. A changed SyncToken/economic payload blocks synchronization; generic updates/deletes are intentionally unavailable. Apply corrections as separately reviewed accounting events.

The accounting API base is hard-pinned to `https://sandbox-quickbooks.api.intuit.com`. `minorversion=75` is a compatibility baseline, **not a claim that 75 is the newest version**. Redirects are rejected, requests time out at 15 seconds, and response JSON is bounded to 2 MiB. Errors expose fixed codes, not raw response bodies or secrets.

References: [Intuit request-ID best practices](https://blogs.a.intuit.com/2018/09/10/quickbooks-online-api-best-practices/), [Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill), [BillPayment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment), [VendorCredit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendorcredit), [official BillPayment type documentation](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/BillPayment.html), [minor versions](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions).

## B3 credit seam and remaining acceptance

`creditPlan(CreditExport, mappings, successfulBillOperation)` builds VendorCredit from approved credit reversal allocations and immutable local credit/journal/original bill IDs. B3 must supply its authenticated authoritative credit export before exposing submission. This hook does not apply the credit, create a refund, pay the residual balance or recompute a credit from an unapproved candidate. No credit-submit CLI is exposed until that authority is wired.

Complete C4 external acceptance still requires owner registration/grant, successful live mappings, Bill and verified settlement synchronization, external IDs/readback, retry/reconciliation evidence, B3 credit authority/application coverage as scoped, and practitioner review. Documentation was rechecked 2026-10-25: dynamic Intuit entity/OAuth pages returned a sign-in shell; accessible official SDK and static type references corroborate endpoint/field behavior. No undocumented production claim or fabricated live success is made.
