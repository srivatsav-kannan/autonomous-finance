# Authenticated PDF processing demo

Open `http://127.0.0.1:5192/ap-system?view=ap-system`. This is the Auth0 workspace backed by the configured Increase sandbox account. The separately labeled APEX local simulation uses FakeBank and does not establish real identity or provider execution.

1. Sign in through Auth0 with an already approved workspace identity.
2. Select **Process a PDF**, choose the original, then **Parse invoices**. Separate invoices retain separate request keys; a supporting packet contains one invoice.
3. Watch the authenticated server's saved intake status: parsing, saving the case, then the resulting case. Status never advances merely because time elapsed. The existing LlamaParse adapter retains its provider job and artifacts; retries use that job and the same intake key.
4. Inspect the original PDF and fields. The connected process panel reads source provenance, actual case states, persisted work records and recorded model decisions. Missing records are labeled as missing.
5. Open **View all diffs** or **Model & work history**. Human source review, bill approval and payment release remain separate actions. New uploads do not approve bills or send funds.

The connected workspace checks for updated case/work records every three seconds while idle. It pauses refresh during a human mutation or while an input is focused, preserving the current review. A connection failure keeps the previous records visible and shows a reconnect notice.

## Existing local runtime

The UI uses port 5192, the Auth0 gateway 8825, and its existing Convex backend 3252. Start the gateway with its existing private bootstrap configuration and provider environment:

```sh
node --env-file=/absolute/path/to/private-providers.env --import tsx scripts/ap-system/sandbox-bootstrap-env.ts gateway
```

The environment file supplies `LLAMA_CLOUD_API_KEY` and any configured QuickBooks credentials. Do not commit it. This command does not provision/reset a backend, bind an identity, or start a payment dispatcher. Use the existing frontend process, or `npm run console` with the connected AP gateway configured.

Intake progress is private JSON under the existing run directory. The status endpoint requires the same verified identity and established session as source inspection. It never exposes credentials or raw provider errors.

## Scope

Auth0 authenticates real users. LlamaParse performs real provider work. Increase and QuickBooks remain their real **sandbox** services; no production money is involved. A complete source candidate still requires the current extractor's supported fields and trusted supplier mapping. An APEX supplier is not silently mapped to Golden State, and unsupported extraction stays visibly held for review. The full APEX corpus simulation remains a separate reference until its supplier and historical-payment controls are integrated into the connected backend.

## Verified on 2026-10-25

An authenticated browser upload of the unchanged `Avila_AVILA-202412-A6.pdf` invoked a new LlamaParse job and saved a new case in 17.447 seconds. Its stored SHA-256 matched the original. The connected extractor reported incomplete mapping, and the actual AP worker moved the case to `waiting / missing_evidence` with the `complete_invoice_fields` requirement. No payment or journal was created for that case. This verifies a live parser and worker hold, not complete APEX extraction or a new bank settlement.

The process panel also supports the older deployed worker's read-only `inspect` projection. It displays its real owner and requirements without inventing newer work IDs or enabling controls that require a newer backend generation.
