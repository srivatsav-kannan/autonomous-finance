# Worker C — operator workspace handoff

## Goal and source identity

- Native goal activated with `create_goal` as the first action, then verified `active` through `get_goal` in chat `01a16fbf-6432-7d61-94f4-8859f3fa2a97`. Worker implementation and required browser-flow verification are complete; native completion is reported to root after this handoff is committed. Root owns final combined-commit acceptance.
- Repository: autonomous-finance, worktree `/Users/junjiexiong/.codex/worktrees/c2b3/calhacks`.
- Common base: `c7052c95acd8dc6f90d4300c0a16a992c22bdc7c`.
- Branch: `codex/invoice-mvp-operator`.
- Interface prerequisite: A's `a8d81dc6924498f5827d18ef5817570532cbdb97`, cherry-picked locally as `85bf975`. Root already owns the interface; do not integrate this duplicate prerequisite.
- **UI implementation commit: `ac310f67c3228f3b5e0eeae671c809c8238ff4ac`.** Cherry-pick this code commit, then the separately reported handoff commit.
- Real browser verification: local UI `http://127.0.0.1:5174`, same-origin Vite proxy to gateway8790, root-provisioned persisted Convex backend3230, run `invoice-demo`.
- Gateway `/runtime` attested **`df51ce8bdd54c8a27568cd0e15887017352a580a`**, `dirty:false`, mode `deterministic`, model null, live execution blocked. Browser actions below occurred before root's later runtime/backend corrections. They are not evidence for the final integrated commit.

## Owned changes

`console/src/InvoiceWorkspace.tsx`, `InvoiceCaseDetail.tsx`, `invoiceApi.ts`, `invoiceFormat.ts`, `invoice.css`, `main.tsx`, `console/vite.config.ts`, and this handoff/screenshots. No backend, runtime, shared schema or package changes.

- `/` and `/invoices` show the invoice workspace. `/legacy` lazily loads the existing console, with a useful missing-configuration message if `VITE_CONVEX_URL` is absent.
- Persisted customer totals, contribution source references, document outcomes, batch progress and import history; filter/search documents and open cases.
- Demo import and separate late-correction import. TXT/CSV/JSON upload preserves supplied original file bytes. JSON document envelopes support PDFs only when both original base64 bytes and extracted text are supplied; no browser PDF extraction is claimed.
- Case detail shows source/version/full SHA-256, immutable proposal/evidence, contradictions, exact question, prior proposals, human notes, receipts and audit/tool summaries. Extracted text is React text, never HTML. Downloads use inert `application/octet-stream` blobs; missing originals are honestly labeled extracted text only.
- Accept/exclude/request-evidence decisions submit exact `caseId`, `proposalId`, `evidenceVersion`, unique `idempotencyKey`, action and note. Same-request replay/retry retains the identical payload. HTTP409 visibly rejects the stale/conflicting request and refreshes case detail. Workspace polling detects changed proposals and disables the old decision form. Answered proposals stay read-only until new evidence produces a new proposal.
- Local simulated identity and deterministic/mock/live mode are clearly labeled. Resume explicitly sends `live:false`; the UI exposes no live-spend switch or backend secret.
- Four-second visible-tab polling, session cookie writes using `credentials:'same-origin'` plus `X-Invoice-MVP-Session:'1'`; proxy preserves Origin. Accessible native case dialog supports focus containment and Escape.

## Reproducible verification

From the worker checkout (existing dependencies linked locally; symlink not committed):

```sh
npm run typecheck
node_modules/.bin/vite build --config console/vite.config.ts
git diff --check
npm run console -- --port 5174 --strictPort
curl -s http://127.0.0.1:8790/api/invoice-mvp/runtime
```

TypeScript, production build and diff check **PASS**. No new dependencies. Root provisions gateway8790 and allows origin `http://127.0.0.1:5174`; final integrated UI defaults to5173.

