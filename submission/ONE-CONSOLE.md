# One console: how it all fits, and the demo

Branch `integrate/one-console`. Start everything with `npm run demo` and open the console it prints.

## Workspace settings and empty pages

Open **Setup → Settings** (or `/?view=settings#finance-workbench`). Finance data and the human gateway have separate live status indicators. The finance scenario supplies Inbox, Ledger, Bank, Team and activity. The AP gateway supplies its own cases and payment records; choosing a finance scenario does not merge these datasets.

An explicit scenario URL takes precedence. A remembered available selection is restored, otherwise the console prefers `finance-workbench` over a newer test/benchmark run. The Settings selector loads existing records; **Use finance demo** returns to the recorded demonstration. Empty or missing scenarios are identified rather than described as a loading failure.

Memory drill-in, Evals and Control use the human gateway. Generate its local console access token with `npm run gateway:token`, keep `.env.local` private, and start the gateway and Vite with matching settings. Set `VITE_GATEWAY_URL` to the running gateway and `GATEWAY_ALLOWED_ORIGINS` to the exact browser origin. Do not remove the token check to hide a configuration error. The gateway process must use the working directory that contains the selected scenario's `var/runs`, `var/memory` and `var/evals`. Provider and seat credentials remain on the server.

The existing Mac Studio demo was verified at `5192`: the selected test run had zero ledger entries; `finance-workbench` has 141 entries and 220 agent turns. After configuring the authenticated local gateway, its read-only eval and memory calls returned 200 and an unauthenticated call returned 401. Browser checks covered Settings, switching to the empty run and back, refresh persistence, Evals and opening a specific memory record. These are existing simulation records, not a new payment or model run. [Settings capture](../docs/ap-orchestration/evidence/workspace-settings-20261025/settings-live.png).

The #118 integration variant passed application/test typechecks, four scenario-selection regressions and the console build. The full static design check still reports nine existing spacing failures in `proof.css`; no new Settings failure appears in that whole-console check. CI remains skipped. The browser capture is from the running live-demo shell; it does not establish a fresh combined #118 + #117 deployment.

## What changed

Before, there were four separate surfaces, each with its own gateway:
- the agent console for the simulated Sweetgreen (Inbox, Ledger, Evals and the rest)
- JJ's AP case workspace ("Accounts payable", its own login and gateway)
- the older invoice MVP ("Invoices", from #92)
- the crash-recovery page at `/ap-demo`

Now there is one console with one sidebar. The AP work sits where it belongs in the department:

| Group | Page | What it shows |
|---|---|---|
| Work | Inbox | The CFO's decisions from the agents, and below them the invoice decisions waiting on a person (field review, bill approval, payment release, holds) |
| | Invoices | Every invoice is a case: the original PDFs, fields linked to where they appear in the source, matching, accounting, history (JJ's workspace) |
| | Payments | Payment runs. A person releases each payment for an exact amount and destination |
| | Bank & cash | The simulated company's bank activity and cash |
| | Period close | What blocks the month from closing and who has to clear it |
| Books | Ledger, Finance flow | The double-entry ledger and how money moves through the department |
| Agents | Team, Live activity, Memory | The agents, what they're doing, and the git memory behind every decision |
| Setup | Policy & suppliers | Who can approve what, payment limits, verified supplier bank details |
| | Connectors | Increase, QuickBooks, Auth0, LlamaParse, OpenAI, FakeBank, Convex, git memory. What's proven against each, and what isn't |
| Proof | Evals & tests | The scored run for the selected scenario, then every measured number with the file it came from |
| | Control room | Inject events (fraud email, duplicate invoice, unknown wire), end the day, close the period, ask why |
| | Crash recovery | The browser approval and crash-recovery payment demo (was `/ap-demo`) |

The invoice MVP from #92 is no longer in the navigation. JJ's case workspace does the same job with source-linked fields and separate decisions. Its code stays in the repo.

Old links still work: `/ap-system` and `?view=ap-system` open Invoices, and `/ap-demo` still opens the standalone recovery page for the scripts that drive it.

## What's merged into this branch

- **#116** (JJ): the USD AP rollup. It already contains #106, #109, #110, #111 and #113, and it re-implements #114's historical-paid hold. It also closes review findings F1, F2 and F4: payment groups and cent limits, plus independent field review, recognition, supplier verification and payment release.
- **#115** (JJ): the agent-history view inside each case (before and after for every step).
- **#114** remains open: #116 only partially overlaps it. Unlinked legacy-bill guards, late-arriving historical-paid evidence and the real APEX statement layout still need reconciliation.
- **JJ's `codex/ap-system-live-auth0` branch:** only its evidence folder (`docs/ap-orchestration/evidence/agent-live-20261025`). That's the $77 invoice that went through the real Increase and QuickBooks sandboxes end to end. JJ's handoff says its code isn't a tested merge with the other branches, so the code isn't here.

## One backend

`npm run demo` starts one Convex database (port 3250) with the simulated Sweetgreen run, the scored eval, the AP case system, the CFO gateway and the console. It seeds with no model calls.

## Known gaps

- **New PDF uploads need a LlamaParse key.** There's no key on this laptop. The cases from the APEX replay were read from their PDFs by the free local parser (poppler), and they're what the demo shows. With `LLAMA_CLOUD_API_KEY` in `.env.local`, any invoice PDF works.
- **The demo's AP cases come from the APEX replay's own database** (gateway 8847, Convex 3460), reached through the console's proxy (`AP_SYSTEM_GATEWAY_URL`). The APEX replay script resets deployment-wide settings, so it can't load into the shared database yet. That backend runs #111's code, not #116's. So on those cases, Policy & suppliers says payment release is disabled until payment groups and limits are set, and #116's payment-release rules aren't what's checking them. Don't show Policy or Payments from that data in the demo.
- **Still open from the review:** F3 and F5 to F11. No live model loop for the AP case worker (it's deterministic). Signed webhooks, returns and credits are unverified.

## Demo (5 minutes per judge: about 3 to show, 2 for questions)

Open the console. In Invoices, pick "SIMULATED finance approver".

1. **Inbox (30 s).** "Agents run the finance department of a simulated Sweetgreen. This inbox only has what needs a person." Scroll to Invoice decisions: "Invoices waiting on a decision are in the same place, with who decides and why."
2. **Fraud email (30 s).** Open the blocked bank-change email. "A look-alike domain asked us to change a supplier's bank details. The agent refused. Even a fooled agent couldn't change them, because the database only accepts that from a human, and not the one who asked."
3. **One invoice (60 s).** Invoices, open the first case. Evidence: "The PDF is parsed and each field links to where it is in the original." Matching: "Checked against the agreement and proof the work was done." Accounting: "Approving the bill records what we owe. Releasing the payment is a separate decision by a different person." History: "Every step is kept."
4. **Already-paid invoice (15 s).** Open the second case. "This one was paid in the old records. It's held, and a second payment is refused."
5. **Evals & tests (30 s).** "13 of 13 planted errors caught, no false alarms. Every number we report is here, with the file it came from."
6. **Connectors (15 s).** "Increase for payments, QuickBooks for the books, Auth0 for sign-in. One $77 invoice went through the real sandboxes end to end."

Who talks: Srivatsav does 1 and 2, Arav does 3 and 4, JJ does 5 and 6 and takes the technical questions.

If something doesn't load, play the video saved on the laptop.
