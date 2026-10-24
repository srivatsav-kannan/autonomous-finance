# Autonomous Finance console

The console is a warm, precise finance workbench for human overseers. The real
objects are decisions, evidence, account balances, journal entries, and agent
records. Keep all figures attached to the selected simulation.

## System

- Source of truth: `console/src/tokens.css`. Preserve the existing green
  (`--accent: #1f6f4a`) and warm background (`--bg: #f6f5f1`).
- Light and automatic dark palettes use semantic roles. Colour and font literals
  belong in the token block. Use the shared spacing tokens.
- System sans for headings, body, labels, and controls; monospace only for actual
  code, hashes, and record content. Financial values use tabular numerals.
- A capped 1440px shell, one sidebar for the existing seven views, and a view
  selector below 960px. The sidebar never squeezes a phone's main content.
- Cash, accounts payable, and revenue lead. Operational counts are secondary.
- Decision records are separated by rules. Evidence is attached to each decision.
  Do not add card grids, decorative charts, fake balances, or testimonial content.
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
