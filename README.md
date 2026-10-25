# Autonomous Finance

Agents run the finance function of a simulated restaurant chain: accounts payable, payments, cash application, revenue, payroll, leases and the month-end close. Humans set policy and make the decisions that policy reserves for them.

We call it **agent-native**: the systems underneath are built for agents to use, not adapted from tools built for people. Three parts carry that:
- **Ledger and controls (`convex/`):** a Convex database where every money change is a transaction with double entry in integer cents, idempotency keys, a hash chain and per-seat permissions. The rules are enforced in the database, not in prompts.
- **Memory (`src/memory/`):** company knowledge is schema-checked YAML in a git repository. Each change is a commit by the agent that made it; sensitive changes go through a branch that a different agent or human must merge.
- **Agents (`src/agents/`):** twelve seats (AP clerk, controller, payments, treasury and others), each with its own identity, limits and manager. Routine work is plain code; the model reads unfamiliar documents and handles judgment calls.

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

## What you'll see

- **`npm run scenario`** plays 14 simulated days for 3 stores: 230 events, 64 vendor invoices, 13 planted errors and 3 legitimate look-alikes. It scores the run against an answer key the agents never see and prints a briefing: what happened, which planted errors were caught, what waits for a human, and why the close is blocked.
- **The console** (`npm run console`) has these views:
  - **Inbox:** only the decisions a human must make, each with a review drawer showing the evidence and the exact effect of each answer.
  - **Bank & cash** and **Finance flow:** cash balances, the bank feed, and how sources move through agents and controls into the books.
  - **Team, Live activity, Ledger, Memory:** the seats, every agent action, journal entries with provenance, and memory commits.
  - **Evals:** the scenario's score.
  - **Control room:** inject a duplicate invoice, a bank debit or a fraudulent bank change, then ask why.
  - **Invoices:** a separate customer-invoice workspace ([guide](docs/invoice-mvp/README.md)).
  - **`/ap-demo`:** human approval for the payment recovery demo.
- **`npm run ask`** answers "why" questions from the record, citing decision commits.
- **`npm run evals`** prints one table and writes reports to `var/evals/`.

Headline numbers, all from [docs/RESULTS.md](docs/RESULTS.md):
- On 4 seeds of the simulated company, 13 of 13 planted errors caught, books correct, $0.04–0.05 per run.
- Same model, same 11 tasks: our typed kernel tools used 12 tool calls and $0.12; spreadsheet tools used 71 tool calls and $0.48.
- On 15 public benchmark tasks, our team scored 93.3% mean (14 of 15) and the same model alone 84.0% (12 of 15), at about 1.7× the cost.
- 20 of 20 control tests hold.

## Prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node 24.18 or later | everything | `package.json` engines; CI uses 24.18.0. FakeBank uses `node:sqlite`. |
| git | company memory | each run's memory is a git repository under `var/memory/` |
| Python 3.11 or later | `npm run setup` benchmark data, `npm run bench:*`, `npm run evals` | `setup` creates `var/benchmarks/.venv` and installs `scripts/external-bench/requirements.txt` (openpyxl, pypdf, python-docx). `EXTERNAL_BENCH_PYTHON` picks another interpreter. `setup -- --skip-bench` skips this. |
| `uv` and Python 3.12 | only the model-only harnesses: `evals/external/finbalance`, `evals/external/dabstep` (`uv run --with pandas`), `evals/invoice-mvp` (`pypdf==6.21.2`) | not needed for the quick start; see each harness README |
| Playwright Chromium | `npm run test:browser:local` | `npx playwright install --with-deps chromium` |
| Chrome or Chromium | `npm run design:review` | set `CHROME_PATH` if it is not in a standard location |

API keys go in `.env.local`, which git ignores. With `OPENAI_API_KEY`, agents use OpenAI `gpt-6.1-sol`, capped by `AGENT_MAX_USD` (default $15, tracked in `var/agent-spend.json`). Without it they fall back to Claude if `ANTHROPIC_API_KEY` is set; **that path has no spend cap** ([AUDIT.md](docs/AUDIT.md) P1-5). `AGENT_LLM=off` turns inference off everywhere.

## Repo map

