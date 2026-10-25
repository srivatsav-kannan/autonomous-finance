# PR #105 sandbox checks: what we need and how we'll run them

Written for running the checks on Srivatsav's laptop. If JJ runs them on his own machine, where the credentials already are, skip section 1 and follow the run order with his existing config.

## 1. What JJ needs to send privately

Put it in one file at `~/Documents/calhacks/private/ap-sandbox.env` (outside every repo), then run `chmod 600` on it. Don't paste any of it into chat. Tell me when it's there, and I'll check the variable names without printing values.

| Variable | What it is |
|---|---|
| `AP_HUMAN_AUTH_ISSUER`, `AP_HUMAN_AUTH_AUDIENCE` | His Auth0 tenant issuer (`https://<tenant>.auth0.com/`) and SPA client ID |
| `AP_BANK_SCOPE` | JSON with the Increase sandbox `accountId`, `provider:"increase"`, `environment:"sandbox"` and a fresh `ap97-…` runId |
| `AP_SANDBOX_BENEFICIARY` | The reviewed Increase sandbox destination |
| `AP_SANDBOX_TRUSTED_CONTEXT` | Reviewed supplier and GL coding JSON (shape in `AUTH0-SETUP.md`) |
| `AP_BOOTSTRAP_DATE`, `AP_BOOTSTRAP_PERIODS`, `AP_CONTROLLER_LIMIT_CENTS`, `AP_SANDBOX_ACTIVITY_SINCE` | Bootstrap settings for the run |
| `INCREASE_SANDBOX_API_KEY`, `INCREASE_SANDBOX_WEBHOOK_SECRET` | For the payment and evidence workers |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `QBO_ENVIRONMENT=sandbox`, `QBO_REDIRECT_URI` | His Intuit Development app and sandbox company |
| `LLAMA_CLOUD_API_KEY` | Only needed for PDF invoices, and it costs money. An XML invoice avoids it. |

Two decisions for JJ:
1. **QuickBooks login.** QuickBooks refresh tokens rotate on every use. If this laptop uses a copy of his saved tokens while his machine keeps running, each refresh breaks the other. Pick one:
   - (a) He stops using his QuickBooks connection, and you connect fresh here through `quickbooks-callback.ts`. You sign in to Intuit yourself, which needs his Intuit app and sandbox company to give your Intuit account access.
   - (b) You use your own Intuit developer sandbox, and we redo the 8 reference mappings there.
2. **Auth0.** His tenant must allow your Google login (a social connection enabled for the SPA). After you sign in, the page shows your `tokenIdentifier`. That ID gets bound to the run here with `sandbox-bootstrap.ts bind`. No JWTs are pasted anywhere.

## 2. Run order

| Step | Who | What |
|---|---|---|
| 1 | me | Start a fresh Convex backend on 3252/3253 for the `af-ci` checkout of #105, deploy, then `sandbox-bootstrap.ts prepare` with the private file |
| 2 | me | Start the gateway (`sandbox-server.ts`, :8825) and the console (:5192) |
| 3 | **you** | Open `http://127.0.0.1:5192/ap-system`, click **Sign in with Auth0**, and sign in with Google. Tell me "signed in". |
| 4 | me | `sandbox-bootstrap.ts bind` with your identifier from the page, then restart the gateway |
| 5 | me | QuickBooks: run `quickbooks-callback.ts` on :8824 |
| 5a | **you** | Click **Connect sandbox** and sign in to Intuit yourself |
| 5b | me | `inspect`, write `mappings.json`, `mapping-check` |
| 6 | me | Upload the Golden State invoice to a new case |
| 7 | **you** | Review the extracted fields against the original, then click **Approve bill**. This is the human bill review. |
| 8 | **you** | In **Accounting → QuickBooks accounting sync**, tick the approval box and click **Submit reviewed accounting plan**, then **Verify external record** |
| 8a | me | Record the QuickBooks Bill ID, SyncToken and request ID, and check amounts and accounts against our journal |
| 9 | **you** | Prepare the payment, check amount, destination, funding account and date, then click **Authorize this payment** |
| 10 | me | Run the payment and evidence workers, settle in the Increase sandbox, and confirm settlement, the bank debit, and the recognition and settlement journals |
| 11 | **you** | Submit the QuickBooks BillPayment for the settled payment |
| 11a | me | Verify it reads back and doesn't record the cost twice |
| 12 | me | Acceptance report with every ID, what passed, what failed, what wasn't run |

## 3. Known limits for the report

- **Webhooks vs polling.** Increase can't reach `127.0.0.1` without a public tunnel. Unless we set one up, settlement is confirmed by polling only, and webhook verification is reported as **not run**.
- **No accountant sign-off.** This round uses a Claude independent model review, labeled that way.
- **Scope:** USD only.
