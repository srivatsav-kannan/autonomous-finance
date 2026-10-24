# Invoice evidence workspace

A focused finance MVP for one company in USD: import invoices, credit memos and supporting documents, inspect per-customer **net invoiced totals**, resolve exceptions, and retain source and decision history.

Net invoiced means included invoices minus credit memos. It is **not an outstanding balance, cash movement, payment execution or revenue-recognition calculation**. This workflow keeps an auditable subledger in Convex; it does not post new general-ledger or bank transactions.

## Operator workflow

1. Import supported documents or select the public synthetic demo.
2. See customer totals and every contributing source. Exact copies are marked duplicate; a late imported version supersedes the earlier one without adding a second amount.
3. Open **Needs review** or **Evidence missing** cases. Read the original document, proposed treatment, contradictions, question and audit history.
4. Accept the exact proposal, exclude it, or request additional evidence. Decisions survive refresh and restart. Stale proposals and conflicting retries are rejected.
5. Import a late correction and inspect the resumed result.

The default runtime is explicitly **deterministic**. Its narrow parser handles documented text/CSV layouts and leaves unfamiliar evidence unresolved. The bounded investigator supports source, related-record and policy tools; model proposals require human review. Live-model evaluation is **NOT RUN** unless an exact-commit evaluation report explicitly says otherwise. There is no second model reviewer and no measured claim that multiple product agents improve results.

## Run locally

Use Node 24+, npm and local Convex. Follow [startup and demo instructions](docs/invoice-mvp/STARTUP.md). No cloud account, model credits or banking connection is needed for the default demo. The operator is a simulated local identity; backend permissions are enforced, but production sign-in is not implemented.

```bash
npm ci
CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3230 --local-site-port 3231
```

Then configure a local admin secret once, initialize a workspace, start the invoice gateway on :8790 and console on :5173 as described in the guide. Privileged seat tokens stay on the server.

## Evidence and limits

- [Integrated acceptance record](docs/invoice-mvp/ACCEPTANCE.md)
- [Architecture and trust boundaries](docs/invoice-mvp/ARCHITECTURE.md)
- [Frozen evaluation protocol](docs/invoice-mvp/evaluation-protocol.md) and [results](docs/invoice-mvp/evaluation-results.md)
- [Actual application benchmark harness](evals/invoice-mvp/README.md)
- [Worker coordination and handoffs](docs/invoice-mvp/COORDINATION.md)

Invoice Sandbox's original scorer tests customer net totals within one cent. Its score alone does not validate document inclusion, source support or workflow reliability. Separate reports cover those properties. Historical 18/18 results measured earlier Claude-only systems, not this MVP.

The prior broad finance simulation remains available for reference. See [its original description](docs/invoice-mvp/LEGACY_PROTOTYPE.md). Payroll, treasury, forecasting and banking are outside this MVP's operator workflow.
