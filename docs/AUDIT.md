# Codebase audit

Audit of `origin/main` at `0e98be5` (Oct 24, 2026), branch `audit/full`. It was read-only: no code changes, no Convex backend started or reset, no model calls.

**Baseline:** `npm ci`, `npm test` (70 files, 807 passed, 4 skipped), `npm run typecheck`, `typecheck:backend` and `typecheck:tests` all pass.

**How findings were checked.** Findings marked *verified* were reproduced by running the real handlers in scratch scripts outside the repo, using `tests/helpers/kernelHarness.ts` or convex-test. The rest were confirmed by reading the code path end to end.

**Severity:**
- **P0:** compromise of money or authority, reachable in a realistic run.
- **P1:** serious correctness, control or spend bug with a plausible trigger.
- **P2:** real bug with a narrower trigger, or something a stranger will hit.
- **P3:** minor, or hygiene.

**Totals:** 1 P0, 6 P1, 25 P2, 33 P3.

---

## P0

### P0-1. The sandbox for agent-written parsers is not a security boundary, and the code runs in the process that holds every seat credential (verified)

**Where:**
- `src/integrations/parsers.ts:96-108`
- `src/agents/handlers/integrations.ts:44-46`
- `src/agents/handlers/controller.ts:200-204`
- `src/agents/runtime.ts:58`
- `src/world/scenario.ts:66`
- `src/agents/team.ts:77-78`
- `src/core/env.ts:4-15`

**What's wrong:**
- `compileParser` runs model-generated JavaScript with `node:vm` and passes in a host-realm object (`helpers`). Node documents that `vm` is not a security mechanism, and passing host objects lets context code reach host-realm built-ins. A benign probe confirmed that generated parser code can reach the real Node `process`. The comment "no require, no process, no network" is therefore false.
- The code runs **before any review**. `buildParser` executes it at `integrations.ts:45-46` to test it. The controller's review (`controller.ts:201`) only re-runs the tests; nobody inspects the code.
- The model writes the code from an untrusted supplier document (`integrations.ts:37`).
- The process it runs in has `.env.local` loaded (`KERNEL_ADMIN_SECRET`, model API keys, `VITE_GATEWAY_TOKEN`). It also reads `var/runs/<run>/seats.json`, which holds every seat token, including `human-cfo` (`scenario.ts:66`, `team.ts:78`).

**Failure scenario:** a document that steers code generation yields a parser that acts with credentials it should never see. The human approval threshold, two-key close and requester ≠ approver checks are then all satisfiable by one process. Those are the controls the README says the kernel enforces.

**Fix:**
- Do not execute generated JavaScript in-process. Prefer a declarative parser spec (named regexes plus field mappings) interpreted by fixed code, the same "recipes, not code" idea used elsewhere.
- If code must run, run it in a separate process with an empty environment and no filesystem or network permission (Node permission model or `isolated-vm`). Pass only primitives across the boundary.
- Separately, remove the human token from the agent process (P1-6).

---

## P1

### P1-1. Human gateway effects are chosen by fields the asking agent controls

**Where:** `convex/asks.ts:13-48`, `src/human/gateway.ts:36-79`, `console/src/App.tsx:300`.

**What's wrong:**
- `createAsk` validates only `taskId`. Any seat with `asks` (almost all of them) can set `options` (ids and labels), `paymentIntentId`, `proposalBranch` and a free-text `title`.
- The gateway maps option *ids* to actions taken as `human-cfo`:
  - `approve` + `paymentIntentId` → `approvePayment`
  - `reject` → `voidPayment`
  - `merge` + `proposalBranch` → memory merge with `human_cfo` capabilities, which can merge every path
  - `sign` → `signClose`, with the period regex-parsed from the title
- The console shows only the agent-written *labels*. So the button the human sees need not describe the effect, and the kernel never checks that the referenced intent or proposal relates to the ask.

**Failure scenario:** a buggy or manipulated agent opens an informational ask whose first option has id `approve` and points at an unrelated pending payment. The human acknowledges it and has approved that payment.

**Fix:**
- In `createAsk`, validate the referenced intent (same run, `pending_approval`) and proposal.
- For effectful asks, have the kernel set the option ids and labels itself.
- Have the console render a kernel-derived effect summary (payee, amount, remit-to; branch and paths; period) next to the buttons.
- Store the close period as a field instead of parsing the title.

### P1-2. The console's WebMCP `answer_decision` tool lets a browser agent answer as the human CFO

**Where:** `console/src/webmcp.ts:36-39` (registered at `console/src/App.tsx:93`).

