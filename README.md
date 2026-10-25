# Autonomous Finance

**An agent-native finance department.** Agents run the entire finance function of a real-world company: AP, payments, cash application, revenue, payroll, leases, close, audit. Humans set goals and policy and make the calls that matter.

The infrastructure underneath is rebuilt for agents, not humans:
- **Ledger:** idempotent, double-entry and hash-chained.
- **Controls:** segregation of duties enforced by the kernel, not by prompts.
- **Memory:** git, not a pile of notes.

Built at Cal Hacks 13.0 for the Hyphenate track, *The Hyphenated Enterprise: Autonomous Systems for Finance*.

## Quick start

Needs Node 24.18+, Python 3.11+ and git. No Convex account; no API key for the free path.

```bash
git clone https://github.com/srivatsav-kannan/autonomous-finance && cd autonomous-finance && npm ci
npm run setup               # checks tools, writes .env.local and local secrets, prepares benchmark data; safe to rerun
npm run backend             # terminal 1: local Convex backend; leave it running
npm run backend:configure   # terminal 2, once the backend is up: copies .env.local settings to the deployment
npm run scenario            # runs scenario-1 (seed 7, 3 stores, 14 days, planted errors, close) and prints a briefing
npm run console             # http://127.0.0.1:5173/?view=inbox#scenario-1
```

Approving or answering items in the console also needs `npm run gateway` (the human seat) in another terminal. Add `OPENAI_API_KEY=...` to `.env.local` to turn on the model; without it the agents run their deterministic paths, and every command says so. Without a model, 21 of 64 invoices are in formats only the model reads, so the books and the close stay incomplete.

Run every eval:

```bash
npm run evals                               # free: control tests, world (model off), spreadsheet benchmark, external rules-only
npm run evals -- --paid --budget-usd 15     # also the model evals; needs OPENAI_API_KEY, prints per-run estimates first
```

Ask questions about scenario-1 (works without the gateway or console):

```bash
npm run scenario
npm run ask -- "Why was INV-1002 held?"
```

