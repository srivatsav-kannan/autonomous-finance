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
`activity`, `ledger`, `memory`, `evals`, and `control`.

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
