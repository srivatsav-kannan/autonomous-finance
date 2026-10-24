# Hallmark integration

[Hallmark](https://github.com/Nutlope/hallmark) is an agent design skill and visual
linter, not a runtime component library. Its unmodified skill is checked into
`.agents/skills/hallmark` so collaborators can use the same references and checks.
The pinned revision and MIT license are recorded in that directory.

The finance frontend applies Hallmark's **app screen** workflow using the existing
warm paper and green brand. `design.md` documents the shared system;
`console/src/tokens.css` holds its colours, typography, spacing, and dark palette.
No Hallmark JavaScript or third-party font requests are shipped to users.

## Work on the frontend

The project-local skill is available to Codex on the next turn. Invoke it by name,
for example `$hallmark audit console`, or `$hallmark redesign console`. Other
agents can read `.agents/skills/hallmark/SKILL.md` directly. Keep the app scope and
the locked design system; retain all existing facts and financial actions.

```bash
npm install
npm run typecheck
npm run build:console
npm run design:check

# Start the backend and gateway as described in README, then:
npm run console
npm run design:review -- --url http://127.0.0.1:5173
```

Rendered checks use the development dependency `puppeteer-core` and a local
Chrome/Chromium installation. If Chrome is not installed in a standard location,
set `CHROME_PATH` to its executable. Static checks need only Node. Rendered output
and comparison images live under `.hallmark/` and are ignored by git.

For a concrete scenario and view, retain the existing scenario hash and add a view:
`http://127.0.0.1:5173/?view=ledger#your-run-id`. View values are `inbox`, `org`,
`activity`, `ledger`, `memory`, `evals`, `control`, `bank`, and `flow`.

For a redesign, capture the baseline before editing:

```bash
npm run design:review -- --before --url http://127.0.0.1:5173
# After editing:
npm run design:review -- --kept --url http://127.0.0.1:5173
```

`--kept` checks the earlier control inventory and generates `.hallmark/compare.html`.
Source-level event inventories need review when a handler moves: in this redesign,
Ask moved from a button click to the form submit event so Enter works too. The
same gateway request remains, and this is recorded in the stylesheet stamp.

## Updating the skill

Review upstream changes, then replace the vendored `skills/hallmark` directory
from an explicit Git commit. Preserve the MIT license and update `UPSTREAM.md`.
Run the project checks and the rendered sweep before accepting updated gates.
Do not run an unpinned install during application builds.

## Design canvas and review workflow

The [editable Figma workspace](https://www.figma.com/design/qUwizlNQktZ68GJjaoKUo5?node-id=2-22)
contains native inbox, review-drawer, Bank & cash, and Finance flow frames,
reusable controls, design tokens, and prototype links. Its figures are a snapshot of the local
`finance-workbench` simulation. The canvas is a design reference; changes do not
synchronize automatically with React. Figma uses Inter as the available fallback
for the app's system font.

The Ramp-inspired app shell uses the existing green brand with a neutral sidebar
and white workspace. Inbox status filters, search and sort persist in the URL as
`inboxFilter`, `inboxSearch` and `inboxSort`; the ledger uses `ledgerView` and
`ledgerSearch`. An individual request opens in a keyboard-accessible review drawer.
Decision evidence reads the existing memory gateway, and response options retain
their original gateway semantics. Answered requests remain under **Answered**.

The ledger exports the currently filtered journal entries or trial balance as CSV.
Journal data is still limited to the most recent 60 entries; the screen reports
that limit separately from the scenario's full hash-chain count.

## Bank and finance flow

Bank & cash reads the complete run through `bank.workspace`: three cash-account
book balances, a journal-derived balance history, bank events, matching payments,
agent results and related requests. Original entries and their reversals both
contribute to the history. A posted entry is **Recorded**; **Reconciled** requires
an explicit completed match and agreeing payment/accounting evidence. Invalid
bank payloads are excluded with a visible count. No real bank is connected.

The bank uses `bankAccount`, `bankFilter`, and `bankSearch` URL parameters.
Transaction drawers reuse the source evidence reader and can open human requests
through the inbox's `ask` parameter, regardless of the current inbox filter.
The Finance flow map uses `flowStage` to reveal source records, specialist teams,
control checks, and books/payments. Its counts come from existing run queries;
its arrows describe system responsibilities rather than a traced transaction.

Bank aggregation tests cover signs, reversals, derived opening balances, malformed
payloads, run isolation, match status, request recipients, and complete history.
The read model collects a full simulation run; very large production datasets
would need server-side aggregates and pagination before adopting this pattern.

The new Bank & cash and Finance flow Figma frames are draft references. Browser
review found black fills on some neutral controls and missing currency formatting;
the Figma Starter MCP quota blocked the correction. These issues are confined to
the canvas and do not appear in the verified React app. After quota is available,
set explicit panel-color fallback paints and format money with grouping and two
decimals, then inspect both native frames again.
