# AP demo validation record

Validated implementation commit `3f7013548271830abda7c5b8cee3f65008b654be` on main `adbe32c8b1d9fd5ba426b43ba5b5d1e52e58f1e8`, using Node 24.18.0. The accompanying [machine-readable record](validation.json) separates simulator, provider-contract and sandbox results and includes the source/fixture/specification hashes. No sandbox payment or real identity-provider login is claimed.

| Command/check | Observed result |
| --- | --- |
| `npm ci` | Passed with the committed lockfile; development audit caveat below |
| `npm run typecheck` | Passed |
| `npm run typecheck:backend` | Passed |
| `npm run typecheck:tests` | Passed |
| `npm test` | 246 tests in 24 files passed, including 12 FakeBank, 32 backend/recovery, 30 Increase adapter and 4 Prism contract tests |
| `npx vite build --config console/vite.config.ts` | Passed |
| `AGENT_LLM=off npm run smoke` against the local deployment | 25 kernel and 17 Git-memory checks passed |
| `npm run demo:local` against real local Convex | Passed: one $662.90 transfer, one posted debit, one matched cash journal entry, no close blockers |
| `npm run demo:sandbox` | **NOT_RUN**, exit 2: missing sandbox account/key/beneficiary and authenticated application prerequisites |
| `npm audit --omit=dev` | Zero vulnerabilities |
| `npm audit` | **Fails**: six high findings propagated from one development-only Faker advisory |

The full test suite includes the focused `test:bank`, `test:payments` and `test:contracts` scripts. An earlier full run had three Git-heavy tests time out during a long host pause; those three files passed on rerun, and the final complete suite above passed in 6.51 seconds. The passing counts refer to the final run.

## Headline recovery evidence

The coordinator used seeded Worldsim invoice evidence and the actual Convex approval, dispatch and reconciliation functions. Human authentication was explicitly simulated through the local administrator identity fixture. After the bank accepted, the dispatcher process exited before saving a response. The next process reclaimed the expired lease and replayed the saved request/key. Bank notifications were dropped, then polling imported and posted the actual bank transaction. A second evidence pass posted nothing.

- Application run: `ap-local-1792830308018`.
- Approved version and immutable bank command: `m1771fc9qcgevvayzwq6p6xtj58gw52b`.
- Convex command row: `k17chqwkxqtq04ydb82kkd6dss8gx66w`.
- Transfer: `transfer_2f0d94334d3476afd70098d4`.
- Posted bank debit: `txn_c40f8119bc7e249cc73725db`.
- Matching cash journal entry: `mh734ztkvyq34md40qazbcyaw18gwd8g`.
- Two dispatcher attempts and two `createTransfer` calls yielded one bank transfer; execution is `settled`, posting is `posted`, reconciliation is `matched`.

The full report and persistent bank file remain in `var/ap-demo/ap-local-1792830308018/` in the validation checkout. These local artifacts are ignored by Git; the committed record contains the non-secret proof identifiers and summaries. Follow the [demo guide](../ap-demo.md) to produce a fresh run and its own IDs. Preserve the bank file when exercising application-only restart recovery.

## Remaining validation and integration work

Live Increase acceptance, settlement, returns and external webhook delivery require sandbox credentials and configured account/beneficiary details. Real human JWT verification requires an issuer/audience, a matching authenticated principal and the deployment's scoped service credentials. The sandbox preflight records every missing variable; local simulation and Prism success do not satisfy this gate.

The full dependency audit remains blocked by Prism's legacy Postman/Faker dependency. Supported lodash/uuid overrides are pinned; the incompatible Faker major upgrade is not forced. See the [exact advisory and dependency chain](../../src/integrations/fixtures/increase/README.md#development-dependency-audit).

The implementation stack is #47 (bank), #49 (backend dispatch/reconciliation), then `codex/ap-demo-increase` (adapter/demo). Main includes prerequisite PRs #32–36 and #41–46. Existing open PR #48 implements a different recovery path for legacy simulated payments and overlaps payment-handler/runtime files; reconcile that overlap explicitly during review. This stack removes bank submission from the legacy agent runtime and requires fresh scoped demo runs. Historical submitted payments are not backfilled or replayed. Nothing was merged or closed as part of this work.
