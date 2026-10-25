# Autonomous Finance console

The console is a warm, precise finance workbench for human overseers. The real
objects are decisions, evidence, account balances, journal entries, and agent
records. Keep all figures attached to the selected simulation.

## System

- Source of truth: `console/src/tokens.css`. Preserve the existing green
  (`--accent: #1f6f4a`), warm navigation (`--bg: #f6f5f1`), and white workspace
  (`--panel: #ffffff`). Ramp screenshots supplied by the user guide density and
  interactions; this remains Autonomous Finance, with its own brand and real data.
- Light and automatic dark palettes use semantic roles. Colour and font literals
  belong in the token block. Use the shared spacing tokens.
- System sans for headings, body, labels, and controls; monospace only for actual
  code, hashes, and record content. Financial values use tabular numerals.
- A persistent 224px sidebar for Invoices and the nine simulation views, with a white main workspace.
  Content caps at 1600px. Below 960px, a view selector replaces the sidebar.
  Scenario selection stays in the top bar on simulation views and is reflected in the URL.
  Invoices shows its own company, workspace ID and runtime mode. Its HTTP gateway
  determines the invoice workspace; changing the simulation scenario never changes
  invoice totals. Invoice review uses the shared modal drawer, semantic tokens,
  labelled mobile table rows and automatic dark palette.
- Cash, accounts payable, and revenue lead on the original operational views.
  Bank & cash and Finance flow have their own focused summaries. Operational counts live in an
  accessible Simulation activity disclosure, with the simulation date visible.
- The inbox uses underlined status filters, search, sort, and compact decision
  rows. Each row opens a native modal drawer with the full request, real source
  evidence, and actions anchored at the bottom. Escape and close restore focus.
  Source decision records load from the human gateway. A response succeeds only
  after the gateway accepts it; completed records remain in Answered.
- The ledger has searchable Journal entries and Trial balance views. CSV export
  contains the visible filtered records and protects text from formula execution.
- Bank & cash shows the three ledger cash accounts, dated book-balance history,
  and the complete simulated bank feed. Account, status and search filters persist
  in the URL. Transaction drawers link journal evidence and human inbox requests.
  Recorded and reconciled are separate states; book balances are never presented
  as bank-confirmed available funds. Charts space dates by elapsed time.
- Finance flow connects source records, specialist agents, control checks and
  books/payments. The stage selector reveals responsibilities and real scenario
  counts. Arrows explain the system, not individual transaction traces.
- Use density and progressive disclosure for richness. Do not add decorative
  charts, fake balances, unconnected payment controls, or testimonial content.
- Labels use sentence case. Headings state the task. Preserve the simulated-company
  disclaimer, concrete financial facts, query arguments, and action semantics.
- Buttons have a 44px minimum target, instant focus rings, disabled and busy states.
  Keep reduced-motion support. Use proper labels and keyboard-accessible controls.
- Wide tables become labelled rows on phones. Keep every amount, reference, and
  action accessible. A technical record viewer may scroll horizontally.
- Loading is distinct from empty data. Gateway failures stay visible near the
  action. Never show success before a successful response.

## Hallmark

This system was developed with [Hallmark](https://github.com/Nutlope/hallmark) 2.0.0's app-screen workflow. Hallmark is an agent design skill and visual linter, not a runtime library. The preserved brand takes precedence over a catalog theme. No Hallmark JavaScript or third-party fonts ship to users.

The unmodified skill is vendored at `.agents/skills/hallmark/` (pinned revision and MIT license in `UPSTREAM.md` there). It stays at that path because Codex discovers project skills under `.agents/skills/` and `npm run design:check` runs its `scripts/sloplint.mjs`. Nothing at runtime or in CI uses it, and Vite does not import it. Invoke it by name in Codex (`$hallmark audit console`); other agents can read `.agents/skills/hallmark/SKILL.md`.

```bash
npm run build:console
npm run design:check                                        # static lint, Node only
npm run design:review -- --url http://127.0.0.1:5173        # rendered checks; console must be running
```

Rendered checks use the dev dependency `puppeteer-core` and a local Chrome or Chromium (set `CHROME_PATH` if it is not in a standard location). Output goes to `.hallmark/`, which git ignores except `log.json`, `preflight.json` and `verification.json`. To check one view, keep the scenario hash and add a view: `http://127.0.0.1:5173/?view=ledger#your-run-id`. Views: `inbox`, `org`, `activity`, `ledger`, `memory`, `evals`, `control`, `bank`, `flow`.

For a redesign, capture a baseline first with `npm run design:review -- --before --url ...`, then after editing run `--kept`, which checks the earlier control inventory and writes `.hallmark/compare.html`.

To update the skill, replace `.agents/skills/hallmark` from an explicit upstream commit, keep the MIT license, update `UPSTREAM.md`, and rerun the checks. Do not run an unpinned install during builds.

## Console behavior notes

- Inbox filters, search and sort persist in the URL as `inboxFilter`, `inboxSearch` and `inboxSort`; the ledger uses `ledgerView` and `ledgerSearch`; Bank & cash uses `bankAccount`, `bankFilter` and `bankSearch`; Finance flow uses `flowStage`.
- The ledger exports the filtered journal entries or trial balance as CSV. Journal data is limited to the most recent 60 entries; the screen reports that limit next to the scenario's full hash-chain count.
- Bank & cash reads the whole run through `bank.workspace`. A posted entry is **Recorded**; **Reconciled** needs a completed match and agreeing payment and accounting evidence. Invalid bank payloads are excluded with a visible count. No real bank is connected. The read model loads a full simulation run; large production data would need server-side aggregates and pagination.
- Finance flow counts come from existing run queries; its arrows describe responsibilities, not a traced transaction.

## Editable design workspace

The native Figma reference lives at
[Autonomous Finance — Finance workbench](https://www.figma.com/design/qUwizlNQktZ68GJjaoKUo5).
It illustrates the inbox, review drawer, Bank & cash, and Finance flow using real
simulation snapshots.
The React implementation remains the runtime source of truth. Figma uses Inter
as an available fallback for the app’s system sans. Design edits require an
explicit implementation pass; the canvas is not automatically synchronized.
The Bank & cash and Finance flow frames are drafts: some neutral controls have
black fills and money lacks grouping and two decimals. These issues are in the
canvas only, not the React app.