Browser actions were performed through the actual visible UI and real HTTP/Convex stack, without mocked responses:

1. Started with an empty saved workspace. Clicked **Import synthetic demo**. Eight source cases appeared immediately, including a duplicate; progress advanced from1/8 to8/8.
2. Acorn showed gross1000, credits125, net875; Birch net400; combined net1275. Expanded Acorn contributions and observed invoiceAC-1001000 and creditAC-C10125 with immutable document/version/hash references.
3. Opened **Acorn disputed invoice.txt**. Observed explicit contradictions, proposed200, exact question, original text/version/hash and immutable proposal `nn7fdrg6n5nm31bnw0xrqkbpax8gxhva` at evidence version1.
4. Entered an explanatory synthetic-test note and accepted. Case `n1730q4f1650sh3gfs44qgr4b18gwwvy` became Recorded, Acorn net1075, combined1475. Clicked **Replay last decision**; totals stayed unchanged. Read-only API corroboration showed exactly one decision and one contribution for that case. Decision key was `59461a61-9f74-4516-8b02-0b0b422f9fa8`.
5. Reloaded the browser. The selected case, accepted proposal, note/audit and totals were restored from the backend.
6. Clicked **Add late correction**. A separate one-document batch arrived. Birch original became Superseded; version2 corrected source recorded450. Combined net1525, Acorn1075/Birch450, nine source cases, one duplicate, one superseded.
7. Opened **Unfamiliar service recap.txt**. Exact request asked for issued invoice/credit, customerID, document number, USD and final total. **Accept proposal** was disabled for unsupported evidence. Entered a note and clicked **Request evidence**. State stayed Evidence missing and the note persisted in decision/audit history.
8. Before adding the final answered-proposal UI guard, clicked Exclude against that already answered immutable proposal. The real API returned409 (`This immutable proposal already has a human decision; replay its original idempotency key`). UI displayed the explanatory rejection and refreshed the saved detail. Screenshot records this real error. Final UI additionally prevents this same-view conflict; concurrent stale/conflicting requests still use the tested409 handling path.
9. Reloaded final code at `ac310f6`: persisted evidence request remained visible and the already answered proposal no longer offered a second decision.

Screenshots (captured from the real browser):

- `screenshots/c-workspace-totals.png`: recorded customer totals after late correction.
- `screenshots/c-recorded-case.png`: recorded disputed case and its accepted proposal.
- `screenshots/c-missing-evidence.png`: exact human question and unsupported-evidence treatment.
- `screenshots/c-decision-conflict.png`: real409 rejection and refreshed detail, captured before the final guard disabled repeat answers.

Additional direct source-import smoke assertions passed using `tsx` + browser-compatible File objects: raw text bytes survive base64 encoding exactly; malformed JSON rejects; PDF envelope without original bytes rejects; complete PDF envelope retains original bytes. These are source-reader checks, not browser upload or PDF parsing claims.

## Boundaries, remaining acceptance and contract deltas

- **Live-model evaluation: NOT RUN.** No model calls or spend; deterministic browser evidence is not a benchmark result.
- No mock UI was used for acceptance. Browser refresh was verified; full process/backend restart remains root's combined acceptance task.
- A separate stale-evidence race was not exercised by C. The real409 conflict response verified rejection/reload UI; root must verify proposal-change stale approval on the final integrated commit.
- File-picker upload, binary download roundtrip and mobile viewport were not separately browser-tested. Source-reader byte preservation and PDF boundary checks passed; actual main acceptance used the synthetic demo.
- The initial demo at `df51ce8` leaves its two TXT customer registry records awaiting review. Root later reported auto-excluded CRM CSV changes; those later samples were not reimported during this browser run. Do not present the older source states as evidence for the improved sample.
- Root may now reuse `invoice-demo` or create a new run. The UI5174 development process is left running for inspection. No resets, pushes, PRs, deployments, payments or hidden evaluation access occurred.
- Proposed shared-contract deltas: **none**.
