# Finance console

Read `../design.md` before visual changes. Keep the React/Convex architecture,
all seven console views, scenario routing, gateway actions, and WebMCP tools.
Never fabricate balances, activity, approvals, or evaluation results.

Hallmark is vendored at `../.agents/skills/hallmark/SKILL.md`. For a requested
Hallmark redesign or audit, use its **app screen** scope and the locked project
system in `../design.md`. Do not apply marketing-page hero or photography rules
to this working console. Ordinary feature edits should follow the existing system.

Run `npm run typecheck`, `npm run build:console`, and `npm run design:check`.
Use `npm run design:review -- --url <running-console-url>` for visual verification.
Check all affected views at phone and desktop widths and in light and dark modes.
