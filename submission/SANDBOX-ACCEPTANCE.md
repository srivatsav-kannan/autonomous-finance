# AP sandbox acceptance — 25 October 2026

**Result:** one previously completed synthetic USD invoice-to-payment case is confirmed by fresh authenticated reads from QuickBooks and Increase. The current branch also repairs and verifies a QuickBooks response compatibility failure reproduced on merged main. This is **bounded external evidence, not full AP acceptance**: F1–F3 remain open and no fresh end-to-end run on the updated branch is claimed.

[Structured evidence](sandbox-evidence/2026-10-25-readback.json) contains the before/after checks, noncredential synthetic IDs, request IDs, runtime provenance and hashes of the retained private source reports. Credentials, OAuth grants, user identities, bank account/destination IDs and full provider payloads are excluded. Private original records remain on JJ's laptop; hashes identify them without publishing their contents.

## Runtime and method

- Documentation/repair base: merged main `0dce4edb44cc29c2fcbc9f3c24956c42dbb092e7`, including #105 and #92.
- Original sandbox flow: dedicated Auth0 runtime, initial base `b3c3bc6`, with its live QBO repair; retained runtime snapshot `71853508db2bb95d6d87929ab46c79db1d7b2a0f`. It is distinct from the I2 FakeBank case and I3 crash demonstration.
- Original flow evidence: 04:41 AM PDT; funding reconciliation: 04:50 AM PDT. The saved summary was updated at 04:58 AM PDT on Oct 25.
- Fresh before/after reads: timestamps and the final connector SHA-256 appear in the structured evidence. The operator loaded the existing provider configuration and the same private OAuth store; no token grant was copied or replaced.
- This pass used provider GETs, operation-marker queries and the existing scoped payments agent's read-only backend view. It submitted no new bill, payment, funding simulation, approval or bank instruction, and did not deploy or restart the live runtime. Auth0 user decisions and local funding journals below are retained evidence from the earlier run, not fresh decisions made by this pass.

## Checks and limits

| Check | Result | Evidence / scope |
|---|---|---|
| QuickBooks company and reference mappings | **PASS, rechecked** | US sandbox; nine mapped references: one vendor, seven accounts including the existing AP account, and one Class. Eight reference records were created during setup; the AP account already existed. Mapping hash is retained. |
| QuickBooks Bill | **PASS, rechecked** | Bill `145`: $678.60, exact saved economic fields and line coding; balance $0. Current SyncToken `1`; creation receipt retains `0`. Applying the payment changed the Bill version; the old receipt is not rewritten. |
| QuickBooks BillPayment | **PASS after repair** | BillPayment `146`: $678.60 linked to Bill `145`, SyncToken `0`. One matching Bill and one matching BillPayment for their respective operation markers. Each saved operation has one POST attempt. |
| Increase authentication and resources | **PASS, rechecked** | Configured USD source remains open; configured external destination remains active. No destination/account IDs are exported. |
| Increase settlement | **PASS by polling** | Exact $678.60 transfer and posted −$678.60 debit match the configured account, destination, currency and stored IDs. Raw transfer status is `submitted`; settlement is established by `settlement.settled_at` plus the posted debit, not that status word alone. |
| Local payment state | **PASS at 05:08 AM PDT; final read unavailable** | The earlier fresh scoped backend read returned one payment: execution `settled`, posting `posted`, reconciliation `matched`, amount 67,860 cents. The 05:15 AM capture could not reach the local backend; the provider reads still passed. |
| Local accounting / funding | **PASS in retained run evidence** | Recognition: Dr 5000 / Cr 2000, 67,860 cents. Settlement: Dr 2000 / Cr 1000, 67,860 cents. Test capital: Dr 1000 / Cr 3000, 67,860 cents. Two bank transactions matched; three journals; cash and bank both $0; replay posted zero new entries. This is local bank reconciliation, not formal period close or QBO bank reconciliation. |
| Human Auth0 decisions | **Retained positive evidence** | Actual Auth0 user and user-clicked final payment authorization in the earlier flow. No fresh login/logout, negative identity, expiry or second-user test in this pass. Separate stages do not prove independent people (F1/F2). |
| Signed webhook delivery | **NOT RUN** | No configured signing secret or public callback delivery evidence. Polling does not prove webhook verification. |
| Fresh full flow on updated branch | **NOT RUN** | Existing external records are reverified using the repaired current source. No new intake/approval/write sequence was performed. |
| External returns, credits, successive partial payments, complete correction matrix | **NOT RUN** | Local tests do not establish these real-provider cases. |
| Practitioner sign-off | **NOT RUN / not claimed** | The completed review is explicitly an independent Claude model review. |