**What's wrong:**
- The tool's own description says "Payment approvals and period close co-signs take effect immediately". The page asks for no confirmation.
- Ask titles and bodies are agent-written and partly derived from vendor documents, which `list_open_decisions` returns to the browser agent.
- So the "human" approval can come from a model reading untrusted text. This compounds P1-1.

**Fix:** expose only read-only WebMCP tools. Alternatively, have `answer_decision` stage the answer and require a real user click in a confirmation the agent cannot drive.

### P1-3. `ledger.reverseEntry` moves cash without bank evidence and leaves payment and bill state stale (verified)

**Where:** `convex/ledger.ts:79-123`; `convex/lib/post.ts:31` allow-lists `reversal` as a cash source.

**What's wrong:**
- Any seat able to post the original lines can reverse any entry, including kernel-sourced `payment_settlement` and `bill` entries.
- Verified: a `payments` seat reversed a settlement. Cash 1000 went back up with no bank transaction. The intent stayed `settled` and the bill stayed `paid`. Reversing the reversal also succeeded.
- `readCloseReadiness` catches a reversed bill accrual, but not a reversed settlement.

**Failure scenario:** an agent "corrects" a settlement it believes is wrong. The books then show AP owed and cash on hand for money that left the bank, and close still passes.

**Fix:**
- Refuse `reverseEntry` on kernel-sourced entries (`bill`, `payment_settlement`, `payroll_funding`). Route those through dedicated flows that also update bill and intent state.
- For other cash lines, allow reversing only `bank_match` entries. `bankEvidence` already re-frees their bank transaction.

### P1-4. Invoice workspace: a later file with the same filename silently supersedes a recorded invoice

**Where:** `console/src/invoiceApi.ts:70` (`externalId: file.name`); `convex/invoiceCases.ts:129`, `:149-154`.

**What's wrong:**
- Any import with an existing `externalId` is treated as a new version. The prior case becomes `superseded` and its contribution is deactivated, even when it was `recorded`, and no human review is involved.
- This contradicts the comment at `:179`: "Accepted work changes only via explicit replacement".

**Failure scenario:** confirmed by a scratch probe. Batch 1 imports `invoice.txt` for customer A at $1,000. Batch 2 imports a different customer's `invoice.txt` for $400. Customer A's net drops from $1,000 to $0. Generic export names make this likely.

**Fix:**
- Derive `externalId` from the content hash or a UUID in the browser.
- Version by `externalId` only for explicit importer metadata (JSON bundles).
- Send any supersession of a `recorded` case to human review.

### P1-5. The agents' Anthropic path has no spend cap, though the docs say agents are capped

**Where:** `src/agents/llm.ts:9-11`, `:65-83`, `:92`, `:98-101`, `:128-137`; `.env.example:26-27`; `README.md:96`.

**What's wrong:**
- `localBudget` (the `AGENT_MAX_USD` cap and `var/agent-spend.json`) is wired only into the OpenAI client.
- The Anthropic SDK path (`maxRetries: 3`, `max_tokens: 16000`, server fallbacks) never reserves or records spend. `docs/evals/README.md:112` already admits this.

**Failure scenario:** a `.env.local` with only `ANTHROPIC_API_KEY`, which is what the README tells users to add. Then `npm run eval`, `npm run agents` and the gateway's "why" answers spend with no bound.

**Fix:** route Anthropic calls through `BudgetedModelClient` with `localBudget` (or refuse to run on that path), and correct the docs.

### P1-6. The legacy "human approval" is a bearer token stored in the same file the agent runtime loads

**Where:** `src/world/scenario.ts:66` (writes all tokens, including `human-cfo`, to `seats.json`); `src/agents/team.ts:78` (Team loads the whole file); `src/human/gateway.ts:19-22`.

**What's wrong:**
- The kernel's human check is just `seat.kind === "human"` on a seat authenticated by token (`convex/payments.ts:133-135`, `convex/ledger.ts:162`).
- The Team skips non-agent seats when building runtimes, but it holds the human token in memory, and the file is readable by the same OS user.
- So human-threshold approvals and the human half of the two-key close are only as independent as file permissions inside one process. This is what makes P0-1 decisive.

**Fix:**
- Write the `human-cfo` token to a separate file read only by the gateway. Better, have the gateway mint and register it at startup.
- Have the Team load only agent tokens.
- Longer term, use the AP demo's model, where the human is a verified JWT (`convex/lib/demoAuth.ts:48-57`).

---

## P2

### Kernel and controls (legacy profile)

