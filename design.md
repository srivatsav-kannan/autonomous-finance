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
- A persistent 224px sidebar for the seven views and a white main workspace.
  Content caps at 1600px. Below 960px, a view selector replaces the sidebar.
  Scenario selection stays in the top bar and is reflected in the URL.
- Cash, accounts payable, and revenue lead. Operational counts live in an
  accessible Simulation activity disclosure, with the simulation date visible.
- The inbox uses underlined status filters, search, sort, and compact decision
  rows. Each row opens a native modal drawer with the full request, real source
  evidence, and actions anchored at the bottom. Escape and close restore focus.
  Source decision records load from the human gateway. A response succeeds only
  after the gateway accepts it; completed records remain in Answered.
- The ledger has searchable Journal entries and Trial balance views. CSV export
  contains the visible filtered records and protects text from formula execution.
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

This system was developed with Hallmark 2.0.0's app-screen workflow. The preserved
brand takes precedence over a catalog theme. Run `npm run design:check` after
frontend edits and `npm run design:review -- --url http://127.0.0.1:5173` with the
console running for rendered checks. Details are in `docs/HALLMARK.md`.

## Editable design workspace

The native Figma reference lives at
[Autonomous Finance — Finance workbench](https://www.figma.com/design/qUwizlNQktZ68GJjaoKUo5).
It illustrates the inbox and review drawer using a real simulation snapshot.
The React implementation remains the runtime source of truth. Figma uses Inter
as an available fallback for the app’s system sans. Design edits require an
explicit implementation pass; the canvas is not automatically synchronized.