## Linked record IDs

These are synthetic test records, not credentials. Keep them together; do not mix with I2's $285.60 acceptance / $100 payment.

| Record | ID |
|---|---|
| Run | `ap97-auth0-live-20261025` |
| Case / original invoice | `kd7a1bytda9wteyr3ek1srj8qn8gy4xr` / `INV-1001` |
| Local bill | `ns741jys5gph4fyfr44j66tdc58gyvxg` |
| Payment version | `q17cdf2z1zj9nv2rvmgax3dwtd8gzqyc` |
| Command | `nx74zqsc9n5cmvswe5napwp6t18gyma9` |
| Increase transfer | `sandbox_ach_transfer_spyd2r518l9gutry0hfn` |
| Increase debit | `sandbox_transaction_02j4j1ax6a81pw5y034h` |
| Recognition journal | `rx713kw9r8sbgn06y8sc9sqe8d8gzrx9` |
| Settlement journal | `rx71arac24mhdfs13bvcmwy1a18gzheq` |
| Test-funding transaction / journal | `sandbox_transaction_7in7uo3dooxz3307i4cu` / `rx73vfsg1t42av182g987kn3c58gytxg` |
| QBO Bill / request ID | `145` / `ap-2d1b7545aac02311f6d562e54826d1e3af8c273735bf` |
| QBO BillPayment / request ID | `146` / `ap-5e2eaf62b0809e1fd0c0380b0b49e21825bbdc3a8afc` |

## Compatibility failure and repair

The unmodified main connector rejected BillPayment `146` with `external_stale_or_changed`: QuickBooks omitted optional `APAccountRef`. The dedicated live runtime already contained a repair, which explains why its saved operation had succeeded while main's readback failed.

This branch ports that narrow repair into the current connector, retaining its newer dimension and merchant-processing checks. When a BillPayment omits the AP reference, every exact linked Bill or VendorCredit must prove the expected AP account, vendor and currency. A present conflicting reference, changed amount/bank/link/dimension, stale SyncToken or unsupported JournalEntry link still fails. Both normal verification and recovery use the same check.

A successful POST followed by a failed linked-record GET remains **unknown**. Recovery only queries the original operation; it cannot turn that read failure into permission to POST again. The saved request ID, original authorization and one-attempt receipt remain intact.

Validation in this branch:

- Regression reproduced first: two of the eight imported tests failed on unmodified main.
- Final QuickBooks suites: **156 tests across 19 files pass**, including linked-credit, stale-token and post-then-read-failure recovery cases.
- Application and test typechecks pass.
- Final external readback: all 11 provider checks pass, including the repaired verifier against actual BillPayment `146`. The local backend check failed in that final capture; its earlier 05:08 AM read passed and is preserved separately. This is readback of the existing operation, not another POST.
- The full repository test suite and this branch's CI were not run at evidence capture. The handoff's 1,928-test and three-job results belong to its earlier revision.

## Open AP acceptance and judging

The [independent review](review-105/REVIEW.md) still records F1–F3 high and F4–F8 medium findings. This connector repair does not fix approval segregation, payment bands, the first-wave credit bypass or supplemental acceptance of a disputed remainder. Balanced journals and one successful sandbox case do not close those findings.

The no-auto-short-pay rule remains unchanged: the reported merged-main seed-7 scenario catches 13/13 planted errors with zero false alarms, but INV-1002 and INV-1004 remain open without a human answer and the books check fails/incomplete. Historical four-seed books passes are labeled as pre-#105 in [RESULTS](../docs/RESULTS.md).

[Devpost copy](DEVPOST.md) is updated in the repo only. The live story and submission were not changed. A video URL is still needed by **Sunday, Oct 25, 9:00 AM PDT**, with a local backup at the judging table. No video link or completed submission is claimed.
