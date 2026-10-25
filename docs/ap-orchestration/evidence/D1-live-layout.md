# D1 live-data layout correction

Date: 2026-10-25. Branch: `codex/ap-system-ui-live`. Base: `67b8e21f1a6c3c40f6ed12c0f6adc4e3a3cb6538`.
Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Contract: `ap-evidence-v1`.

This is a bounded D1 UI correction. It does not constitute I1, D2, practitioner, accounting, or payment acceptance. No case approval, payment, upload, or backend mutation was performed. Integration UI 5190 and service 8823 were not restarted. The canonical plan registry was not edited.

## Change

The 35-field case previously stacked every field above the original at <=1200px. Desktop now keeps a searchable, independently scrolling field list beside the original, capped at `min(52vh, 520px)`. At <=1000px, a labelled native select replaces that list. The selected label and normalized value are repeated immediately above the original. Same-source/page/frame selections retain the loaded page and change only evidence overlays; changes to source revision/hash/page/frame remount the page viewer.

Camel-case fields become readable names, with line context retained. Numeric `*Cents` values use the existing USD formatter: total 67860 becomes $678.60, unit price 3850 becomes $38.50, and zero remains $0.00. Raw quotes remain unchanged; technical field paths appear in provenance. Native/derived/unresolved labels and coarse-context semantics are preserved.

Master additionally assigned `APSystemWorkspace.tsx` after observing a direct-link session race. Detail requests and upload now wait for a successful `GET /cases` in the current refresh generation. Rendering requires matching generation and case identity. Failed/aborted old requests cannot restore stale detail or unlock upload; list failure ends loading explicitly. An already-open upload form also rejects submission until the connection is ready.

## Read-only live case and browser evidence

All UI actions and screenshots used CUA in agent-owned Chrome tab 2141850908 on the isolated preview 5191. The actual case was read from service 8823:

- Case `js7dsh0qwptbgg2ngm9vgbt6bs8gy13s`, revision 1, 35 distinct evidence fields.
- Source `invoice.pdf`, source revision 1, SHA256 `a6c745ac1f33d32ab142f8da420ba82af3590eb36a3897c39d7537d1c0a1eb83`.
- The original itself is labelled synthetic engineering material. Screenshots contain that synthetic source and application UI only, with no credentials or unrelated browser content.
- Effective CSS viewports were measured from the page: 1164x900 desktop, 800x1000 tablet, 400x844 phone. Chrome viewport/capture scaling required a 0.75 conversion for CUA capture coordinates; evidence crops preserve the actual CSS dimensions. Temporary viewport overrides were reset.
- At 1164px, the field region measured 468px tall versus 3857px scroll content. Selecting the final field, Line 4 / Amount, kept both the selected row and native raster visible. Search for `unit price` exposed four results; selection displayed the exact amount and native region. A same-page selection preserved the identical blob URL, confirming no raster reload/flicker.
- At 400px and 800px, the list was hidden and all 35 options remained accessible through the native selector. No horizontal document overflow was observed. Selected field, original, and exact quote fit together in the captured evidence area.

Dark screenshots are **appearance fixtures**: the temporary5191 Vite harness applied the existing dark token block from `tokens.css`, without changing source styles or OS preferences. They verify the component palette and layout, not automatic system-media switching. The real case and original were still read-only live responses. Standalone Playwright/Puppeteer was not used; the rendered Hallmark command was replaced by CUA verification under the explicit task constraint.

| Evidence | Context |
| --- | --- |
| [Desktop light](D1-live-layout/desktop-1164-light.png) | All 35 fields, last field selected, native original alongside |
| [Phone light](D1-live-layout/phone-400-light.png) | Compact selector and complete native page |
| [Desktop dark appearance fixture](D1-live-layout/desktop-1164-dark-appearance-fixture.png) | Search results and unit price selection |
| [Tablet dark appearance fixture](D1-live-layout/tablet-800-dark-appearance-fixture.png) | Compact selector, total, original, exact quote |
| [Phone dark appearance fixture](D1-live-layout/phone-400-dark-appearance-fixture.png) | Total amount, native highlight, unchanged quote |
| [Session failure fixture](D1-live-layout/session-failure-fixture.png) | Explicit failed connection, no old case, disabled open upload form |

## Session regression fixture

Temporary middleware in `/private/tmp/ap-layout.vite.config.mjs` on own preview 5191 intercepted only read endpoints, blocked all non-GET requests, and used a captured 35-field case response. It returned no original raster during session tests, explicitly reporting preview unavailable. These are component/session-fixture results, not integrated workflow proof.

1. Cold direct link: list delayed 8000ms and set a new fixture cookie. While pending, only `list-start` was logged; upload was disabled and linked detail showed loading. `list-complete` at 1792918930167 preceded the first `detail-start` at 1792918930185, whose cookie check was true. Case detail loaded successfully without manual Retry.
2. Refresh with the upload form open: old detail disappeared immediately and both upload controls were disabled. An8000ms pending successful list was superseded by a 500ms failed list. Failure stayed visible after the older list completed; there were zero loading indicators and no stale case. No detail was requested for the failed generation.
3. Retry: successful list at 1792918965763 preceded detail at 1792918965777 with cookie readiness true; detail and upload availability recovered.
4. All logged calls were reads; no `blocked-write` event occurred. Fixture mode was removed and own preview returned to live read-only case before its final capture.

Master will perform an actual cold reload after merge. Service8823 was not restarted for this task.

## Checks

- `npm run typecheck`: pass.
- `npm run typecheck:tests`: pass.
- `npx vitest run tests/ap-system-ui.test.tsx`: 13 tests passed, including 35-field render, money/labels/raw quote, initial direct-link loading and disabled upload, and prior source-version/payment boundaries.
- `npm run build:console`: pass.
- `npm run design:check`: 0 FAIL, 0 WARN, 1 existing answered status-badge finding.
- `git diff --check`: pass.

No backend/contracts, routes, scheduling controls, shared manifest, or copied registry edits are included. No further edits to `APSystemWorkspace.tsx` are reserved by D1 after this handoff; Master owns its next scheduling work.

## Screenshot integrity

- `desktop-1164-light.png`: 69674 bytes, SHA256 `39acfc73eb6addf75843aea406beebac6a819cc91038fdb45e353321dda9fa76`.
- `phone-400-light.png`: 32702 bytes, SHA256 `8b144a5348e3ae9f7ce08e2a996740f496ceef9a9c495ff827e7fac68104d83c`.
- `desktop-1164-dark-appearance-fixture.png`: 68779 bytes, SHA256 `b52fedd7cc932785be8ea1c3f1912bf8434684ed28276e6cb785980a5ee06334`.
- `tablet-800-dark-appearance-fixture.png`: 47619 bytes, SHA256 `d2c236979d3d4d31a7f88bb8600de18d61eca476b68c23b0e6d81620faa05f91`.
- `phone-400-dark-appearance-fixture.png`: 32368 bytes, SHA256 `127fb56e220a8cfb6ba880af05e3d9f5a3e23283c7e7dd68fe3b1522c4f7eb02`.
- `session-failure-fixture.png`: 58918 bytes, SHA256 `5adf1c2ca1d9f5bc39eaa10553b489a1fd144ccee72efccb150b7b4896b6612e`.