**P2-1. `payments.settlePayment` books cash with no bank evidence.**
- Where: `convex/payments.ts:173-201`.
- What's wrong: the settling seat supplies `bankRef` and `settledOn` freely, and nothing ties them to a `bank.transaction` event. `postEntry` does enforce bank evidence for cash, so this is inconsistent with it.
- Who can trigger it: the `payments` role both requests and executes, and the controller can also settle (its post prefixes cover 1000 and 2000).
- Scenario: a payment that was approved but never sent is booked as paid.
- Fix: require a matching, unbooked bank transaction, as `bankEvidence` does.

**P2-2. The remit-to re-check at execution trusts the caller.**
- Where: `convex/payments.ts:160`.
- What's wrong: `executePayment` compares the stored remit-to with `currentRemitTo`, but the executing seat passes that value in. Passing the stored value always passes.
- Fix: have the kernel hold the verified vendor remit-to (mirrored from merged memory) and compare against that.

**P2-3. The controller's review of remit-to changes is self-attested.**
- Where: `src/agents/handlers/controller.ts:193`.
- What's wrong: review only checks that the proposed vendor file says `method: "callback_known_number"`, a value the proposer writes (`src/agents/handlers/payments.ts:104`). `crs_check` and `cooling_off_days` from `policies/payments.yaml` are never enforced.
- Fix: verify against an independent record of the callback (event id and transcript), and enforce the policy list.

