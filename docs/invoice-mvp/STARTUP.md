# Local startup and operator demo

Use Node 24+ and npm. This starts local Convex and a local simulated operator identity. It makes no model or bank calls. Keep each process running in its own terminal, from this checkout.

## 1. Install and start the database

```bash
npm ci
npm run backend
```

Wait for `Convex functions ready`. Convex writes its local configuration to ignored `.env.local` and stores state in ignored `.convex/`. Preserve both for restart recovery. Do not delete `.convex/` to restart the application.

Ports: the local backend uses `:3210` (cloud) and `:3211` (site) by default, the invoice gateway `:8790`, the console `:5173`. The invoice workspace and the simulation share one backend, `.env.local` and `.convex/` in a checkout. To run a second backend, use a second checkout and pass other ports: `npm run backend -- --local-cloud-port 3410 --local-site-port 3411`. The invoice gateway loads all of `.env.local`, including the admin secret, through `src/core/env.ts`.

## 2. Configure the local admin secret once

The initializer needs an admin secret. `npm run setup` then `npm run backend:configure` (README quick start) generate it and set it on the deployment. To do it by hand, this snippet preserves an existing secret, otherwise creates one, and configures only the anonymous local deployment without printing its value:

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const file = '.env.local';
let text = fs.readFileSync(file, 'utf8');
if (!/^CONVEX_DEPLOYMENT=anonymous:/m.test(text)) throw new Error('Expected anonymous local Convex configuration');
const secret = /^KERNEL_ADMIN_SECRET=(.+)$/m.exec(text)?.[1]?.trim() ?? randomBytes(24).toString('hex');
if (!/^KERNEL_ADMIN_SECRET=/m.test(text)) text += '\nKERNEL_ADMIN_SECRET=' + secret + '\n';
fs.writeFileSync(file, text, { mode: 0o600 });
fs.chmodSync(file, 0o600);
try {
  execFileSync('./node_modules/.bin/convex', ['env', 'set', 'KERNEL_ADMIN_SECRET', secret], { stdio: 'pipe' });
  console.log('Local admin secret configured; value not printed.');
} catch { throw new Error('Local secret configuration failed; check the running local backend.'); }
JS
```

## 3. Initialize and start the workspace

```bash
npm run invoice-mvp:init -- --run-id invoice-demo --company 'Demo Services Company'
node --env-file=var/invoice-mvp/invoice-demo/runtime.env --import tsx scripts/invoice-mvp-server.ts
```

Re-running the initializer verifies and reuses the workspace. It never rotates existing seat tokens or resets documents. It writes protected files under `var/invoice-mvp/invoice-demo/`: `seats.json` contains credentials; `runtime.env` contains their path and nonsecret configuration. Do not commit or share either directory. Use a new run ID for a fresh evaluation.

The gateway listens at `http://127.0.0.1:8790`. Startup resumes interrupted pending work. Missing evidence remains visible until new evidence or a decision arrives.

## 4. Start and use the browser

```bash
npm run console
```

Open `http://127.0.0.1:5173`. Invoices is the default view in the updated finance workbench, also available at `/invoices` or `?view=invoices`. All nine simulation views remain in the same navigation; `/legacy` opens the simulation inbox.

Invoice company, runtime mode, imports and totals come from the invoice gateway.
The Scenario selector appears only on simulation views; its URL hash never selects
an invoice workspace. The invoice view remains usable without `VITE_CONVEX_URL`.
To connect simulation views to a different existing local backend, supply its URL
when starting the console (for example, `VITE_CONVEX_URL=http://127.0.0.1:3410 npm run console`).
The invoice proxy defaults to :8790; `INVOICE_MVP_GATEWAY_URL` can select a different
loopback gateway for an isolated test. Set the gateway's allowed browser origin to
match the test console's hostname and port.

Use the demo import control, inspect customer totals and open their contributing documents. Open the disputed invoice, read the specific question, then accept or exclude that exact proposal with a reason. Refresh the page to confirm the recorded result and audit history. Add the demo's late correction to see the earlier version superseded. The unfamiliar service recap should remain **Evidence missing** until corrected evidence is supplied or a human excludes it.