| Folder | What |
|---|---|
| `convex/` | The kernel: ledger, bills, payments, tasks, seats, asks, invoice cases, observability |
| `src/` | Application code: `agents/` (runtime and seats), `memory/` (git memory), `world/` (simulator and answer key), `evals/` (scorers and benchmarks), `payments/` (AP dispatcher and evidence worker), `integrations/` (parsers, FakeBank, Increase adapter), `human/` (gateway, ask why), `invoice-mvp/` (invoice workspace), `core/` (shared types and clients) |
| `console/` | Overseer console: Vite, React, Convex live queries, WebMCP tools |
| `scripts/` | npm script entry points: setup, scenario, evals, AP demo and workers, smoke checks; `testing/` holds CI and browser runners; `external-bench/` the Python benchmark readers |
| `tests/` | Vitest suites for the kernel, payments, gateway, setup and console |
| `evals/` | Harnesses for outside benchmarks run with the model alone (`external/`) and for the invoice workspace (`invoice-mvp/`) |
| `benchmarks/` | Pinned external benchmark manifests and the model and budget policy |
| `company/` | The Sweetgreen calibration profile |
| `docs/` | Results, demo plan, architecture, audit and per-topic guides (below) |
| `.github/workflows/` | CI: typechecks, tests, console build, payment recovery and browser checks |
| `.agents/` | Vendored Hallmark design skill, used by `npm run design:check` ([design.md](design.md)) |

## Docs

| Doc | What |
|---|---|
| [docs/RESULTS.md](docs/RESULTS.md) | Every measured number, with links to raw output |
| [docs/DEMO.md](docs/DEMO.md) | The 3-minute demo, runbook and Q&A prep |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built: kernel, memory, agents, payments, simulator, evals, console |
| [docs/AUDIT.md](docs/AUDIT.md) | Known bugs and gaps, by severity |
| [docs/ap-demo/](docs/ap-demo/README.md) | AP payments: approval, dispatch, bank evidence, crash recovery |
| [docs/evals/](docs/evals/README.md) | External benchmark setup, the books and close checks, raw run data |
| [docs/invoice-mvp/](docs/invoice-mvp/README.md) | The invoice workspace |
| [docs/ci.md](docs/ci.md) | CI jobs and the local recovery gate |
| [design.md](design.md) | Console design system and Hallmark checks |

## Setup and evals reference

**`npm run setup`** (`scripts/setup.ts`) is idempotent. It checks Node 24.18+, Python 3.11+ and git; creates `.env.local` from `.env.example` if missing, or appends only the settings it lacks; generates `KERNEL_ADMIN_SECRET` if it is missing, empty or `change-me`; generates `VITE_GATEWAY_TOKEN` if missing (`npm run gateway:token` rotates it); creates `var/benchmarks/.venv`, installs the readers and prepares both benchmark batches (`bench:prepare -- --batch eight` and `--batch extra`). It never prints secrets. `--skip-bench` skips the benchmark data.

**`npm run backend:configure`** (`scripts/backend-configure.ts`) runs once the backend is up, and again after a backend reset. It sets `KERNEL_ADMIN_SECRET` (from `.env.local`) and `AP_HUMAN_AUTH_ISSUER` / `AP_HUMAN_AUTH_AUDIENCE` (local placeholders `https://ap-demo.invalid` / `ap-demo`, unless `.env.local` sets them) with `npx convex env set`, passing values on stdin. It points `CONVEX_URL` and `VITE_CONVEX_URL` at the running local backend, then waits until the deployment accepts the admin secret. On a fresh deployment the first `npm run backend` deploy reports missing auth configuration until this runs; the backend keeps running. To run a second checkout beside another one, give its backend other ports: `npm run backend -- --local-cloud-port 3410 --local-site-port 3411`.

