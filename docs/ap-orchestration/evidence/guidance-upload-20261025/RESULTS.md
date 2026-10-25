# Actual local acceptance evidence — 2026-10-25

- Base: #118 at 396d6b13312bfe944affcb2e8fb7ff741de69c84. New isolated clone and dedicated run `ap97-b3-guidance-20261025-v1`.
- B: case `kh77h1gxbc75v89h309t76c8ch8gym3g`, revision 1, USD 85; expected/observed suggestion **5000 / 100% sf-hayes-valley**.
- C: case `kh72sw1qsz72ekas0z0rb4sw5s8gymct`, revision 1, USD 2,500; expected/observed **held, no coding**, category `capital_renovation` differs from approved `routine_cleaning`. Owner `field-reviewer`, source-inspection/reclassification next action retained.
- B SHA-256: `5625aced790227416eac8a634746d9052e2f2d46c2c7a1b6e365ee4eadc1f1f8`.
- C SHA-256: `231787ec8bc8a433aab6139ad21178b9610e3ba78c74db2692b0870b5a82c103`.
- Shared approved immutable rule version 1: `n5772w410xx43q18h7r5d3prmd8gynsr`. Full hash, scope, simulated governor review, policy hash and authored history are in `browser-results.json`.
- Both PDFs uploaded through the application file input; API → real Convex case → saved guidance → UI verified. Original page previews inspected, downloads hashed against retained bindings.
- Refresh preserved complete guidance JSON exactly. Gateway and dedicated Convex backend were stopped/restarted; exact saved advice and idempotent recheck persisted (`restart-results.json`). Repeated browser uploads retained exactly 2 cases.
- Zero case bills, journals, payments or dispatch commands. The isolated backend tables demoBills, journalEntries, demoVersions and demoCommands were also each verified empty via the Convex CLI (financial-tables.json). No banking/accounting provider calls or payment worker. Existing accepted payment environments untouched.
- Typecheck (application/backend/tests) and console production build passed. Local targeted regression: **82 tests passed across 7 files (80 in the combined run, plus 2 added origin-boundary tests)**, including real Poppler/durable-intake integration and AP worker/intake controls. No CI run.
- Design checks ran and remain blocked by 9 pre-existing `proof.css` failures; no new guidance-file failures. Captures include desktop 1440px/mobile 390px, light/dark. Build emits the existing large chunk advisory.

`B-guidance.png` / `C-guidance.png`: saved proposal/hold and explanation. `B-original.png` / `C-original.png`: uploaded PDF page previews. `C-{light,dark}-{1440,390}.png`: full application screenshots. `browser-results.json`: exact case/source/rule/review bindings, observed states and refresh checks. `restart-results.json`: post-restart exact reads/reruns and zero case financial effects.

A remains an authored synthetic text/history seed, not a completed PDF-backed human correction. Parser is a bounded one-page labeled text-PDF adapter; no live model, Claude or practitioner approval is claimed. B/C completion does not close #102.
