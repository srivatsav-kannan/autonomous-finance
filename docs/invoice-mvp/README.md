# Invoice workspace

A separate workflow inside the console for one company in USD. You import customer invoices, credit memos and supporting documents, inspect per-customer **net invoiced totals**, resolve exceptions, and keep source and decision history.

Net invoiced means included invoices minus credit memos. It is **not** an outstanding balance, cash movement, payment or revenue-recognition figure. The workspace keeps an auditable subledger in Convex (`convex/invoiceCases.ts`) and does not post general-ledger or bank transactions. It does not use the simulated company or the agent team.

## The workflow

1. Import supported documents, or load the public synthetic demo.
2. See customer totals and every contributing source. Exact copies are marked duplicate; a later version of a document supersedes the earlier one without adding a second amount.
3. Open **Needs review** or **Evidence missing** cases: the original document, the proposed treatment, contradictions, the open question and the audit history.
4. Accept the exact proposal, exclude it, or ask for more evidence. Decisions survive refresh and restart. Stale proposals and conflicting retries are rejected.
5. Import a late correction and see the updated result.

The default runtime is **deterministic**: a narrow parser handles documented text and CSV layouts and leaves unfamiliar evidence unresolved. An optional OpenAI investigator can use source, related-record and policy tools; every model proposal needs a human decision. There is no second model reviewer, and no claim that multiple agents improve results. The measured live batch did not resolve unfamiliar documents; see [evaluation-openai-results.md](evaluation-openai-results.md).

**Invoices** is a view in the console's navigation, next to the simulation views. `/` and `/invoices` open it; `/legacy` opens the simulation inbox. Invoice data comes from the invoice gateway on `:8790` and works without a simulation backend.

## Code

| Path | What |
|---|---|
| `src/invoice-mvp/` | Service, HTTP gateway, routine parser, investigator and model adapters |
| `convex/invoiceCases.ts` | Case, proposal, decision and total storage, with seat checks |
| `scripts/invoice-workspace-init.ts` | `npm run invoice-mvp:init`: creates a workspace and its seats |
| `scripts/invoice-mvp-server.ts` | `npm run invoice-mvp:server`: the gateway |
| `scripts/invoice-mvp-smoke.ts`, `scripts/invoice-mvp-http-smoke.ts` | Live-backend smoke checks: `npx tsx scripts/invoice-mvp-smoke.ts` |
| `evals/invoice-mvp/` | The [evaluation harness](../../evals/invoice-mvp/README.md) |

Tests: `npm run invoice-mvp:test`.

## Docs in this folder

| File | What |
|---|---|
| [STARTUP.md](STARTUP.md) | Run it locally: backend, initializer, gateway, console, inputs, restart |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components and trust boundaries |
| [CONTRACT.md](CONTRACT.md) | Data contract v1: sources, cases, proposals, decisions |
| [INVESTIGATOR.md](INVESTIGATOR.md) | The investigator, gateway routes and model boundary |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Browser and restart acceptance evidence, with screenshots |
| [evaluation-protocol.md](evaluation-protocol.md) | The frozen protocol. Do not edit: the harness records its SHA-256 |
| [evaluation-results.md](evaluation-results.md) | Deterministic (model-off) results |
| [evaluation-openai-results.md](evaluation-openai-results.md) | The capped OpenAI batch: results, limits and configuration |
| `*.json` | Machine-readable evidence for the reports above |
