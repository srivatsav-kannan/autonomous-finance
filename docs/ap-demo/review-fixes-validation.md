# AP review fixes: validation record

## Close-signature follow-up

Validated source `8eed9ab8a9c9b44ca4177d64c534a5076623f300`, including the #49
snapshot fix `9752272`. The [follow-up record](close-signature-validation.json)
contains the fresh run IDs and persisted close snapshot hashes. #49 passed 224
tests; the full #50 stack passed 268 tests, all three typechecks, the console
build and the whitespace check. Ten new regression cases cover both signature
orders after another payment or sandbox funding, changes to non-journal evidence,
duplicate replay, concurrent signatures and pre-upgrade partial signatures. All
six standalone reproductions from the re-review now pass as well.

A fresh real local Convex/FakeBank recovery run again produced one $662.90
payment and cash journal effect after the lost response and worker restart. A
fresh browser approval with the local OIDC test identity produced one $100
settled/posted/matched payment and zero blockers. Both periods persisted two
signers and a close snapshot hash. Wrong-audience and expired JWTs were rejected;
the browser reported no console warnings or errors. External Increase, production
identity-provider login and external webhook delivery remain **NOT_RUN**.

## Original five-fix validation

Validated implementation `83b23abe19e9820d69269e1e22f1c0890ce25d46` on Node
24.22.0. The #49 fixes are in `095bbbe`; #50 includes them and the Increase fixes.
The [machine-readable record](review-fixes-validation.json) contains run IDs and
non-secret proof identifiers. The [earlier record](validation.md) is preserved
as historical evidence rather than overwritten.

| Check | Result |
| --- | --- |
| Full test suite | 258 tests across 26 files passed; 12 new regression cases |
| Application, backend and test typechecks | All passed |
| Vite console build and diff whitespace check | Passed |
| Local recovery against real Convex and persistent FakeBank | One $662.90 transfer and posted debit after two dispatch attempts; lost response, process restart and dropped notifications recovered |
| Local browser approval | Signed local OIDC test identity authenticated in `/ap-demo`, approved $100, and refreshed to `settled / posted / matched`, one attempt, zero blockers |
| JWT rejection checks against real local Convex | Wrong audience and expired token rejected |
| Close | Controller signature followed by human-identity signature closed each tested period |
| Funded Increase and mixed-activity regressions | Passed with real adapter/workers/Convex handlers and mocked provider HTTP |
| External Increase sandbox | **NOT_RUN**: provider and authenticated sandbox configuration unavailable |
| Production identity-provider login / external webhook delivery | **NOT_RUN** |

The browser fixture uses a temporary loopback OIDC issuer and synthetic identity;
it exercises the backend's JWT validation rather than `setAdminAuth`, but is not
evidence of a production user login. The separate crash-recovery runner retains
its explicit `local_admin_simulated_human` label. Neither exercise calls Increase.

Regression coverage in `tests/demo-review-regressions.test.ts` verifies canonical
invoice replay, one payable amount, controller/human resolution after payment,
unchanged journal/bank effects, and rejection of unauthorized or stale resolutions.
`tests/demo-increase-regressions.test.ts` verifies explicit funding classification
and cash posting, unrelated ACH collections, signed foreign-account notifications,
unresolved failures that must continue blocking, unselected funding and atomic
rollback on failed journal posting. Funding notifications are verified and imported
without requiring a fictitious ACH command.

Reproduce the local and browser flows with the [demo guide](README.md).
The full reports remain in the ignored `var/ap-demo/` directories named in the
JSON record. Fresh runs generate new IDs. Existing pre-fix demo runs should be
reviewed and retired without replaying any historical payments.