**P2-4. A controller can create and approve a bill of any size alone, then approve its payment.**
- Where: `convex/ap.ts:132` (controller's auto-approve limit is `MAX_SAFE_INTEGER`); `src/core/roles.ts:79`.
- What's wrong: requester ≠ approver applies only to the payment requester, so the same seat can own the liability and its approval.
- Fix: require a second seat for controller-created bills above `autoApproveCents`, and refuse payment approval by the bill's creator.

**P2-5. Memory segregation of duties is enforced in the client library, not by an authority.**
- Where: `src/memory/store.ts:346-350`.
- What's wrong: `merge()` takes `caps` from its caller, and `Proposed-By` comes from the caller's author. The repo is a local git directory, writable by any process run by that user.
- Effect: "a different seat must merge" holds only by convention inside one process.
- Fix: put merges behind a service holding the main-branch write path, checking seat tokens against the kernel. At minimum, look up caps from the authenticated seat rather than accepting them.

**P2-6. Two public queries skip `assertLegacyRun`, and every legacy read is unauthenticated.**
- Where: `convex/bank.ts:6` (`workspace`), `convex/ledger.ts:188` (`closeReadiness`).
- What's wrong: these two expose demo-run cash data to anyone with a `runId` (verified by the AP sub-audit).
- Separately, `admin.runs` lists runs publicly, and every legacy query returns books, bills, asks and violations to anyone with the deployment URL.
- Fix: add `assertLegacyRun` to both queries. Decide and document whether the deployment URL is a secret.

**P2-7. The AP demo's `acceptBill` / `humanAcceptBill` clears exception flags without review or audit (verified).**
- Where: `convex/demoPayments.ts:137-145`.
- What's wrong: re-accepting an already accepted bill with the same amount sets `flags: []`, skipping the flag, evidence, reason and version checks plus the audit that `resolveBillExceptions` (`:108-128`) requires. First acceptance also discards flags raised earlier.
- Fix: refuse acceptance while flags exist.

### Gateway and console

**P2-8. `VITE_GATEWAY_TOKEN` is inlined into the console bundle and dev server.**
- Where: `console/src/gateway.ts:4`, `src/human/gateway-auth.ts:17`.
- What's wrong: any local process can read the token. `guardRequest` skips the Origin check when Origin is absent. The token unlocks the human CFO actions and `chaos`, which uses the admin secret. The invoice gateway on :8790 has the same property (`src/invoice-mvp/server.ts:73-76`).
- Effect: the token is a CSRF nonce, not human authentication.
- Fix: document it as such, refuse `build:console` while it is set, and move it to a gateway-issued HttpOnly cookie. Drop `chaos` from the human gateway.

### Invoice workspace

**P2-9. An ID/name mismatch is auto-recorded.**
- Where: `convex/invoiceCases.ts:216,226,244`; `src/invoice-mvp/parser.ts:98`.
- What's wrong: `Customer ID:` is checked; the `Customer:` name line is accepted but never compared (verified by sub-audit). An ID typo that hits another valid ID posts to the wrong customer.
- Fix: require the name to equal the registered legal name or an alias; otherwise raise a contradiction.

**P2-10. `request_evidence` dead-ends the case.**
- Where: `convex/invoiceCases.ts:334-335,351`.
- What's wrong: a later `exclude` is refused with `decision_conflict` until an unrelated import arrives.
- Fix: clear `currentProposalId` on `request_evidence`, and allow exclude without a proposal.

**P2-11. Updating the customer master loops forever.**
- Where: `src/invoice-mvp/investigator.ts:143`, `convex/invoiceCases.ts:366`, `src/invoice-mvp/service.ts:81`.
- What's wrong: adding an alias raises `customer_conflict` on every pass, and new customers in the same file are never registered.
- Fix: treat a superset as a no-op or an alias proposal, register the rows that don't conflict, and emit `needs_evidence` instead of looping.

**P2-12. UTF-8 BOM files cannot be imported.**
- Where: `console/src/invoiceApi.ts:57` (decoder strips the BOM) vs `src/invoice-mvp/service.ts:40-41` (`ignoreBOM: true`).
- Effect: `source_text_mismatch`. Fix: decode the same way on both sides.

**P2-13. The Anthropic investigator inherits the OpenAI model id.**
- Where: `src/invoice-mvp/model.ts:2,60` imports `MODEL` from `src/agents/llm.ts`.
- What's wrong: with both keys set, `MODEL` is `gpt-6.1-sol`, so Anthropic calls fail after a budget reservation has already been charged, and the attestation names the wrong model.
- Fix: pin the invoice model separately.

### Spend and evals

**P2-14. The Claude-only harnesses spend on start with no approval gate.**
- Where: `evals/external/dabstep/run.ts:519,541` (default $15), `evals/external/vals-finance-agent/src/run.ts:34` ($60), and `probe.ts`, `probe-fetch.ts`, `invoice-sandbox/smoke.ts` and `run.ts` (`lib/config.ts:20`, $24.50).
- What's wrong: `.env.example:20` and `docs/EXTERNAL_EVALS.md:7` imply keys alone don't enable spend, but that is true only for `bench:*`.
- Fix: require `--confirm-usd N` (as `eval:sheets-agent` does at `src/evals/spreadsheet/agent.ts:195`), or archive these harnesses.

**P2-15. The OpenAI cap can be overshot and isn't machine-wide.**
- Where: `src/agents/llm.ts:65-83`.
- What's wrong:
  - `reserve()` checks but records nothing until settle, so the roughly 12 parallel seats (`team.ts:246`) can all pass near the cap.
  - `SPEND_FILE` is cwd-relative, so each worktree gets a fresh $15.
  - The file read-modify-write is unlocked.
  - Prices are fixed to `OPENAI_PRICES` whatever `AGENT_MODEL` is.
- Fix: persist the reservation under a lock, use an absolute path, and price per model.

**P2-16. The eval status docs contradict the committed results.**
- Where: `docs/EXTERNAL_EVALS.md:5,7,66,206` and `docs/evals/README.md:7,19,21,112,223,256`.
- What's wrong: they say NOT_RUN, no paid runs, and 558 tests. But `docs/evals/runs/final/external-*/config.json` record `approval-present`, `docs/RESULTS.md` reports $8.63 of spend, and there are 807 tests.
- Fix: replace these status paragraphs with links to `RESULTS.md`.

### Tooling and run-ability

**P2-17. `npm test` in the main checkout also runs every agent worktree.**
- What's wrong: there is no vitest config. Vitest's default exclude is only `**/node_modules/**` and `**/.git/**`, and `.claude/worktrees/` is not gitignored.
- Fix: add `vitest.config.ts` excluding `.claude/**` and `var/**`, and gitignore `.claude/worktrees/` and `.claude/settings.local.json`.

**P2-18. `demo:local` overwrites deployment-wide env.**
- Where: `scripts/ap-demo.ts:42,57-59`.
- What's wrong: it sets `KERNEL_ADMIN_SECRET`, `AP_DISPATCH_SECRET`, `AP_EVIDENCE_SECRET` and `AP_BANK_SCOPE` on the local deployment. It uses `.env.local` values when present, otherwise random values it never saves.
- Scenarios:
  - A user who followed the README's legacy step (`npx convex env set KERNEL_ADMIN_SECRET` without the same value in `.env.local`) and then runs `demo:local` breaks `smoke`, `world` and `eval` with `bad_admin_secret`.
  - Every run rebinds `AP_BANK_SCOPE` to its new `runId`, so workers for an earlier run, or a concurrent `ci:recovery`, fail with "service account scope mismatch".
- Fix: refuse to overwrite an existing different admin secret. Write generated secrets to `.env.local`. Make the scope binding per run, or document the one-run-at-a-time rule.

**P2-19. `.env.example` ships `KERNEL_ADMIN_SECRET=change-me`.**
- What's wrong: copying the file as instructed and running `demo:local` sets the deployment's admin secret to `change-me`.
- Fix: leave it blank, have `requireAdmin` reject short or known placeholder values, and add a generator script like `gateway:token`.

**P2-20. The invoice-workspace startup ports disagree.**
- Where: `docs/invoice-mvp/STARTUP.md:9` (:3230) vs `:60,108` (:3220) vs `.env.example:5-6` (:3210).
- What's wrong: running both deployments from one checkout shares `.env.local` and `.convex/`. `STARTUP.md:16` says the invoice gateway doesn't need the admin secret, but `src/core/env.ts` loads all of `.env.local` into it.
- Fix: one port table, plus a separate checkout or `CONVEX_*` override per deployment.

**P2-21. The order of the fresh-backend steps is fragile.**
- What's wrong: the first `npm run backend` deploy fails until `AP_HUMAN_AUTH_ISSUER` and `AP_HUMAN_AUTH_AUDIENCE` are set from a second terminal (README "Run it"). A stranger sees a failed deploy with the backend still running.
- Fix: default both placeholders in `convex/auth.config.ts` for local deployments, or have a `setup:local` script set them.

**P2-22. The gateway needs a simulation run that the README orders after it.**
- Where: `src/human/gateway.ts:19-22`.
- What's wrong: it reads `var/runs/<run>/seats.json` per request, so nothing works until `npm run world` or `npm run eval` has created a run. The README lists `gateway:token`, `gateway` and `console` after `eval` without saying a run is required.
- Fix: say so, and return a clear 404 for an unknown run.

**P2-23. Python prerequisites are scattered.**
- What's wrong: each harness needs a different setup:
  - `bench:*`: Python 3.11+, a venv at `var/benchmarks/.venv`, network access (`scripts/external-bench/requirements.txt`, ranges only).
  - DABstep: `uv run --with pandas`.
  - FinBalance: an external clone with Python 3.12 via uv.
  - `evals/invoice-mvp`: uv, Python 3.12, `pypdf==6.21.2`.
- None of this is in the README's "Run it" section. The local default `python3` (3.14) is untested.
- Fix: one prerequisites table in the README, with pinned versions.

**P2-24. Free scripts overwrite committed evidence.**
- Where: `src/evals/spreadsheet/bench.ts:27,159` (defaults to `docs/evals`), `scripts/control-tests.ts:238` (overwrites `docs/evals/control-tests.json`).
- Fix: default both to `var/`.

**P2-25. Much of `evals/` is untested and untypechecked in CI.**
- What's wrong: `evals/external/dabstep/run.ts` is in no tsconfig. The three `evals/*` tsconfigs, the Python tests and `evals/invoice-mvp/*.node-test.ts` never run in `.github/workflows/ap-ci.yml`.
- Fix: add one CI job, or move these harnesses to an archive branch.

---

## P3

### Kernel

1. `authSeat` says stored capabilities "narrow, never widen", but it ignores `seat.capabilities` entirely (`convex/lib/kernel.ts:57-60`). Apply the narrowing or delete the comment and the field.
2. `requireAdmin` (`convex/lib/kernel.ts:66`) and `requireService` (`convex/lib/demoAuth.ts:27`) use `!==`. Compare digests in constant time.
3. Failed authentication still writes `violations` and `activity` rows under any caller-chosen `seatId`, from anyone with the URL (`convex/lib/kernel.ts:70-94`). `readCloseReadiness` collects every violation (`convex/lib/closeReadiness.ts:34`), so spam can push close past Convex read limits. Don't record unauthenticated failures, or rate-limit and cap them.
4. `observe.note` lets any seat write arbitrary activity `kind` and `text` into the audit feed (`convex/observe.ts:38-47`). Restrict the kinds.
5. Idempotency keys are per run and caller-chosen (`convex/lib/kernel.ts:100-122`). A seat can pre-claim a key another seat will use deterministically, and the victim gets `idempotency_conflict`, recorded as its own violation. Namespace keys by seat.
6. `resolveHeldBill` short-pay overwrites `totalCents` (`convex/ap.ts:246`), losing the invoiced amount. Store `approvedCents` separately.
7. The duplicate-bill guard keys on the agent-supplied vendor string (`convex/ap.ts:94-97`). Key on vendor id from memory.

### AP payment module

8. `claimEffect` throws on a non-first claim that fails authority or ambiguity checks. One bad row can block every dispatch, and the throw rolls back budget updates (`convex/lib/payments/applyEffect.ts:36-44`). Mark it `exception` and continue, as for first dispatch.
9. The `demoEvidence.work` query returns whole command rows, including `leaseToken` (`convex/demoEvidence.ts:166`). Each tick, `ReconcilePaymentEvidence.tick` re-observes every historical transfer (`src/payments/application/reconcile-payment-evidence.ts:123-128`), which will hit Increase rate limits. Project fields, and skip settled and matched commands.
10. Dead code: `convex/lib/demoEffects.ts` has no importers. `demoEvidence.proposeMatch` writes rows nothing reads. `approveWithinPolicy` and `controllerLimitCents` are never required by `approveAndQueue`, while the README advertises dual approval for the AP demo. `docs/ap-demo-backend.md` says `approveAndQueue` reserves; `requestPayment` does.
11. The dispatcher token file `var/ap-demo/<run>/dispatcher.json` survives a throw or Ctrl-C before the `finally` (`scripts/ap-demo.ts:152,260`). Wrap it in `try/finally` with a SIGINT handler.

### Invoice workspace

12. Re-importing old bytes with re-extracted text supersedes the current version (`convex/invoiceCases.ts:131,156-162`). Reject a hash matching an older version of the same id.
13. There are two invoice-number normalizers: `convex/invoiceCases.ts:9-11` and `convex/lib/invoiceIdentity.ts:2-4`. The service and investigator use exact equality, so `INV-0042` and `0042` both record. Pick one.
14. Every new case invalidates every pending review, including byte duplicates (`convex/invoiceCases.ts:146,176-188`). That causes 409s and, in live mode, re-spends budget. Exclude `duplicate` cases.
15. Routine grammar accepts a missing currency line (`:213,223-224`), and currency detection misses `€`, `£`, `CA$` and `MXN` (`:258`).
16. Customer-master auto-exclusion (`:316`) is narrower than the parser's accepted headers (`src/invoice-mvp/parser.ts:63-75`).
17. A decision response waits on a processing pass (`src/invoice-mvp/service.ts:47-51`). Respond first.
18. `caseDetail` returns every version's base64 (`convex/invoiceCases.ts:401-404`), and every pass reads all pending details (`service.ts:65-68`). This is a read-size risk.
19. `src/human/gateway.ts:24-28` reads request bodies with no size limit. `scripts/gateway-token.ts:12` doesn't fix the mode of an existing `.env.local`.

### Hygiene

20. Absolute local paths are committed: `/Users/srivatsavkannan` in 11 files (`docs/evals/runs/final/*/config.json`, `docs/evals/{dabstep,finbalance,invoice-sandbox}.json`, `evals/external/finbalance/sample_*.json`, `finbalance/README.md:41`) and `/Users/junjiexiong` in 11 files under `docs/invoice-mvp` and `evals/invoice-mvp`. Scrub them.
21. The head-to-head baseline cited in `docs/RESULTS.md:59` lives only on another branch (`src/evals/baseline.ts` at `3ef9c92`). Merge it or mark the result as not reproducible from main.
22. There is no `.nvmrc`, and engines aren't enforced. `docs/ap-demo-backend.md:27` and `docs/ap-demo/fake-bank.md:3` say Node 24.6+, everything else says 24.18. CI pins 24.18.0. Add `.nvmrc` and `engine-strict`.
23. `docs/ci.md:3-9` describes the old stacked-PR flow and omits the `browser` job (`ap-ci.yml:82-108`).
24. Stale "NOT RUN" text: `docs/invoice-mvp/INVESTIGATOR.md:3`, and the `evals/invoice-mvp/LIVE.md:1` title, which contradicts its own banner.
25. `docs/INTEGRATION_DESIGN.md:162` says its modules don't exist; `src/integrations/contracts.ts` and `banking/increase.ts` do.
26. `docs/TEAM.md:5-20` is a Friday-night snapshot (14/14 errors, 65 invoices); current numbers differ.
27. The README layout table omits `src/core`, `src/invoice-mvp`, `evals/`, `benchmarks/`, `scripts/` and `tests/`. The README links neither `docs/RESULTS.md` nor `docs/DEMO.md`.
28. `.agents/` is 6.8 MB vendored Hallmark, 5.4 MB of it theme images under `references/themes`. Keep `SKILL.md` and `scripts/`, which `design:check` needs, and drop or fetch the themes.
29. Agent orchestration logs are committed: `docs/invoice-mvp/{COORDINATION,handoff-*}.md`, `docs/payment-refactor/COORDINATION.md`, `docs/invoice-mvp/REQUEST.txt` (a Codex prompt), and `docs/invoice-mvp/LEGACY_PROTOTYPE.md`. Delete them (table below).
30. Dead or unwired scripts: `scripts/peek-world.ts` is unreferenced. Eight `scripts/smoke-*.ts` files (ap-integrity, arithmetic, duplicate-score, held-answer, memory-recovery, payroll-roster, staffing-boundaries, task-boundaries) are referenced by nothing, and `smoke-close-source.ts` only by a doc. They are the only live-Convex checks of those invariants, so wire them into `npm run smoke`. `invoice-mvp-smoke.ts` and `invoice-mvp-http-smoke.ts` have no npm script.
31. Duplicated implementations:
    - Seven or more model clients: `src/agents/llm.ts`, `src/agents/model-client.ts`, `src/invoice-mvp/{model,openai-model}.ts`, `evals/invoice-mvp/{openai-responses,capped-llm}.ts`, `evals/external/invoice-sandbox/lib/llm.ts`, inline in `dabstep/run.ts`, `vals-finance-agent/src/{agent,judge}.ts`, and `finbalance/anthropic_client.py`.
    - Seven spend ledgers and five price tables.
    - Three Invoice Sandbox scorers.
    - `evals/invoice-mvp/baseline-agent.ts` is a copy of `evals/external/invoice-sandbox/system-a.ts` except for its imports.
    - Keep `model-client.ts` as the one live client and treat `evals/external/*` as frozen.
    - The two invoice parsers (`src/invoice-mvp/parser.ts` for customer invoices, `src/integrations/parsers.ts` for vendor bills) serve different domains and are not duplicates.
32. `npm ci` on npm 11 warns that install scripts for `esbuild`, `fsevents` and `@scarf/scarf` (telemetry, via Prism) are not covered by `allowScripts`. Add an explicit `allowScripts` policy: allow esbuild, deny scarf.
33. `bench:*` approval is self-attested: any process can write a policy file with any `approvedBy` (`src/evals/external/models.ts:27,52`). It is fine as a guard against accidents. Document that it is not authentication.

---

## Checked and OK

These held up; no need to re-investigate.

**Auth on public Convex functions:**
- Every exported Convex mutation checks a credential: seat token, admin secret, dispatcher or evidence secret bound to `AP_BANK_SCOPE`, or a human JWT matched on `tokenIdentifier` to an active `human_cfo` seat.
- `invoiceCases` functions all require seat tokens with role checks.

**AP dispatcher:**
- It is fenced by lease token, generation and expiry.
- The attempt is persisted before bank I/O, recovery reuses the frozen request, and `completeEffect` refuses a transfer id owned by another command.
- Reservations change state exactly once. Posting is one entry per bank transaction with correct signs.
- Webhook signatures use `timingSafeEqual`.
- Ran the demo and payment suites: 21 files, 209 tests.

**Legacy kernel:**
- Double entry in integer cents with safe-integer and overflow guards.
- Closed and unopened periods are refused in `appendEntry`.
- The hash chain is recomputed in `verifyChain`.
- Close requires controller plus human on the same readiness snapshot, and signatures reset when inputs change.

**Gateway and invoice server:**
- The human gateway compares SHA-256 digests with `timingSafeEqual` and enforces an Origin allowlist and JSON content type.
- The invoice server checks loopback, Host and Origin, uses SameSite=Strict HttpOnly cookies, and compares them in constant time.

**Spend gates and secrets:**
- `bench:*` stays disabled with `approval: null`; checked at `src/evals/external/main.ts:111,150` and `models.ts:91`.
- No secrets are committed; scanned for key patterns and `*_SECRET`/`*_TOKEN` assignments.
- Every npm script points at an existing file.

---

## Docs: keep / merge / delete

> **Applied** in the `chore/repo-cleanup` PR. Paths below are as audited; several docs have since moved: `docs/ap-demo.md` and `docs/payment-refactor/*` are in `docs/ap-demo/`, `INTEGRATION_DESIGN.md` is `docs/ap-demo/design.md`, `EXTERNAL_EVALS.md` and `CLOSE_EVAL_CORRECTNESS.md` are in `docs/evals/`, and `WORKER_RECOVERY.md` and `TEAM.md` were merged into `ARCHITECTURE.md` and the README.

| Doc | Verdict | Note |
|---|---|---|
| README.md | keep | Fix the uncapped-Claude line (P1-5), layout table, links to RESULTS/DEMO, prerequisites |
| design.md | keep | Design system |
| docs/HALLMARK.md | merge → design.md | Short, overlaps |
| console/AGENTS.md | keep | Console agent rules |
| docs/ARCHITECTURE.md | keep | Link WORKER_RECOVERY from it |
| docs/CLOSE_EVAL_CORRECTNESS.md | keep | Linked from README |
| docs/DEMO.md | keep | Link from README |
| docs/RESULTS.md | keep | Canonical results |
| docs/EXTERNAL_EVALS.md | keep | Fix stale status (P2-16) |
| docs/INTEGRATION_DESIGN.md | keep | Update :162 |
| docs/TEAM.md | keep, rewrite status section | Stale snapshot |
| docs/WORKER_RECOVERY.md | keep | Unlinked; link it |
| docs/ap-demo.md | keep | AP guide |
| docs/ap-demo-backend.md | merge → docs/ap-demo.md | Stale "next PR", Node 24.6 |
| docs/ap-demo/fake-bank.md | keep | Fix Node version |
| docs/ap-demo/validation.md, review-fixes-validation.md | keep | Commit-pinned evidence |
| docs/ci.md | keep | Trim :3-9, add browser job |
| docs/evals/README.md | keep, update | Stale rows |
| docs/evals/*.md (5 reports), docs/evals/runs/**/*.md | keep | Cited evidence; scrub paths in config.json |
| docs/invoice-mvp/ACCEPTANCE.md, ARCHITECTURE.md, CONTRACT.md, STARTUP.md | keep | Fix ports in STARTUP |
| docs/invoice-mvp/INVESTIGATOR.md | keep | Fix "NOT RUN" |
| docs/invoice-mvp/evaluation-protocol.md, evaluation-results.md, evaluation-openai-results.md | keep | |
| docs/invoice-mvp/evaluation-openai.md | merge → evaluation-openai-results.md | Same batch |
| docs/invoice-mvp/LEGACY_PROTOTYPE.md | delete | Old README copy, unlinked |
| docs/invoice-mvp/COORDINATION.md | delete | Orchestration log, local paths |
| docs/invoice-mvp/handoff-A.md, handoff-B.md, handoff-B-model-compat.md, handoff-B-openai.md, handoff-c.md, handoff-D.md | delete | Worker logs; facts are in ACCEPTANCE/eval docs |
| docs/invoice-mvp/REQUEST.txt | delete | Codex prompt |
| docs/invoice-mvp/screenshots/c-*.png (4) | delete | Only used by handoff-c; keep the 10 ACCEPTANCE uses |
| docs/payment-refactor/BROWSER.md, CONTRACT.md, RECOVERY.md | keep | |
| docs/payment-refactor/COORDINATION.md | delete | Orchestration log |
| evals/external/*/README.md, dabstep/vendor/README.md | keep | Reproduction and provenance |
| evals/invoice-mvp/README.md | keep | |
| evals/invoice-mvp/LIVE.md | merge → evals/invoice-mvp/README.md | Contradictory title |
| src/integrations/fixtures/increase/README.md | keep | Fixture provenance |

## Scripts: keep / merge / delete

> **Applied** in the same PR: `peek-world.ts` is deleted, and all eleven `smoke-*.ts` scripts run under `npm run smoke` (each passed against a fresh local backend). `convex/lib/demoEffects.ts` was left for the PR that owns `convex/`.

| Script | Verdict | Note |
|---|---|---|
| ap-demo.ts, ap-demo-options.ts, ap-worker.ts, ap-release-unsent.ts | keep | Document `ops:release-unsent` |
| control-tests.ts | keep | Write to `var/` (P2-24) |
| gateway-token.ts, invoice-mvp-server.ts, invoice-workspace-init.ts | keep | |
| invoice-mvp-smoke.ts, invoice-mvp-http-smoke.ts | keep | Add npm scripts |
| smoke-kernel.ts, smoke-memory.ts | keep | `npm run smoke` |
| smoke-close-source.ts and the 8 unwired smoke-*.ts | merge → one `npm run smoke` | Only live-Convex checks of those invariants |
| peek-world.ts | delete | Unreferenced |
| external-bench/*.py, requirements.txt | keep | Pin versions |
| testing/* (14) | keep | All referenced by npm, CI, tests or docs |
| convex/lib/demoEffects.ts | delete | No importers; rerun codegen |

## Other committed artifacts

- `src/integrations/fixtures/increase/openapi.json` (264 KB): keep. It is the pinned spec for the Prism contract tests.
- `docs/evals/*.json`, `evals/external/finbalance/*.json`: keep as evidence after scrubbing paths.
- `.hallmark/`: keep `log.json` and `preflight.json`, which the skill reads. `verification.json` is optional.
- `.claude/launch.json`: keep. Add the ignores from P2-17.
