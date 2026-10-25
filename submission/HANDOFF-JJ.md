# Handoff to JJ: #105 merged, review, acceptance report, asks

From Claude, working in Srivatsav's Claude Code session. Sunday Oct 25, about 4:50 AM PT.

## 1. What got merged

| PR | Status |
|---|---|
| [#105](https://github.com/srivatsav-kannan/autonomous-finance/pull/105) | **Merged into main** as `b48885f`, exactly as you wrote it, including your rule that price and quantity discrepancies wait for a human |
| [#103](https://github.com/srivatsav-kannan/autonomous-finance/pull/103) | Closed, superseded by #105 |
| [#92](https://github.com/srivatsav-kannan/autonomous-finance/pull/92) | **Merged** as `662ee91`, after merging in main and resolving two doc conflicts (kept `COORDINATION.md` deleted per the repo cleanup, and kept your extraction follow-up note in `INVESTIGATOR.md`). 1,928 tests pass locally, and all 3 CI jobs passed. |

Before merging #105, I pushed two CI fixes to your branch:
- `f9640e9`: seven test files hardcoded `/private/tmp`, which only exists on macOS. They now use the OS temp directory.
- `e8e4edc`: the two `v6` browser tests launched Chrome from the macOS app path. They now use `CHROME_PATH`, then Mac Chrome if present, then Playwright's Chromium. The full-tests CI job now installs Chromium. All three CI jobs passed.

Srivatsav's laptop now runs merged main. The backend redeployed with your tables, 22 of 22 control tests hold, and the gateway and console are restarted.

## 2. Docs to update for the new functionality (please)

You already rewrote `submission/PITCH.md` and `docs/DEMO.md`. Three places still describe the old behavior:
- **"Books correct."** On merged main, the scored world (seed 7, model on) catches 13 of 13 planted errors with 0 false alarms, but **books fail**. INV-1002 (short shipment) and INV-1004 (price over contract) now wait for a CFO decision, and the scored run has no human answering. These still say "books correct on every account":
  - [README.md:68](https://github.com/srivatsav-kannan/autonomous-finance/blob/main/README.md?plain=1#L68)
  - [docs/RESULTS.md:11](https://github.com/srivatsav-kannan/autonomous-finance/blob/main/docs/RESULTS.md?plain=1#L11) and its §2
  - [submission/DEVPOST.md](DEVPOST.md) and the live Devpost story

  Either note that the numbers were measured before #105, or add a scripted CFO answer in the scenario so the books close.
- **The new system isn't described** in README, RESULTS or the Devpost story: the `/ap-system` case workspace, source-backed fields, separate field/bill/payment decisions, and the QuickBooks and Increase connectors.
- **How the sandbox fits.** Please add a short section. Our suggested wording is below.

> Our system keeps its own books, but a real company already has QuickBooks and a real bank. After a bill is approved, we write it into the company's QuickBooks, and after it settles we record the payment there too. Payments go out through Increase, a bank API. The QuickBooks and Increase **sandboxes** are their test versions: real APIs, fake money and fake books. Every automated test uses our own fakes (FakeBank and a mock QuickBooks). The sandbox run proves the connectors work against the real services. Verified so far: QuickBooks OAuth, company reads and the 8 reference mappings, Increase authentication and account reads, and Auth0 login. Not yet verified: one bill and one payment end to end.

## 3. Sandbox checks

**Not run by us.** Srivatsav's laptop has no QuickBooks, Increase or Auth0 credentials, and moving your QuickBooks grant here would break it, since refresh tokens rotate on every use. You're set up for it, so it's yours. Step by step, with every ID to record: [SANDBOX-CHECKLIST.md](SANDBOX-CHECKLIST.md). Increase can't reach `127.0.0.1` without a public tunnel, so report webhook verification separately from polling.

## 4. Independent review

**Claude independent model review, not an accountant or practitioner sign-off.** Full report with code references, reproduction steps and fixes: [review-105/REVIEW.md](review-105/REVIEW.md). Expected outcomes were derived from the original PDFs and policy code **before** reading your expected postings. The 15 probes in [review-105/probes/](review-105/probes/) reproduce on merged main.

The arithmetic held everywhere:
- Every journal balances, and settlement never expenses a purchase again.
- The AP subledger equals the 2000 control account.
- Credits are applied once, and closed periods reject postings.
- Duplicates create one obligation, and invoice bank text never changes the destination.
- INV-1001, the quantity hold, I2's partial acceptance and recoverable tax all match independently derived amounts.

The gaps are in controls:

| # | Severity | Finding |
|---|---|---|
| F1 | **High** | Whoever approved the bill, the supplier's new bank destination, or the callback can also release the payment. Payments have no amount limit. |
| F2 | **High** | In first-wave mode (used for the C01/I1 evidence), one person can review, approve, pay, and post a credit with free-text evidence and no linked bill. |
| F3 | **High** | A disputed remainder can never become payable on its original invoice, which pushes users to re-key it under another number. |
| F4 | Medium | The field reviewer can also cast the recognition vote. |
| F5 | Medium | A payment can ignore an available credit, and a negative AP balance doesn't block close. |
| F6 | Medium | A second invoice number for the same PO and delivery gets no duplicate warning. |
| F7 | Medium | A changed remit-to on an invoice is ignored rather than flagged as a fraud signal. |
| F8 | Medium | There's no way to void a bill recognized in error. |
| F9 | Low | One approver can clear any disputed amount with no amount routing. |
| F10 | Low | A credit can be dated before the invoice and receipt. |
| F11 | Low | Some evidence uses the legacy credit path or weak assertions. |

## 5. Acceptance report (USD scope)

| | Result |
|---|---|
| **Passed** | <ul><li>CI: all 3 jobs on `e8e4edc`</li><li>1,928 tests locally (after the #92 merge)</li><li>22/22 kernel control tests on merged main</li><li>Scored world, seed 7: 13/13 planted errors caught, 0 false alarms</li><li>Accounting arithmetic for INV-1001, quantity hold, partial acceptance, credits, duplicates and tax (independent review)</li><li>Crash recovery and browser approval smoke in CI</li></ul> |
| **Failed** | <ul><li>Scored world books check: INV-1002 and INV-1004 wait for a human by design, so the run doesn't close</li><li>Control findings F1–F3 (high) and F4–F8 (medium) above</li></ul> |
| **Not run** | <ul><li>QuickBooks Bill and BillPayment write/readback</li><li>Increase sandbox payment, settlement and webhooks</li><li>Real-operator Auth0 decisions</li><li>The exact I3 runbook (needs your private parser cache and OCR paths)</li><li>Human practitioner review</li></ul> |
| **Blockers before calling #97 done** | <ul><li>Fix F1–F3</li><li>Run the sandbox checklist</li><li>Decide the short-pay behavior for the scored world (scripted CFO answer, or update the docs)</li></ul> |

## 6. For judging

- Your pitch uses the recorded I2 case, which lives on your machine, so **run the demo from your laptop**.
- Devpost won't submit without a **video link**, and the deadline is **9:00 AM**. A local copy of the video is also required at the table.

— Claude (Srivatsav's Claude Code session)
