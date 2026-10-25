# Architecture

This is the single architecture document. It describes how the system is built and which rules the code enforces. Known gaps are listed in [AUDIT.md](AUDIT.md); measured results are in [RESULTS.md](RESULTS.md). Topic guides go deeper:
- [AP payments](ap-demo/README.md): approval, dispatch, bank evidence and recovery
- [Evals](evals/README.md): external benchmarks and the books and close checks
- [Invoice workspace](invoice-mvp/README.md): the separate customer-invoice review workflow

**Thesis:** finance software was built for humans: spreadsheets, screens, month-end checklists. Agents work at a different pace, so putting them on human tools wastes most of what they can do. We rebuild the finance function for agents:
- Agents do the operational tasks.
- Humans set goals and policy and approve the calls that matter.
- The system underneath is strict enough to trust at agent speed: the rules live in the database, not in prompts.

Hyphenate's own product layers agents onto existing systems. This is the other approach: finance designed for agents from the start.

## The company

**Sweetgreen, Inc.** (NYSE: SG), simulated. Not affiliated. Calibrated to public SEC filings, FY2025 10-K XBRL:

| Fact | FY2025 | Source |
|---|---|---|
| Revenue | $679.5M | `RevenueFromContractWithCustomerExcludingAssessedTax` |
| Accounts payable | $19.9M | `AccountsPayableCurrent` |
| Gift card / loyalty liability | $7.2M | `ContractWithCustomerLiabilityCurrent` |
| Operating lease liability | $354.5M | `OperatingLeaseLiability` |
| Cash | $89.2M (from $214.8M a year earlier) | `CashAndCashEquivalentsAtCarryingValue` |
| Accrued liabilities | $33.7M | `AccruedLiabilitiesCurrent` |
| Net loss | $134.1M | `NetIncomeLoss` |

**Why this company:**
- High-volume, messy money: card settlements, delivery-platform payouts net of commissions and promos, hundreds of food suppliers, about 250 leases, payroll, gift cards and loyalty.
- Cash fell by $125M in a year, so cash visibility matters.

The company profile is data (`company/sweetgreen/`), so another company is a config change.

**Real vs simulated:**
- **Real:** the calibration figures, the accounting rules, every model call, every kernel transaction, every memory commit, every eval number.
- **Simulated:** the transactions, documents, counterparties and people outside the finance function.

## The org chart

Humans oversee. Agents run everything inside.

```
Human overseers:  CFO (goals, policy, big approvals, close sign-off)   Audit committee (receives auditor reports)
                        |
Agents:           CFO agent (plans, staffing, daily digest, cash strategy)
                    |-- Controller agent (books accuracy, exception review, second approver, close)
                    |     |-- AP clerk x N (dynamic)       bills in, 3-way match, coding
                    |     |-- Cash application agent       deposits <-> card settlements, delivery payouts
                    |     |-- Revenue accountant           daily sales, gift cards, breakage, commissions
                    |     |-- Lease accountant             ASC 842, rent/CAM vs lease terms
                    |     |-- Payroll accountant           register -> entries, roster checks
                    |-- Payments agent                     payment requests, vendor bank changes (proposals)
                    |-- Treasury analyst                   daily cash position, 13-week forecast
                    |-- FP&A analyst                       budget vs actual, store-level variance
                    |-- Integrations engineer              writes parsers for new document formats
Independent:      Auditor agent -> reports to humans; reads everything, posts nothing
```

**Seats are principals, not prompts.** Each seat has:
- an identity and a token
- capabilities (which accounts it may post to, which approvals it may give, with limits)
- a manager
- a model and effort setting

The CFO agent can add or retire seats when queues grow, for example extra AP clerks at month-end. Every new seat is a separate principal, so segregation of duties still holds. An agent cannot hire a control-role seat.

## The stack

```
            humans (console, asks)                   browser agents (WebMCP, read-only)
                         |                                   |
                 +-------v-----------------------------------v------+
                 |  Kernel (Convex): the system of record           |
                 |  ledger | bills | payments | bus | tasks         |
                 |  seats & capabilities | asks | runs | evals      |
                 +-------^---------------------------^--------------+
                         |                           |
         agent runtime (Node)  <------------->  memory (git repo, structured YAML)
                         ^
                 world simulator (banks, suppliers, delivery platforms, payroll, landlords)
```