Details: [Setup and evals reference](#setup-and-evals-reference). Measured results: [docs/RESULTS.md](docs/RESULTS.md).

> The company is **Sweetgreen, Inc.** (NYSE: SG), simulated and calibrated to its FY2025 SEC filings: $679.5M revenue, 281 restaurants, $19.9M AP, $7.2M gift card liability, $354.5M lease liability. Not affiliated with Sweetgreen. All transactions, counterparties and people are simulated.

## What's different

- **The whole finance org, not one seat.**
  - Twelve seats with distinct identities, limits and managers.
  - The CFO agent hires extra AP clerks when queues back up.
  - Humans sit at the top as overseers.
- **Built for agent pace.**
  - Agents talk to typed APIs and events, not spreadsheets.
  - Seeded simulations compare every chart account, invoice obligation and outgoing payment with independent accounting expectations; missing work is reported explicitly.
- **The kernel enforces the rules** (`convex/`). Every money fact goes through serializable transactions:
  - double entry in integer cents
  - exactly-once operations (idempotency keys)
  - a tamper-evident hash chain
  - capability-checked posting (an AP clerk can't touch cash)
  - requester ≠ approver
  - dual and human approval thresholds
  - remit-to re-checked at execution
  - two-key period close

  An agent that tries anything else is blocked and the attempt is logged.
- **Memory is git-first** (`src/memory/`). Company knowledge is schema-validated YAML in a git repo:
  - Every change is a commit by the seat that made it, with its reasons.
  - Bank details, policies and agent-written code go through proposal branches that a *different* seat must merge.
  - Decision records are immutable. Any number traces back with `git blame`.
- **Agents write their own integrations.** When a supplier sends a format nobody can parse, Claude reads it once. The integrations engineer then writes a parser spec (regexes and field mappings as JSON, never code), tests it and proposes it. The controller re-runs its tests and merges it, and from then on fixed code applies it deterministically.
- **Proof, not vibes** (`npm run eval`). A seeded world with planted errors and an answer key the agents never see. It's scored on:
  - catches, decoys and false alarms
  - books vs truth
  - controls
  - human load, coverage and cost

## Invoice evidence workspace

A focused workflow for one company in USD: import invoices, credit memos and supporting documents, inspect per-customer **net invoiced totals**, resolve exceptions, and keep source and decision history. Net invoiced means included invoices minus credit memos. It is **not an outstanding balance, cash movement, payment execution or revenue-recognition calculation**; it keeps an auditable subledger in Convex and does not post general-ledger or bank transactions.

1. Import supported documents or select the public synthetic demo.
2. See customer totals and every contributing source. Exact copies are marked duplicate; a late imported version supersedes the earlier one without adding a second amount.
3. Open **Needs review** or **Evidence missing** cases. Read the original document, proposed treatment, contradictions, question and audit history.
4. Accept the exact proposal, exclude it, or request additional evidence. Decisions survive refresh and restart. Stale proposals and conflicting retries are rejected.
5. Import a late correction and inspect the resumed result.

The default runtime is explicitly **deterministic**: its narrow parser handles documented text/CSV layouts and leaves unfamiliar evidence unresolved. The optional OpenAI investigator selects source, related-record and policy tools; model proposals require human review. There is no second model reviewer and no measured claim that multiple product agents improve results.

**Invoices** is a view in the finance workbench's shared navigation, next to Inbox, Bank & cash, Finance flow and the other simulation views. The default route and `/invoices` open it; `/legacy` opens the simulation inbox. Invoice company and totals come from the invoice gateway (:8790); simulation scenarios and bank balances stay separate, and Invoices works without a configured simulation backend. To run it locally, follow the [startup guide](docs/invoice-mvp/STARTUP.md).

Measured limits: one approved, capped OpenAI batch (59 calls, $1.20 in provider-reported usage) left the baseline **unscored** (stopped before submission) and the actual app at **0/18** on the original Invoice Sandbox (all 148 sources unresolved) and **4/9** on the frozen held-out suite. A working synthetic demo does not establish unfamiliar-document accuracy or production readiness. Follow-up evaluation design is tracked in #66.

See the [acceptance record](docs/invoice-mvp/ACCEPTANCE.md), [architecture and trust boundaries](docs/invoice-mvp/ARCHITECTURE.md), [live results and comparison limits](docs/invoice-mvp/evaluation-openai-results.md), [frozen evaluation protocol](docs/invoice-mvp/evaluation-protocol.md) and [deterministic results](docs/invoice-mvp/evaluation-results.md), and the [application benchmark harness](evals/invoice-mvp/README.md).

## Run it

Requires **Node 24.18.0 or later**, including for the pinned Prism contract tests. Use the committed dependency lockfile.

```bash
node --version
npm ci
npm run backend                       # local Convex (no account needed); keep it running
```

On a fresh local deployment, the first function deployment can report missing auth configuration while the backend remains running. `npm run backend:configure` sets everything below; to do it by hand, set these local simulator placeholders from a second terminal in the same checkout:

```bash
npx convex env set AP_HUMAN_AUTH_ISSUER https://ap-demo.invalid
npx convex env set AP_HUMAN_AUTH_AUDIENCE ap-demo
```

Use the deployment selected by this checkout's `.env.local`; the anonymous local bootstrap does not accept `--deployment local`. Wait for successful function deployment after the environment update, restarting `npm run backend` if needed. These placeholders do not issue real JWTs.

Run the recoverable AP flow:

```bash
npm run demo:local
```

The [AP demo guide](docs/ap-demo.md) documents immutable human approval, a lost bank response, a killed/restarted dispatcher, missing webhook recovery, journal posting and reconciliation. The local run uses an explicitly simulated human identity. Real JWT approval, Increase sandbox credentials and live webhook delivery are separate checks; missing credentials report `NOT_RUN`.

`npm run demo:local` reuses the `KERNEL_ADMIN_SECRET` in `.env.local`; if none is set it generates one and saves it there, so the deployment and the other runners keep matching.

For the broader legacy profile, the deployment's admin secret must equal the one in the uncommitted `.env.local`. `npm run setup` and `npm run backend:configure` handle this; by hand:

```bash
npx convex env set KERNEL_ADMIN_SECRET
```

Add `ANTHROPIC_API_KEY=...` to `.env.local` to turn on Claude. Without it, the team runs its deterministic paths only. Agent calls on either provider are capped by `AGENT_MAX_USD` (default $15, tracked in `var/agent-spend.json`); a request is refused before it is sent if its worst case would pass the cap.

```bash
npm run smoke                          # kernel and memory invariant checks
npm run eval -- --stores 3 --days 14   # legacy scored run; payments are request-only
npm run gateway:token                  # once: writes VITE_GATEWAY_TOKEN to .env.local
npm run gateway                        # human gateway on :8787 (holds the human CFO seat token)
npm run console                        # overseer console on http://127.0.0.1:5173
```

The gateway acts as the human CFO, so it serves only the console. Every request must carry `VITE_GATEWAY_TOKEN` in an `x-gateway-token` header; the console reads the same value from `.env.local` and sends it. Browser requests are accepted only from `http://127.0.0.1:5173` and `http://localhost:5173` (set `GATEWAY_ALLOWED_ORIGINS` to a comma-separated list to change that), and POSTs must be JSON. The gateway refuses to start without a token of at least 32 characters. Run `npm run gateway:token` again to rotate it, then restart both the gateway and the console. Without a token the console shows an error on human actions instead of reaching the gateway.

Answering an ask in the console records the answer in the kernel first, then runs its effect (approve or void a payment, co-sign a close, merge a proposal), then completes the ask. A different answer to the same ask is refused. If an effect fails, the ask stays open with its answer recorded; choosing the same answer again resumes it.

Evaluation writes its Markdown and JSON reports before exiting. A failed or
incomplete book-correctness result exits nonzero. Without model credentials,
unrecognized invoice formats can remain unresolved; they must not count as
correct books or permit period-close approval. See
[close and evaluation checks](docs/CLOSE_EVAL_CORRECTNESS.md) for verification
commands and compatibility notes.

The legacy world and agent profile can run in real time. Its team/runtime have no bank submission capability, and the evaluator cannot execute payments; use the dedicated AP demo for money movement:

```bash
npm run world -- --run demo --stores 3 --days 14 --pace 3000
npm run agents -- --run demo
```

Check the implementation independently of a running backend:

```bash
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm test
npm run build:console
```

The AP guide maps these suites to authorization, concurrent dispatch, response loss, worker restart, reconciliation and return scenarios. Simulator and Prism results do not establish live sandbox success.

The [CI guide](docs/ci.md) documents automated pull-request gates and `npm run ci:recovery`, which runs the persistent local Convex/FakeBank proof in fresh isolated state and retains sanitized machine-readable evidence.

### External benchmark batch

Compare the full team, a generalist, and deterministic rules on eight pinned APEX + DABstep tasks. See [setup, scoring and run commands](docs/EXTERNAL_EVALS.md). After preparing the fixtures, `npm run bench:run -- --dry-run` shows the default 72-run matrix; `npm run bench:run -- --modes rules-only --repeats 1 --judge off` runs the free baseline.

For OpenAI benchmarks, add `OPENAI_API_KEY` privately to this checkout's `.env.local` (see `.env.example`). `benchmarks/external-models.json` selects GPT-6.1 Sol at medium effort for both agent modes and GPT-6 Astra at low effort for the APEX judge, with explicit token prices. **Paid runs and rescoring remain disabled (`approval: null`) until the user approves a bounded budget.** Adding a key or choosing models does not grant budget approval.

### Simulation dates

The requested start and day count bound all emitted events and the answer key.
Delayed credit memos and invoice resends outside that interval are deferred beyond
this scenario; they do not extend its reported duration. Invoice due dates may
still fall after the simulated interval.

Rent and recurring supplier bills are generated once per calendar month touched
by the scenario. Rent arrives on the first observed day of each month. Monthly
supplier bills arrive on the fifth, clamped to that month's observed interval for
partial months. This fixture models a full monthly obligation even when only part
of the month is simulated; it does not prorate bills.

## Setup and evals reference

**`npm run setup`** (`scripts/setup.ts`) is idempotent. It checks Node 24.18+, Python 3.11+ and git; creates `.env.local` from `.env.example` if missing, or appends only the settings it lacks; generates `KERNEL_ADMIN_SECRET` if it is missing or `change-me`; generates `VITE_GATEWAY_TOKEN` if missing (`npm run gateway:token` rotates it); creates `var/benchmarks/.venv`, installs the readers and prepares both benchmark batches (`bench:prepare -- --batch eight` and `--batch extra`). It never prints secrets. `--skip-bench` skips the benchmark data.

**`npm run backend:configure`** (`scripts/backend-configure.ts`) runs once the backend is up, and again after a backend reset. It sets `KERNEL_ADMIN_SECRET` (from `.env.local`) and `AP_HUMAN_AUTH_ISSUER` / `AP_HUMAN_AUTH_AUDIENCE` (local placeholders `https://ap-demo.invalid` / `ap-demo`, unless `.env.local` sets them) with `npx convex env set`, passing values on stdin. It points `CONVEX_URL` and `VITE_CONVEX_URL` at the running local backend, then waits until the deployment accepts the admin secret. To run a second checkout beside another one, give its backend other ports: `npm run backend -- --local-cloud-port 3410 --local-site-port 3411`.

**`npm run scenario`** (`scripts/scenario.ts`) creates run `scenario-1`, plays the 14 days with no pacing, sends the period end, waits for the agents to finish, scores the run against the answer key (`var/evals/scenario-1.md`, also shown in the console's Evals view) and prints a briefing: what happened, which planted errors were caught, what is waiting for a human, why the close is blocked, and example questions. Rerunning prints the briefing again; an interrupted run resumes. `--run scenario-2` starts a separate run, for example after adding a model key.

**`npm run ask -- "question" [--run id]`** (`scripts/ask.ts`) answers from the record with the same code as the console's "Ask why" (`src/human/why.ts`). With a model it runs the cited-answer tool loop over git memory and the ledger. Without one it ranks decision commits by the question's keywords and lists them with their SHAs; that path reads only git memory, so it needs no backend.

**`npm run evals`** (`scripts/evals.ts`) runs, in order, with inference off: the 20 control tests, the world on seed 7, the spreadsheet-vs-kernel benchmark, and all 15 external tasks in rules-only mode. It needs the backend. Output goes to `var/evals/suite-<time>/`, the table to `var/evals/summary-<time>.md`; the committed `docs/evals/` files are not touched. The model-off world catches the planted errors but its books fail, because the unread invoices have no bills; the table says so.

**`--paid --budget-usd N`** adds the world on seeds 7, 11, 23 and 42, the agent spreadsheet comparison, and full team vs generalist on all 15 external tasks (30 turns, APEX judge). It refuses to start without `--budget-usd` or `OPENAI_API_KEY`. The budget is split 2.5% per world seed, 15% to the spreadsheet comparison and 75% to the external benchmarks; each run stops at its share. It prints the per-run estimate and cap first, then writes a one-time approved copy of `benchmarks/external-models.json` to `var/external-models.evals-<time>.json`, capped at the external share. The checked-in policy stays `approval: null`. The measured cost of the whole paid set was about $7 ([docs/RESULTS.md](docs/RESULTS.md)), so $15 leaves headroom.

## Layout

| Path | What |
|---|---|
| `convex/` | Kernel: ledger, bills, payments, tasks, seats, asks, observability |
| `src/memory/` | Git-first memory store, schemas, day-zero seed |
| `src/agents/` | Runtime, Claude tool loop, seat handlers, staffing |
| `src/world/` | World simulator, planted errors, answer key, simulated bank, callback oracle |
| `src/integrations/` | Invoice parsers, persistent FakeBank and Increase sandbox adapter |
| `src/payments/` | Scoped AP agent handles, durable dispatcher and verified evidence worker |
| `src/evals/` | Scorer and end-to-end eval runner |
| `src/human/` | Human gateway for the console |
| `console/` | Overseer console (React + Convex live queries + WebMCP tools) |
| `company/sweetgreen/` | Calibration profile from SEC filings |
| `docs/` | Architecture, team plan |

`npm run world` and `npm run eval` create and seed company memory automatically
for each new scenario in `var/memory/<run-id>.git`. No separate memory initialization
command is needed; the obsolete `memory:init` script has been removed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TEAM.md](docs/TEAM.md).

For the proposed next implementation, see [Finance backend and integration design](docs/INTEGRATION_DESIGN.md):
Convex data ownership, the AP-first Increase sandbox integration, placement of
Stripe/ERP/billing/ledger/mock tools, and failure-recovery acceptance gates. This
is a design proposal; the new integrations are not implemented by that document.

## Frontend design

The console uses [Hallmark](https://github.com/Nutlope/hallmark) as project-local
agent design guidance and a development-time visual linter. Its warm finance
workbench keeps the live Convex data, human gateway actions, and all seven views.
See [the design system](design.md) and [Hallmark workflow](docs/HALLMARK.md).

```bash
npm run build:console
npm run design:check
npm run design:review -- --url http://127.0.0.1:5173
```
