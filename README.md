# Autonomous Finance

**An agent-native finance department.** Agents run the entire finance function of a real-world company: AP, payments, cash application, revenue, payroll, leases, close, audit. Humans set goals and policy and make the calls that matter.

The infrastructure underneath is rebuilt for agents, not humans:
- **Ledger:** idempotent, double-entry and hash-chained.
- **Controls:** segregation of duties enforced by the kernel, not by prompts.
- **Memory:** git, not a pile of notes.

Built at Cal Hacks 13.0 for the Hyphenate track, *The Hyphenated Enterprise: Autonomous Systems for Finance*.

> The company is **Sweetgreen, Inc.** (NYSE: SG), simulated and calibrated to its FY2025 SEC filings: $679.5M revenue, 281 restaurants, $19.9M AP, $7.2M gift card liability, $354.5M lease liability. Not affiliated with Sweetgreen. All transactions, counterparties and people are simulated.

## What's different

- **The whole finance org, not one seat.**
  - Thirteen seats with distinct identities, limits and managers, from AP and AR clerks to an independent auditor.
  - The CFO agent hires extra AP clerks when queues back up.
  - Humans sit at the top as overseers.
- **Built for agent pace.**
  - Agents talk to typed APIs and events, not spreadsheets.
  - Fourteen simulated days run in under 20 seconds, with books that match economic truth to the cent.
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
- **Agents write their own integrations.** When a supplier sends a format nobody can parse, Claude reads it once. The integrations engineer then writes a parser, tests it and proposes it. The controller merges it, and from then on it runs deterministically in a sandbox.
- **Proof, not vibes** (`npm run eval`). A seeded world with planted errors and an answer key the agents never see. It's scored on:
  - catches, decoys and false alarms
  - books vs truth
  - controls
  - human load, coverage and cost

## Run it

Requires Node 22+.

```bash
npm install
npm run backend                       # local Convex (no account needed); keep it running
```

In a second terminal, set the admin secret once. Put the same value in `.env.local`:

```bash
npx convex env set KERNEL_ADMIN_SECRET "$(openssl rand -hex 24)"
```

Add `ANTHROPIC_API_KEY=...` to `.env.local` to turn on Claude. Without it, the team runs its deterministic paths only.

```bash
npm run smoke                          # 42 invariant checks on the kernel and memory
npm run eval -- --stores 3 --days 14   # full scored run; add --chaos 0.3 to re-deliver 30% of events
npm run gateway                        # human gateway on :8787 (holds the human CFO seat token)
npm run console                        # overseer console on http://127.0.0.1:5173
```

Live demo with the world playing in real time:

```bash
npm run world -- --run demo --stores 3 --days 14 --pace 3000
npm run agents -- --run demo
```

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

## Layout

| Path | What |
|---|---|
| `convex/` | Kernel: ledger, bills, payments, tasks, seats, asks, observability |
| `src/memory/` | Git-first memory store, schemas, day-zero seed |
| `src/agents/` | Runtime, Claude tool loop, seat handlers, staffing |
| `src/world/` | World simulator, planted errors, answer key, simulated bank, callback oracle |
| `src/integrations/` | Invoice parsers (built-in + sandboxed agent-written) |
| `src/evals/` | Scorer and end-to-end eval runner |
| `src/human/` | Human gateway for the console |
| `console/` | Overseer console (React + Convex live queries + WebMCP tools) |
| `company/sweetgreen/` | Calibration profile from SEC filings |
| `docs/` | Architecture, team plan |

`npm run world` and `npm run eval` create and seed company memory automatically
for each new scenario in `var/memory/<run-id>.git`. No separate memory initialization
command is needed; the obsolete `memory:init` script has been removed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TEAM.md](docs/TEAM.md).