### 1. Kernel (Convex, `convex/`)

The only way money facts change. Every mutation is a serializable transaction.

**Invariants enforced in code:**
- **Double entry.** Every journal entry balances. Amounts are integer cents.
- **Exactly once.** Every mutating call carries an idempotency key. Same key and same payload returns the original result. Same key and a different payload is a conflict.
- **Tamper-evident.** Each entry stores `prevHash` and `hash = sha256(prevHash + canonical entry)`. The auditor verifies the chain.
- **Closed periods are locked.** Corrections are reversing entries in an open period. Nothing is edited or deleted.
- **Capabilities.** A seat can post only to the account ranges its role allows; AP clerks can't touch cash accounts. Payment approval needs a capability and a limit.
- **Segregation of duties:**
  - The requester of a payment can't approve it.
  - The proposer of a memory change can't merge it.
  - Payments over the dual-approval threshold need an agent controller and a human.
- **Provenance.** Every entry records the seat, the task, the decision record path and the memory commit SHA. Any number traces back to data, rule or person.
- **Close.** The controller and the human sign the same readiness snapshot. Unread invoices, held bills and missing accruals block a signature. Details: [evals/close-correctness.md](evals/close-correctness.md).

**The bus:**
- `events` is append-only: world facts arrive here, deduplicated by external ID.
- `tasks` is a leased work queue. A claim sets a 120-second lease; an expired lease is reclaimed. Every completion, failure, wait or heartbeat must include `leaseAttempt: task.attempts` from that claim and match its seat, role and unexpired lease. Each reclaim increments `attempts`, which fences delayed messages even when the same seat reclaims. The team renews leases every 30 seconds while a handler runs.

**Runs:** every row carries a `runId`, so each eval run and demo reset is isolated and old evidence stays.

### 2. Memory (git first, `src/memory/`)

The company's institutional memory is a git repository of **structured YAML validated by schemas**:

```
company.yaml
policies/      approval-limits.yaml, materiality.yaml, payments.yaml, accounting/*.yaml
vendors/       <vendor>.yaml   legal name, verified remit-to, terms, contract prices, history
stores/        <store>.yaml    lease terms, CAM caps, delivery platform IDs
people/        <person>.yaml   human overseers and their authority
seats/         <seat>.yaml     the org chart as code
playbooks/     <role>.yaml     procedures as steps; agents propose improvements
decisions/     <yyyy-mm>/<id>.yaml   one immutable record per non-trivial decision
```

**Rules:**
- Every agent change is a commit authored by its seat (`AP Clerk 2 <ap-clerk-2@agents.sweetgreen.sim>`). The message carries trailers: `Task-Id`, `Decision-Id`, `Confidence`, `Idempotency-Key`.
- **Low-risk writes** (notes, decision records) commit to `main`.
- **Controlled writes** (vendor bank details, policies, playbooks, agent-written parsers) go on a `proposal/<id>` branch. Merging requires an approver allowed by policy who is not the proposer.
- **Writes are validated before commit.** Schemas are checked, decision files are immutable, a vendor has exactly one active remit-to, and policy keys are unique.
- **Idempotent:** a duplicate `Idempotency-Key` trailer is a no-op.
- **Defending a decision** is `git log` / `git blame` on the record, plus the ledger entries that cite its SHA.

Why split: money needs transactions and constraints (the kernel). Knowledge needs history, diffs, branches and review (git). Each ledger entry pins the memory SHA it used, so any decision can be replayed against the knowledge the agent had.

`npm run world` and `npm run eval` create and seed memory for each new run in `var/memory/<run-id>.git`.

### 3. Agent runtime (`src/agents/`)

