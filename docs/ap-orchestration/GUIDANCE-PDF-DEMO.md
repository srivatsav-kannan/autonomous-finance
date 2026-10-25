# Uploaded B/C guidance demo (#119 / #120)

Base: PR #118 `integrate/one-console`, initially `396d6b13312bfe944affcb2e8fb7ff741de69c84`, updated to `a22abce369e5a4938055b0ba05968cb21a82928d` (workspace settings and scenario selection) before delivery.
This branch selectively ports the committed precedent contract, storage, matcher and tests from `6fa26ed63ed7ce5e376a9b595d6d2c66057a4910`. It does not merge the live-auth0 branch or PR #117, and does not copy any dirty worktree UI files. It uses #118's normal upload and case workspace.

## Run in this checkout

Prerequisites: Node 24+, `npm ci`, Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), Chrome for the optional browser test. No model, banking or accounting credentials are needed. Keep the existing 5192/8825/3252/3253 and 5196/8827/3254/3255 services running. This demo exclusively owns 5198/8830/3260/3261. Use an isolated checkout with its own `.convex` directory.

Terminal 1:

```sh
CONVEX_AGENT_MODE=anonymous node node_modules/convex/bin/main.js dev \
  --codegen disable --typecheck disable --tail-logs disable \
  --local-backend-version precompiled-2026-10-10-72ce13c \
  --local-cloud-port 3260 --local-site-port 3261
```

On first startup, the CLI creates `.convex/local/default/config.json` and may report missing auth environment variables. Leave it running; in terminal 2:

```sh
node scripts/ap-system/init-guidance-demo.mjs
# Wait for terminal 1 to report "Convex functions ready!", then:
npx tsx scripts/ap-system/guidance-demo-server.ts \
  --config var/guidance-demo/config.json --walkthrough
```

The initializer writes a private 0600 config under ignored `var/`. The gateway seeds authored history A and uses distinct **simulated** proposer/governor identities for explicit policy and rule approval. Restarting reuses the same immutable records. It starts no payment worker.

Terminal 3:

```sh
AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8830 npm run console -- --port 5198 --strictPort
```

Open http://127.0.0.1:5198/ap-system and select **Simulated field reviewer**.

1. Click **Upload documents**, select `fixtures/ap-system/guidance-pdfs/cleaning-b.pdf`, then **Create AP case**. Expected: `CLEAN-B-20261025`, USD 85, suggestion 5000 / 100% sf-hayes-valley, **Why A applies**.
2. Click **View current original PDF**, then download it. The hash, source revision and case snapshot are shown. Inspect the referenced rule/history, independent simulated review, policy hash and exact matching fields.
3. Upload `renovation-c.pdf`. Expected: `RENOV-C-20261026`, USD 2,500; same supplier/location, different category. **Why A was not used: pending review** identifies `capital_renovation` versus approved `routine_cleaning`, owner `field-reviewer`, and next action. Coding stays unresolved.
4. Refresh, select the same actor if the full page was reloaded, and re-open the case. The saved recommendation ID, timestamp, rule and source bindings persist. Recheck guidance is idempotent for identical evidence and authority.

Both cases intentionally remain pending normal field/business review. Suggestions do not populate or approve candidate allocations, recognize a payable, post a journal, or authorize/dispatch money. The demo has no supplier onboarding or service acceptance; these independent holds are expected.

## Boundaries and implementation

`apCases:ingest` and the AP clerk's `apCaseAgent:advance` call the same case-guidance writer. The HTTP recheck endpoint accepts only case ID, expected revision and snapshot hash; the gateway uses its server-only AP seat. Neither browser labels nor the old unbound `apPrecedents:evaluate` lab records influence case recommendations.

Context comes from the current retained invoice's extracted text, using unique explicit Supplier ID / Service category / Location / Invoice date / Currency / Total cents lines. Candidate supplier, date, currency and amount must agree. Missing/ambiguous labels, unresolved relevant field evidence, incomplete extraction/pages, or renovation wording contradicting cleaning all hold. This is deliberately a bounded one-page synthetic text-PDF adapter, not a general semantic service classifier. It runs Poppler on uploaded bytes and preserves the existing durable intake metadata. Generic user-upload provenance stays intact; the PDFs themselves visibly state that they are synthetic. Geometry is reported unresolved, never fabricated.

Saved guidance binds case ID/revision/snapshot, source IDs/revisions/hashes, rule immutable version 1/hash, approved scope/review/policy, and history A. Reads recompute the current decision fingerprint; a material revision, withdrawal, policy change, revoked reviewer or conflicting history makes old advice unavailable. Recheck saves a new hold/result; exact reruns reuse the old record. `apPrecedents:disableRule` requires the current policy governor and exact rule hash. Case source revision is changed through the existing intake `explicitRevisionOf` mechanism; regression tests cover positive B revised to renovation and stale requests.

**A limitation:** A is authored synthetic text/history; its `sourceCaseId` is a descriptive historical label, not a real PDF-backed corrected case. No live model/Claude call, practitioner sign-off, real callback or live payment was performed. This completes the scoped B/C demonstration, not the entire #102 learning loop.

## Reproduce checks

```sh
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
npm run build:console
npx vitest run tests/ap-case-guidance.test.ts tests/ap-precedents.test.ts \
  tests/ap-system/guidance-pdf-intake.test.ts tests/ap-system/intake-requests.test.ts \
  tests/ap-system/agent-workflow.test.ts tests/ap-system-local-origin.test.ts \
  tests/ap-system-local-simulation-auth.test.ts tests/finance-scenario.test.ts
node scripts/ap-system/verify-guidance-browser.mjs
# Restart only this checkout's gateway and 3260/3261 backend, then:
node scripts/ap-system/verify-guidance-persistence.mjs
```

The browser script reuploads the fixtures to verify deduplication, opens/downloads originals, checks hashes and exact refresh persistence, and captures desktop/mobile light/dark screenshots. Chrome's macOS default path is used. Regenerate fixtures with `python scripts/ap-system/generate-guidance-pdfs.py` in a Python environment containing reportlab. The checked-in PDFs are deterministic and need no Python to use.

CI deliberately skipped (`[skip ci]`). `design:check` and `design:review -- --url http://127.0.0.1:5198/ap-system` were run: unchanged base `console/src/proof.css` has 9 static failures; rendered base sidebar adds one crowding finding. No new guidance-file errors remain. The built-in design runner sees the actor gate; authenticated case screenshots are captured by the browser test.

See `evidence/guidance-upload-20261025/RESULTS.md` and adjacent JSON/PNGs for actual observed results.
