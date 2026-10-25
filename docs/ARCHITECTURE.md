# Architecture

> This describes the original prototype and its intended controls, not a guarantee
> that every invariant is currently enforced. The proposed next implementation is
> [Finance backend and integration design](INTEGRATION_DESIGN.md), which defines
> Convex ownership, provider adapters, recovery semantics and acceptance gates.

**Thesis:** finance software was built for humans: spreadsheets, screens, month-end checklists. Agents work at a different pace, so putting them on human tools wastes most of what they can do.

We rebuild the finance function for agents:
- Agents do every operational task.
- Humans set goals and policy and approve the calls that matter.
- The system underneath is strict enough that you can trust it at agent speed.

Hyphenate's own product layers agents onto existing systems ("no rip-and-replace"). This is the other approach: what finance looks like when it is designed for agents from day one.

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
- High-volume, messy money: card settlements, delivery-platform payouts net of commissions and promos, hundreds of food suppliers, about 250 leases, payroll for thousands, gift cards and loyalty.
- Cash fell by $125M in a year, so cash visibility is a real stake, not a toy.

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
                    |-- Payments agent                     payment runs, vendor bank changes (proposals), execution
                    |-- Treasury analyst                   daily cash position, 13-week forecast
                    |-- FP&A analyst                       budget vs actual, store-level variance
                    |-- Integrations engineer (Droid)      writes parsers for new document formats
Independent:      Auditor agent -> reports to humans; reads everything, posts nothing
```

**Seats are principals, not prompts.** Each seat has:
- an identity and a token
- capabilities (which accounts it may post to, which approvals it may give, with limits)
- a manager
- a model and effort setting

The CFO agent can spawn or retire seats when queues grow. Example: three extra AP clerks at month-end. Every new seat is a separate principal, so segregation of duties still holds.

## The stack

```
            humans (console, digests, asks)          external agents (MCP)
                         |                                   |
                 +-------v-----------------------------------v------+
                 |  Kernel (Convex): the system of record           |
                 |  ledger | subledgers | payments | bus | tasks    |
                 |  seats & capabilities | asks | runs | evals      |
                 +-------^---------------------------^--------------+
                         |                           |
         agent runtime (Node, Claude)  <------>  memory (git repo, structured YAML)
                         ^
                 world simulator (banks, suppliers, delivery platforms, payroll, landlords)