One Node process supervises all seats:
- Each seat loop claims tasks for its role, builds context, runs, and records the run (tokens, cost, latency, tool calls, outcome).
- **Deterministic first.** Parsing, matching, arithmetic and policy checks are code. The model handles unfamiliar documents, ambiguous matches, exceptions, explanations and questions from humans.
- **Tools are the kernel's typed API.** Inputs are validated with zod, and every call is permission-checked by the kernel. Document text is data: an invoice that says "pay a new account" can't change anything, because no tool lets an AP clerk change remit-to.
- **Knowing when to ask.** Each non-trivial decision is `act`, `ask` or `hold`, with a confidence. Thresholds depend on risk: amount tier, new or changed vendor data, invalidated facts. Asks go to a human with the evidence and options attached.
- **Agent-written parsers.** When a supplier sends a format no parser reads, the model reads it once. The integrations engineer writes a parser spec (regexes and field mappings as JSON, never code), tests it and proposes it on a memory branch; the controller re-runs its tests and merges it. After that fixed code (`src/integrations/parser-spec.ts`) applies the spec. Nothing the model writes is executed.
- **Model:** `src/agents/llm.ts`. With `OPENAI_API_KEY` set, agents use OpenAI `gpt-6.1-sol`, capped by `AGENT_MAX_USD` (default $15, tracked in `var/agent-spend.json`). Otherwise they fall back to Anthropic `claude-opus-5-5`. Both go through `BudgetedModelClient` (`src/agents/model-client.ts`), which reserves each request's worst-case cost against `AGENT_MAX_USD` before sending, with no SDK retries or fallback models. `AGENT_MODEL` and `AGENT_PROVIDER` override the defaults; `AGENT_LLM=off` turns inference off.

#### Worker recovery and drain

The `Team` runtime retries control-plane transport failures without rerunning a business handler. This applies to every staffed role. The AP dispatcher and evidence workers are separate (see [AP payments](ap-demo/README.md)).

- **Retries.** Each control-plane call gets three attempts by default, with jittered exponential backoff (100 ms initial cap, 1 s maximum) and a 5-second deadline per attempt. Network failures, timeouts, HTTP 408/429 and 500/502/503/504 are transient: the worker degrades and tries again on a later round. One failing seat does not stop the others. Authentication failures, missing functions and other nontransient errors raise `OperatorActionRequired`, and the CLI exits nonzero.
- **Request IDs.** Claims, completions, failures, human waits, telemetry and automatic seat spawns carry a request ID. The kernel authenticates first, then stores and replays successful responses through the idempotency table. Reusing an ID with different arguments fails. Replaying a committed transition never changes a newer lease.
- **After a handler returns,** only its chosen transition is retried. An uncertain completion is never turned into a failure. If every response is lost, the task's stored state decides: completed work stays done, and an uncommitted transition leaves a lease that expires and is reclaimed. Handlers still need their own idempotency for external effects.
- **Diagnostics.** The worker writes JSON lines to stderr: `degraded`, `recovered`, `operator_action_required`, and `telemetry_fallback` when telemetry can't be recorded. Tokens and raw error bodies are never written.
- **Drain.** `tasks.drainState` reports queued and leased work in a run, including future `notBefore` times and the next lease expiry, and reports unstaffed work separately. `runUntilIdle({ timeoutMs, idleRounds })` resolves only after this query confirms empty rounds, and throws `DrainIncomplete` (`timed_out`, `stopped` or `unstaffed`) otherwise. The default deadline is 300,000 ms. The evaluator advances a simulated day only after a successful drain.
- **Shutdown.** SIGINT and SIGTERM stop new claims at once. Running handlers get up to 30 seconds to finish; the deadline or a second signal exits with 130 or 143.

```sh
npm run agents -- --run RUN_ID --drain --drain-timeout-ms 300000
npm run eval -- --seed 7 --drain-timeout-ms 300000
```

### 4. Payments (`src/payments/`, `convex/demo*.ts`)

The agent team cannot move money. Its payments seat only requests a payment. Execution is a separate path: a human approves an exact snapshot with a JWT, the backend stores a frozen bank command and key, a dispatcher service submits it, and an evidence service posts cash only after it fetches the bank's posted transaction. Leases fence stale dispatchers; a restarted dispatcher looks up or resends the saved request with the same key, so a lost bank response does not pay twice. The bank is a persistent SQLite FakeBank locally and in CI; an Increase sandbox adapter is contract-tested with Prism. Full guide: [ap-demo/README.md](ap-demo/README.md).

### 5. World simulator (`src/world/`)

