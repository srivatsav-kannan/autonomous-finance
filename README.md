# Invoice evidence workspace

A focused finance MVP for one company in USD: import invoices, credit memos and supporting documents, inspect per-customer **net invoiced totals**, resolve exceptions, and retain source and decision history.

Net invoiced means included invoices minus credit memos. It is **not an outstanding balance, cash movement, payment execution or revenue-recognition calculation**. This workflow keeps an auditable subledger in Convex; it does not post new general-ledger or bank transactions.

## Operator workflow

1. Import supported documents or select the public synthetic demo.
2. See customer totals and every contributing source. Exact copies are marked duplicate; a late imported version supersedes the earlier one without adding a second amount.
3. Open **Needs review** or **Evidence missing** cases. Read the original document, proposed treatment, contradictions, question and audit history.
4. Accept the exact proposal, exclude it, or request additional evidence. Decisions survive refresh and restart. Stale proposals and conflicting retries are rejected.
5. Import a late correction and inspect the resumed result.

The default runtime is explicitly **deterministic**. Its narrow parser handles documented text/CSV layouts and leaves unfamiliar evidence unresolved. The optional OpenAI investigator selects source, related-record and policy tools; model proposals require human review. A capped live batch has run, with limited coverage described below. There is no second model reviewer and no measured claim that multiple product agents improve results.

## Run locally

Use Node 24+, npm and local Convex. Follow [startup and demo instructions](docs/invoice-mvp/STARTUP.md). No cloud account, model credits or banking connection is needed for the default demo. The operator is a simulated local identity; backend permissions are enforced, but production sign-in is not implemented.

```bash
npm ci
CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3230 --local-site-port 3231
```

Then configure a local admin secret once, initialize a workspace, start the invoice gateway on :8790 and console on :5173 as described in the guide. Privileged seat tokens stay on the server.

The updated finance workbench now includes **Invoices** in its shared navigation,
alongside Inbox, Bank & cash, Finance flow and the other six simulation views.
Invoice import, customer evidence, human review and decision history use the same
design system, responsive tables and review drawer. Invoice company/totals come
from the invoice gateway; simulation scenarios and bank balances remain separate.
The default route and `/invoices` open Invoices; `/legacy` opens the simulation inbox.

Frontend checks: `npm run build:console`, `npm run design:check`, and
`npm run design:review -- --url http://127.0.0.1:5173/?view=invoices`.
See [design.md](design.md) for the shared design system.

## Evidence and limits

At application source `d08165c1ad38bb20817ace294c55ed1c50b8c243`, the fresh browser workflow, real backend/gateway restart, and stale-approval/replay smoke pass. Combined verification passed 331 repository tests and 44 evaluator tests, TypeScript checks and the console build. The browser demo records $1,525 across two customers with four source-backed contributions and one unresolved source.

The approved OpenAI batch made 59 calls for $1.201842 in provider-reported usage estimates. The baseline stopped before submission and is **unscored**. The actual app's original benchmark score is **0/18**: all 148 sources remain unresolved. Conservative reservations exhausted the app envelopes before broad document investigation. See the [live results and comparison limits](docs/invoice-mvp/evaluation-openai-results.md); successful transport and a working synthetic demo do not establish unfamiliar-document accuracy or production readiness. Earlier deterministic results at `926e4e8` remain preserved: **0/18** original and **4/9** held-out.


- [Integrated acceptance record](docs/invoice-mvp/ACCEPTANCE.md)
- [Architecture and trust boundaries](docs/invoice-mvp/ARCHITECTURE.md)
- [Frozen evaluation protocol](docs/invoice-mvp/evaluation-protocol.md) and [results](docs/invoice-mvp/evaluation-results.md)
- [Actual application benchmark harness](evals/invoice-mvp/README.md)
- [Worker coordination and handoffs](docs/invoice-mvp/COORDINATION.md)

Invoice Sandbox's original scorer tests customer net totals within one cent. Its score alone does not validate document inclusion, source support or workflow reliability. Separate reports cover those properties. Historical 18/18 results measured earlier Claude-only systems, not this MVP.

The prior broad finance simulation remains available for reference. See [its original description](docs/invoice-mvp/LEGACY_PROTOTYPE.md). Payroll, treasury, forecasting and banking are outside this MVP's operator workflow.