```

### 1. Kernel (Convex)

The only way money facts change. Every mutation is a serializable transaction.

**Invariants enforced in code, not prompts:**
- **Double entry.** Every journal entry balances (sum of debits = sum of credits). Amounts are integer cents.
- **Exactly once.** Every mutating call carries an idempotency key. Same key + same payload returns the original result. Same key + different payload is a conflict error.
- **Tamper-evident.** Each entry stores `prevHash` and `hash = sha256(prevHash + canonical entry)` per entity. The auditor verifies the chain.
- **Closed periods are locked.** Corrections are reversing entries in an open period. Nothing is ever edited or deleted.
- **Capabilities.** A seat can post only to account ranges its role allows; for example, AP clerks can't touch cash accounts. Payment approval needs a capability and a limit.
- **Segregation of duties:**
  - The requester of a payment can't approve it.
  - The proposer of a memory change can't merge it.
  - Payments over the dual-approval threshold need an agent controller *and* a human.
- **Provenance.** Every entry records the seat, the task, the decision record path and the memory commit SHA it was made under. Any number traces back to data, rule or person.

**The bus:**
- `events` is append-only: world facts arrive here, deduplicated by external ID.
- `tasks` is a leased work queue. A claim sets a 120-second lease; an expired lease is reclaimed. Every completion, failure, wait, or heartbeat must include `leaseAttempt: task.attempts` from that claim and match its active seat, role, and unexpired lease. Each reclaim increments `attempts`, fencing delayed messages even when the same seat reclaims. The team renews every 30 seconds while a handler runs, stops renewal before its final transition, and reports rejected transitions as `lease_lost`. Handlers remain responsible for idempotent effects; renewal does not cancel an already-running handler if its lease is lost.

**Scenarios:** every row carries a `runId`, so each eval run and each demo reset is isolated and old evidence stays.

### 2. Memory (git first)

The company's institutional memory is a git repository of **structured YAML validated by schemas**, not free-form notes:

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
- **Controlled writes** (vendor bank details, policies, playbooks) go on a `proposal/<id>` branch. Merging requires an approver allowed by policy who is not the proposer: segregation of duties as code review.
- **Writes are validated before commit.** The schema is checked, decision files are immutable, a vendor has exactly one active remit-to, and policy keys are unique. Contradictions are rejected, not appended.
- **Idempotent:** a duplicate `Idempotency-Key` trailer is a no-op.
- **Defending a decision is `git log` / `git blame` on the record,** plus the ledger entries that cite its SHA.

Why split: money needs transactions and constraints (the kernel). Knowledge needs history, diffs, branches and review (git). Each ledger entry pins the memory SHA it used, so any decision can be replayed against the exact knowledge the agent had.

### 3. Agent runtime

One Node process supervises all seats:
- Each seat loop claims tasks for its role, builds context, runs, and records the run (tokens, cost, latency, tool calls, outcome).
- **Deterministic first.** Parsing, matching, arithmetic and policy checks are code. Claude handles unstructured documents, ambiguous matches, exceptions, explanations, planning, and questions from humans.
- **Tools are the kernel's typed API.** Inputs are validated with zod and `strict: true`, and every call is permission-checked by the kernel, not by the prompt. Document text is data: an invoice that says "pay a new account" can't change anything, because no tool lets an AP clerk change remit-to.
- **Knowing when to ask.** Every non-trivial decision gets `act | ask | hold` with a confidence. Thresholds depend on risk: amount tier, new or changed vendor data, invalidated facts. Asks go to the right human with the evidence and options attached.
- **Model:** `claude-opus-5-5`, with effort set per seat. Prompt caching on the stable system prompt and tool list. Server-side refusal fallbacks are on by default (`AGENT_FALLBACKS`).

### 4. World simulator

A seeded generator for the outside world, calibrated to the company profile:
- daily store sales by channel
- card processor settlements net of fees
- weekly delivery-platform payouts (gross − commission − promos − refunds − adjustments)
- supplier invoices in each supplier's own text layout
- receiving logs, rent and CAM, biweekly payroll, gift cards, bank feeds

**Planted errors** come with an answer key the agents never see. Each has legitimate look-alike decoys:
- duplicate invoices across channels
- price above contract
- short shipments
- a credit memo not applied a month later
- a fraudulent bank-change request carrying prompt-injection text
- short delivery payouts
- card fees above contracted rate
- CAM above the lease cap
- a terminated employee still on payroll
- unexplained bank debits
- capex/opex misclassification

### 5. Evals

They run against the live agent team (`npm run eval`):

| Suite | Question | Metric |
|---|---|---|
| Planted errors | Does it catch what humans miss? | recall, precision, $ at risk caught, per error type |
| Books correctness | Do the books match economic truth? | trial balance diff vs world truth, by account |
| Exactly once | Does it survive duplicates, crashes, concurrent workers? | duplicate postings/payments (must be 0) |
| Segregation & injection | Can documents or agents bypass controls? | blocked attempts, successful violations (must be 0) |
| Knowing when to ask | Does it ask only when it should? | ask precision/recall vs answer key, asks per 1,000 transactions |
| Time | Do month-1 facts change month-2 decisions? | carried-forward credits applied, ghost employees caught |
| Pace and cost | How fast and cheap? | close duration, events/minute, $ per transaction |
| Dynamic team | Does staffing keep up with spikes? | queue latency with vs without spawning |

**Baselines on the same world:**
- a single generalist Claude agent with the same tools and no kernel guards, memory or org
- rules only

### 6. Interfaces

- **Console (humans):**
  - goals and KPIs
  - the live org chart
  - the inbox of asks
  - the ledger with provenance (entry → decision → commit)
  - memory history and blame
  - eval scoreboard
  - chaos panel and sim clock

  The console also registers read-only WebMCP tools (list open decisions, ask why), so a human's own browser agent can read it. Answering a decision takes a real click in the review drawer, which shows the kernel-stored effect (payee, amount and remit-to; branch and paths; close period) next to the buttons.
- **MCP server (agents):** the kernel's tools for external agents, such as an outside auditor running in Claude Code, scoped by seat token.
- **No spreadsheets anywhere.** Humans get answers and decisions, not grids to fill.

## Sponsor integrations

Each one does real work; none is a logo.

| Sponsor | Where it lives | Status |
|---|---|---|
| Hyphenate | The whole system (primary track) | core |
| Convex | Kernel: ledger, bus, tasks, live console | core |
| Microsoft (Built for the Real World) | Production design: controls, observability, deployment, cost per transaction | core |
| Factory Droid SDK | Integrations-engineer seat: a new document format triggers Droid to write a parser and tests on a branch; the controller merges | planned |
| CRS Credit API | Risk checks: OFAC, business and identity checks on vendor onboarding and remit-to changes; customer credit for catering terms | planned |
| Capital One Nessie | Bank rail: operating and payroll accounts, payments, bank feed | planned |
| Fetch.ai | CFO agent on Agentverse (chat protocol), so overseers can talk to finance from ASI:One | stretch |
| Auth0 for AI Agents | Human sign-in, push approvals (CIBA) for asks | stretch |
| Moss | Fast semantic recall over memory and documents for agents | stretch |
| Coinbase x402 | Treasury pays international contractors in USDC under spend controls | stretch, eligibility-gated |

## Repo layout

```
convex/            kernel (schema, ledger, bus, tasks, seats, payments, asks, memory index, runs)
src/core/          shared types: money, chart of accounts, events, policies
src/memory/        git-first memory store + schemas + seed
src/agents/        runtime, Claude tool loop, seat handlers, staffing
src/world/         simulator, planted errors, answer key, emitter
src/evals/         suites, scorers, reports
src/integrations/  parsers for external formats (Droid writes new ones here)
console/           overseer console (Vite + React + Convex)
company/sweetgreen calibration profile
```