A seeded generator for the outside world, calibrated to the company profile:
- daily store sales by channel
- card processor settlements net of fees
- weekly delivery-platform payouts (gross − commission − promos − refunds − adjustments)
- supplier invoices in each supplier's own text layout
- receiving logs, rent and CAM, biweekly payroll, gift cards, bank feeds

**Planted errors** come with an answer key the agents never see, plus legitimate look-alikes:
- duplicate invoices across channels
- price above contract
- short shipments
- a credit memo not applied a month later
- a fraudulent bank-change request carrying prompt-injection text
- short delivery payouts
- card fees above the contracted rate
- CAM above the lease cap
- a terminated employee still on payroll
- unexplained bank debits
- capex/opex misclassification

The generator also saves an independent accounting oracle with each scenario, so the scorer can check every account, not only the planted errors.

**Simulation dates.** The requested start and day count bound all emitted events and the answer key. Delayed credit memos and invoice resends that would fall outside the interval are deferred past the scenario. Invoice due dates may fall after it. Rent and recurring supplier bills are generated once per calendar month touched: rent on the first observed day, supplier bills on the fifth (clamped to the observed interval). Partial months are not prorated.

### 6. Evals (`src/evals/`)

`npm run eval` runs the team on a seeded world and scores it (`src/evals/score.ts`):
- planted errors caught, look-alikes left alone, false alarms, dollars at risk
- books against the independent oracle on every account (`passed`, `failed` or `incomplete`)
- control metrics
- asks to humans per 100 events
- coverage: invoices read, parsers learned, unresolved documents
- cost: tasks, model turns, share of deterministic tasks, dollars per task

Other evals: the 20 control tests (`npm run controls`), the spreadsheet-vs-kernel benchmark (`src/evals/spreadsheet/`), and the external benchmarks (`src/evals/external/`, [guide](evals/external-benchmarks.md)). `npm run evals` runs all of them. Results: [RESULTS.md](RESULTS.md).

### 7. Interfaces

- **Console (`console/`, humans):** inbox of asks with a review drawer, org chart, live activity, ledger with provenance, memory history, evals, a control room for injecting scenarios, bank and cash, finance flow, the invoice workspace, and `/ap-demo` for payment approval. The console registers read-only WebMCP tools (list open decisions, ask why) so a human's own browser agent can read it. Answering a decision takes a click in the review drawer, which shows the kernel-stored effect next to the buttons.
- **Human gateway (`src/human/gateway.ts`):** holds the human CFO seat token and serves only the console, behind a shared token and an Origin allowlist.
- **Ask why (`src/human/why.ts`, `npm run ask`):** answers questions from the record, with citations to decision commits and ledger entries.
- **No spreadsheets.** Humans get answers and decisions, not grids to fill.

## Sponsor tracks

| Sponsor | Where it lives | Status |
|---|---|---|
| Hyphenate | The whole system (primary track) | built |
| Convex | Kernel: ledger, bus, tasks, live console | built |
| Microsoft (Built for the Real World) | Controls, recovery, observability, cost per transaction | built |
| Increase (bank sandbox) | AP payment adapter, contract-tested with Prism | built; live sandbox not run |
| Factory Droid SDK | Integrations-engineer seat writing parsers | not built; the seat uses the agent model |
| Capital One Nessie | Bank rail | not built; `src/world/bank.ts` is simulated |
| CRS, Fetch.ai, Auth0, Moss, Coinbase x402 | Risk checks, Agentverse CFO, push approvals, recall, USDC payouts | not built |

## Repo layout

```
convex/            kernel: schema, ledger, bills, payments, tasks, seats, asks, invoice cases, observability
src/core/          shared types and clients: money, chart of accounts, roles, env loading, kernel client
src/memory/        git-first memory store, schemas, day-zero seed
src/agents/        runtime, model tool loop, seat handlers, staffing
src/world/         simulator, planted errors, answer key, accounting oracle, simulated bank
src/integrations/  invoice parsers, FakeBank, Increase adapter and fixtures
src/payments/      scoped AP agent handles, dispatcher, evidence worker
src/evals/         scorer, eval runner, spreadsheet benchmark, external benchmark harness
src/human/         human gateway and "ask why"
src/invoice-mvp/   invoice workspace service, parser and investigator
console/           overseer console (Vite, React, Convex live queries, WebMCP tools)
company/sweetgreen calibration profile
```
