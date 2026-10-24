# Local startup and operator demo

Use Node 24+ and npm. This starts local Convex and a local simulated operator identity. It makes no model or bank calls. Keep each process running in its own terminal, from this checkout.

## 1. Install and start the database

```bash
npm ci
CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3230 --local-site-port 3231
```

Wait for `Convex functions ready`. Convex writes its local configuration to ignored `.env.local` and stores state in ignored `.convex/`. Preserve both for restart recovery. Do not delete `.convex/` to restart the application.

## 2. Configure the local admin secret once

The initializer needs an admin secret; the browser and running invoice gateway do not. This snippet preserves an existing secret, otherwise creates one, and configures only the anonymous local deployment without printing its value:

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

Open `http://127.0.0.1:5173`. The invoice workspace is the default page and is also available at `/invoices`; the historical console remains at `/legacy`.

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

For the original scorer and held-out suite, follow the [evaluation harness instructions](../../evals/invoice-mvp/README.md). Live-model runs need separate explicit authorization and credentials; setting a key alone does not authorize spending. Current live results remain NOT RUN.