**`npm run scenario`** (`scripts/scenario.ts`) creates run `scenario-1`, plays the 14 days with no pacing, sends the period end, waits for the agents to finish, scores the run against the answer key (`var/evals/scenario-1.md`, also shown in the console's Evals view) and prints a briefing. Rerunning prints the briefing again; an interrupted run resumes. `--run scenario-2` starts a separate run, for example after adding a model key.

**`npm run ask -- "question" [--run id]`** (`scripts/ask.ts`) answers from the record with the same code as the console's "Ask why" (`src/human/why.ts`). With a model it runs the cited-answer tool loop over git memory and the ledger. Without one it ranks decision commits by the question's keywords and lists them with their SHAs; that path reads only git memory, so it needs no backend.

**`npm run evals`** (`scripts/evals.ts`) runs, in order, with inference off: the 20 control tests, the world on seed 7, the spreadsheet-vs-kernel benchmark, and all 15 external tasks in rules-only mode. It needs the backend. Output goes to `var/evals/suite-<time>/`, the table to `var/evals/summary-<time>.md`; the committed `docs/evals/` files are not touched. The model-off world catches the planted errors but its books fail, because the unread invoices have no bills; the table says so.

**`--paid --budget-usd N`** adds the world on seeds 7, 11, 23 and 42, the agent spreadsheet comparison, and full team vs generalist on all 15 external tasks (30 turns, APEX judge). It refuses to start without `--budget-usd` or `OPENAI_API_KEY`. The budget is split 2.5% per world seed, 15% to the spreadsheet comparison and 75% to the external benchmarks; each run stops at its share. It prints the per-run estimate and cap first, then writes a one-time approved copy of `benchmarks/external-models.json` to `var/external-models.evals-<time>.json`, capped at the external share. The checked-in policy stays `approval: null`. Model spend for everything in [docs/RESULTS.md](docs/RESULTS.md) was $10.59.

### Other commands

The human gateway and console:

```bash
npm run gateway        # human gateway on :8787; holds the human CFO seat token
npm run console        # http://127.0.0.1:5173
npm run gateway:token  # rotate the shared token; restart gateway and console afterwards
```

The gateway reads `var/runs/<run>/seats.json`, so it needs a run created by `npm run scenario`, `npm run world` or `npm run eval` first. Every request must carry `VITE_GATEWAY_TOKEN` in an `x-gateway-token` header; the console reads the same value from `.env.local`. Browser requests are accepted only from `http://127.0.0.1:5173` and `http://localhost:5173` (`GATEWAY_ALLOWED_ORIGINS` changes that), and POSTs must be JSON. The gateway refuses to start without a token of at least 32 characters.

Answering an ask in the console records the answer in the kernel first, then runs its effect (approve or void a payment, co-sign a close, merge a proposal), then completes the ask. A different answer to the same ask is refused. If an effect fails, the ask stays open with its answer recorded; choosing the same answer again resumes it.

The world and agents in real time, and single scored runs:

```bash
npm run world -- --run demo --stores 3 --days 14 --pace 3000
npm run agents -- --run demo
npm run eval -- --stores 3 --days 14 --seed 7    # one scored run; reports in var/evals/
npm run controls                                 # the 20 control tests
npm run smoke                                    # kernel and memory invariant checks against the live backend
```

`npm run eval` writes its Markdown and JSON reports before exiting. A failed or incomplete books result exits nonzero; unread invoices never count as correct books or permit close ([books and close checks](docs/evals/close-correctness.md)). The agent team cannot submit bank payments; it only requests them.

The AP payment recovery demo (a lost bank response, a killed dispatcher, one transfer and one journal entry):

```bash
npm run demo:local
npm run demo:local -- --browser-approval   # approve in /ap-demo first
```

`demo:local` reuses the `KERNEL_ADMIN_SECRET` in `.env.local`. See the [AP payments guide](docs/ap-demo/README.md); `npm run demo:sandbox` runs against the Increase sandbox and needs credentials.

External benchmarks one at a time: `npm run bench:run -- --dry-run` shows the matrix and `npm run bench:run -- --modes rules-only --repeats 1 --judge off` runs the free baseline ([guide](docs/evals/external-benchmarks.md)). Paid runs need an approved policy file; a key alone does not enable spend.

Checks that need no backend:

```bash
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm test
npm run build:console
npm run design:check
```

## Team

| Person | Owns |
|---|---|
| Srivatsav | Agent runtime, model paths, integrations engineer, WebMCP |
| JJ | Evals and decision quality |
| Arav | Kernel and sponsor rails |
| Arav's friend | Console, demo, submission |