The public synthetic demo is a teaching example, not a held-out evaluation. It includes customer records, invoice/credit amounts, a duplicate, a disputed invoice and an unfamiliar recap. A later batch replaces the original Birch invoice. Deterministic routine formats and the optional investigator are labeled separately in the workspace.

## Inputs and failures

Import UTF-8 text, CSV customer records or a JSON batch of source objects. Supported routine invoice text is deliberately narrow:

```text
INVOICE
Customer ID: example-customer
Customer: Example Customer
Document Number: INV-100
Currency: USD
Total: USD 100.00
Status: issued
```

First supply a customer master with `customer_id,legal_name` (optional `aliases` separated by `;` or `|`). Credits use `CREDIT MEMO`. Unknown layouts and conflicting fields require investigation or review. An invoice number does not establish payment.

The extractor also prepares reviewable candidates from letterheads, PDF page text,
split label/value lines, `Bill To` aliases, `Invoice Total`/`Grand Total`, and signed
`CREDIT NOTE`/`CREDIT MEMO` totals. It matches names/aliases exactly against the
customer registry and keeps the full invoice total separate from the balance due.
These broader layouts require human approval. A `$` without explicit USD asks for
currency confirmation; contradictory totals or customer identities remain Evidence
missing. See [extraction measurements and limits](extraction-results.md). This does
not add native PDF extraction or OCR to the browser.

A source object has `externalId`, `name`, `mimeType`, `text` and optional `contentBase64`. Original PDF bytes require extracted text supplied by an upstream extractor; the browser does not claim native OCR. The benchmark uses pinned pypdf extraction with original bytes preserved. UTF-8 CRLF normalization is permitted while original bytes remain unchanged. Source limits are exposed at `/api/invoice-mvp/runtime`; split large collections into bounded batches.

An unchanged `externalId` plus changed contents creates a new version. Re-importing exact old bytes is an idempotent historical retry. A different external ID with identical bytes becomes a visible duplicate. Use explicit replacement metadata only for an intentional correction; textual claims alone do not replace accepted amounts.

If the backend/gateway is unavailable, the UI displays an error and retry control. Start the missing process and retry. A stale approval returns HTTP 409: refresh the case and review the current proposal. Do not retry a changed answer with an already-used idempotency key.

## Restart and verification

Stop gateway and Convex with Ctrl-C, leave their files intact, and rerun their startup commands with the same run ID and seat file. Restart the console or refresh. Final integrated evidence and exact tested commits are recorded in [ACCEPTANCE.md](ACCEPTANCE.md).

```bash
npm test
npm run typecheck
npx tsc --noEmit -p convex/tsconfig.json
npx vite build --config console/vite.config.ts
```

For the original scorer and held-out suite, follow the [evaluation harness instructions](../../evals/invoice-mvp/README.md). The one approved OpenAI batch has finished; [results](evaluation-openai-results.md) record its exact sources, partial coverage and costs. Its ledger and run IDs must not be reset or reused to obtain another run. Any additional paid batch needs authorization.

The OpenAI product configuration is `INVOICE_MVP_MODE=live_model`, `INVOICE_MVP_LIVE_OPT_IN=1`, `INVOICE_MVP_PROVIDER=openai`, with `OPENAI_API_KEY` supplied privately to the server. The model is fixed to `gpt-6.1-sol`, high reasoning effort, 4,096 maximum output tokens, default service tier, and no caching, retries or fallback. Configure explicit request bounds, token prices and persistent run caps exactly as described in the [OpenAI evaluation configuration](evaluation-openai-results.md#configuration). Starting the live gateway does not dispatch model calls: processing requires an explicit live request. Keep the default deterministic configuration for the free browser demo.

The integrated local demo is `http://127.0.0.1:5173/?view=invoices#finance-workbench`,
with the invoice gateway on :8790 and the simulation backend from this checkout's
`.env.local`. The UI integration was checked with a fresh deterministic workspace,
`invoice-ui-integration-20261024`; no benchmark run IDs or paid evaluation ledgers were reused.

Multiple invoice gateways share a cookie name on the same hostname, even across ports; simultaneous browser polling can replace each other's session cookie and reject writes. Use a separate browser profile or hostname for a second invoice gateway. This limitation does not affect the evaluator's isolated cookie jars.
