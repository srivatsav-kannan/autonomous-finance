// Measured results for the console "Evals & proof" page.
// Every number below comes from the file named in `source`. Paths are repo-relative.

export type ProofStatus = "passed" | "failed" | "partial" | "not_run";

export type ProofItem = {
  id: string;
  title: string;
  status: ProofStatus;
  headline: string;
  detail: string;
  how: string;
  source: string;
  command?: string;
  measuredAt?: string;
};

export type ProofGroup = {
  id: string;
  title: string;
  summary: string;
  items: ProofItem[];
};

export const PROOF_GROUPS: ProofGroup[] = [
  {
    id: "scored-world",
    title: "Simulated Sweetgreen, scored",
    summary:
      "A simulated company with planted errors and an answer key the agents never see. The current run catches every planted error but the books do not close, because two invoices wait for a human decision.",
    items: [
      {
        id: "seed7-current",
        title: "Seed 7 after #105, model on",
        status: "partial",
        headline: "13/13 errors caught, 0 false alarms, books check fails",
        detail:
          "INV-1002 (short shipment) and INV-1004 (price over contract) now wait for a CFO decision instead of being short-paid. The unattended run has no human answer, so the books check fails or stays incomplete. No scripted CFO answer was added to make it pass. This result was reported by the other operator on merged main and was not rerun for RESULTS.md.",
        how: "The scored world ran on merged main with the model on and was compared to the answer key.",
        source: "docs/RESULTS.md:11 (Current AP acceptance after #105), submission/HANDOFF-JJ.md#2",
        command: "npm run scenario",
        measuredAt: "2026-10-25",
      },
      {
        id: "seeds-historical",
        title: "Four seeds before #105 (historical)",
        status: "passed",
        headline: "13/13 caught, 3/3 look-alikes left alone, books matched on seeds 7, 11, 23, 42",
        detail:
          "Historical. These runs predate the rule that quantity and price discrepancies wait for a human. Each run read 64/64 invoices with 0 false alarms. Each used 11 model calls across 218 tasks. Cost was $0.044 to $0.048 per run and wall time was 71 to 82 s. They do not predict a books pass on current main.",
        how: "Each seed played 3 stores for 14 days with 13 planted errors and 3 look-alikes, then the books were checked against an independent ledger on every account.",
        source:
          "docs/RESULTS.md#2-simulated-company-historical-before-105, docs/evals/runs/final/eval-openai-s7-mvncqkan.json",
        command: "npm run evals -- --paid --budget-usd 15",
        measuredAt: "2026-10-24 to 2026-10-25 (before #105)",
      },
      {
        id: "claude-vs-generalist",
        title: "Earlier comparison with one generalist agent",
        status: "passed",
        headline: "Team $0.15 and 87 s vs generalist $7.80, 42 min, 12/13 caught",
        detail:
          "Same world, seed 7, with Claude instead of OpenAI. One generalist agent had the same tools. This is an older historical run.",
        how: "The same seed was run once by our agent team and once by one generalist agent.",
        source: "docs/RESULTS.md#2-simulated-company-historical-before-105, docs/evals/runs/baseline-s7-mvm30964.md",
      },
    ],
  },
  {
    id: "public-benchmarks",
    title: "Public benchmarks",
    summary:
      "15 public tasks from APEX-Accounting, DABstep, Invoice Sandbox and FinBalance. Our agent team scored 93.3% and the same model alone scored 84.0%. Each task ran once.",
    items: [
      {
        id: "public-total",
        title: "All 15 tasks",
        status: "passed",
        headline: "Team 93.3% (14 of 15) vs model alone 84.0% (12 of 15)",
        detail:
          "The team cost $4.06 over 135 model turns and 537 s. The model alone cost $2.33 over 74 turns and 292 s. The team uses about 1.7x the cost and 1.8x the time because every answer is checked a second time. The team's payroll and DABstep 1753 results come from a rerun after a harness fix (#90). Before that fix the team scored 86.7%.",
        how: "Same model, same evidence tools and a 30-turn budget per task, run once as a specialist-plus-controller team and once as the model alone.",
        source: "docs/RESULTS.md#3-public-benchmarks-our-team-vs-the-same-model-alone, submission/DEVPOST.md:103",
        command: "npm run evals -- --paid --budget-usd 15",
        measuredAt: "2026-10-24 to 2026-10-25 (before #105)",
      },
      {
        id: "apex",
        title: "APEX-Accounting (3 tasks)",
        status: "passed",
        headline: "Team 3/3 at 100% vs model alone 2/3",
        detail:
          "AR reconciliation (#13) and payroll reconciliation (#17) scored 100% in both modes. On AR aging exposure (#30) the team scored 100% and the model alone 60%. The grader was gpt-6-astra at low effort. The public leaderboard uses 100+ private tasks over 4 runs, so the numbers are not directly comparable.",
        how: "Three public APEX tasks were graded with our own rubric grader.",
        source: "docs/RESULTS.md#3-public-benchmarks-our-team-vs-the-same-model-alone",
      },
      {
        id: "dabstep",
        title: "DABstep (5 tasks)",
        status: "passed",
        headline: "Team 5/5 vs model alone 4/5",
        detail:
          "Tasks 1273, 1305, 1753 and 1871 scored 100% in both modes. On 1681 (applicable daily fee IDs) the team scored 100% and the model alone 0%. These are public dev tasks, not the 450 hidden ones.",
        how: "Answers were scored with exact sets and numeric tolerances.",
        source: "docs/RESULTS.md#3-public-benchmarks-our-team-vs-the-same-model-alone",
      },
      {
        id: "invoice-sandbox",
        title: "Invoice Sandbox (1 task)",
        status: "passed",
        headline: "18/18 customers in both modes",
        detail: "Net spend for 18 customers was exact in both modes. The benchmark is saturated, since the author's best is also 18/18.",
        how: "The answer was compared to the benchmark's expected net spend per customer.",
        source: "docs/RESULTS.md#3-public-benchmarks-our-team-vs-the-same-model-alone",
      },
      {
        id: "finbalance",
        title: "FinBalance (6 records)",
        status: "partial",
        headline: "Balance sheets 4/4 exact, contradiction codes 1/2, same in both modes",
        detail:
          "In team mode the controller's journal entries are posted through our ledger and the balance sheet is read back from it. One of the two contradiction-code records was wrong in both modes. Our records are difficulty levels 1 to 2.",
        how: "Balance sheets and contradiction codes were compared exactly to the benchmark records.",
        source: "docs/RESULTS.md#3-public-benchmarks-our-team-vs-the-same-model-alone",
      },
    ],
  },
  {
    id: "tools-vs-spreadsheet",
    title: "Kernel tools vs spreadsheet tools",
    summary:
      "The same model did the same 11 tasks twice, once with our 4 ledger tools and once with 4 spreadsheet tools on a real .xlsx ledger. The kernel run used fewer calls, less time and less money.",
    items: [
      {
        id: "with-model",
        title: "Same model, 11 tasks, seed 7",
        status: "passed",
        headline: "12 vs 71 tool calls, 45 vs 94 s, $0.12 vs $0.48",
        detail:
          "Verified against the raw report. Kernel: 12 tool calls, 22 turns, 45,248 ms, $0.115, 4 of 4 planted errors caught, 0 tasks with errors. Spreadsheet: 71 tool calls, 50 turns, 94,341 ms, $0.484, 3 of 4 caught, 2 tasks with errors. Neither side finished the books because held bills need a controller, so the kernel run differs from the answer key in 6 places and the spreadsheet run in 13. The raw report also records one look-alike flagged in the kernel run (decoysFlagged 1). Model gpt-6.1-sol at medium effort.",
        how: "One run per side on seed 7, 1 store, 2 days, with 4 planted errors, scored against the answer key.",
        source: "docs/evals/runs/final/sheets-agent-model-s7-mvncnkcd/report.json, docs/RESULTS.md#with-a-model",
        command: "npm run eval:sheets-agent",
        measuredAt: "2026-10-25T04:52:59Z",
      },
      {
        id: "no-model",
        title: "156 bookkeeping operations, no model",
        status: "passed",
        headline: "Kernel stopped 15 of 18 bad operations up front and caught the other 3 later. The workbook never caught 10.",
        detail:
          "Kernel: 1 tool call per operation, 0.12 ms per operation at both the start and end of the month. Workbook: 5.8 calls per operation, 0.20 ms rising to 2.23 ms by month end. The workbook caught 8 bad operations after the fact and missed 10, including self-approval, posting to a closed period and fractional cents. Both paths produce identical books when no bad operations are injected.",
        how: "156 operations from seed 7 (3 stores, 14 days) were applied to the kernel and to an .xlsx workbook over ten trials, with medians shown.",
        source: "docs/RESULTS.md#without-a-model, docs/evals/spreadsheet-vs-kernel.md",
        command: "npm run eval:sheets-bench",
      },
    ],
  },
  {
    id: "ap-cases",
    title: "AP case evidence",
    summary:
      "Single AP cases run from original PDFs through review, approval, payment and bank matching. All of these use FakeBank or simulated people unless the sandbox group says otherwise.",
    items: [
      {
        id: "i1",
        title: "I1: original PDF to settled payment",
        status: "passed",
        headline: "$678.60 invoice: one transfer, one bank debit, two journals, AP $0",
        detail:
          "Four original PDFs were uploaded. All 22 frozen expected fields passed and 35 fields were inspected, with 33 source locations and 2 left unresolved. Field review, bill approval and payment authorization were separate steps, and an early payment request was refused. Two worker runs left one transfer and one debit. This run used one operator for every step, so it is now labeled a single-operator rehearsal (review finding F2). FakeBank only, no Increase or QuickBooks.",
        how: "A local run uploaded the originals over HTTP, then the verify and worker scripts checked stages, journals and bank records.",
        source: "docs/ap-orchestration/evidence/I1-integrated.md, docs/ap-orchestration/USD-INTEGRATION-STATUS.md#migration-and-local-operation",
        measuredAt: "2026-10-25",
      },
      {
        id: "i2",
        title: "I2: partial acceptance with several people",
        status: "partial",
        headline: "$678.60 invoice: $285.60 accepted, $393.00 disputed, $100 paid, $185.60 still owed",
        detail:
          "Accepted units were kale 2, romaine 2, avocado 1 and tomato 1. Recognition posted Dr 5000 / Cr 2000 $285.60 only after the final separate finance vote. A $100 payment settled with one transfer and one debit after a second worker cycle. The period readback keeps AP general ledger and subledger at $185.60 with zero difference. Six blockers remain and no period close was done. The case is partially paid, not cleared. Identities and FakeBank settlement were simulated.",
        how: "Four original PDFs went through the browser into a separate local run, with five labelled simulated people voting.",
        source: "docs/ap-orchestration/evidence/I2-business-flow.md",
        measuredAt: "2026-10-25",
      },
      {
        id: "v2",
        title: "V2: lost bank response and other failure paths",
        status: "passed",
        headline: "Lost bank response recovered with exactly one transfer create call",
        detail:
          "When the bank accepted a payment but the response was lost, the system reopened the bank store and found the original transfer instead of sending again. A settled payment with interrupted local posting posted once after repair and zero times on retry. Missing receipts, quantity conflicts and stale approvals were all refused with no bank operation. 34 of 34 tests passed (15 new, 19 existing).",
        how: "An independent verifier ran each scenario on a fresh test database with its own SQLite FakeBank.",
        source: "docs/ap-orchestration/evidence/V2.md#results-and-counts",
      },
      {
        id: "v7",
        title: "V7: parser repair on held-out invoices",
        status: "passed",
        headline: "104/104 fields correct, 102/104 with exact source locations",
        detail:
          "Before the repair, the same cached parser jobs gave 0 of 4 complete candidates and 72/104 exact locations. After the repair all 4 were complete and all 104 fields correct. The two missing locations are currency fields left marked unresolved instead of guessed. The replay made 0 network calls. The samples are project-authored, so this is not a general accuracy claim.",
        how: "An independent verifier replayed four cached parser jobs through the repaired mapper and scored every field against values derived before the answer key.",
        source: "docs/ap-orchestration/evidence/V7-parser-repair.md",
      },
      {
        id: "apex-107",
        title: "APEX #107 replay: open invoice",
        status: "passed",
        headline: "Case 1: $3,000 bill settled and matched, outstanding $0",
        detail:
          "All 21 APEX invoices parsed and each matched one ledger row. Case 1 was refused payment before a bill and held for missing contract and receipt. After simulated agreement and acceptance documents, it posted Dr 6000 / Cr 2000 $3,000, paid through one FakeBank transfer, and matched one posted debit. Repeat worker passes posted 0. The agreement, acceptance, contact and beneficiary are simulated because APEX has none. No model, LlamaParse, Increase, QuickBooks or Auth0 calls.",
        how: "A local replay ran the APEX World 9 files through the AP system with FakeBank and six simulated people.",
        source: "docs/ap-orchestration/evidence/apex-107/README.md#stage-table",
        measuredAt: "2026-10-25",
      },
      {
        id: "apex-107-case2",
        title: "APEX #107 replay: invoice already paid in 2024",
        status: "passed",
        headline: "Case 2: $3,500 historical payment, 12/12 source checks, new payment refused",
        detail:
          "The ledger, bank export, general ledger, aging report and April 2024 statement all agree on one $3,500 check. The payment request was refused with no bill, journal or transfer. Re-import made no duplicates: still 2 cases, 1 bill, 1 payment version, 1 command, 2 journals, 1 bank row and 1 transfer. In the original #107 run the UI still offered business approval on case 2, which is the gap #112 fixed.",
        how: "The replay checked 12 fields across the source files and then tried to pay and re-import.",
        source: "docs/ap-orchestration/evidence/apex-107/README.md#case-2-historical-source-outcome",
        measuredAt: "2026-10-25",
      },
      {
        id: "historical-hold",
        title: "#112 historical-paid hold",
        status: "partial",
        headline: "Source-paid invoices keep a backend hold that blocks approval and payment",
        detail:
          "On its own branch, #112 returned historical_payment_hold for approval, payment and payment after re-import, and its full suite passed 1,963 with 4 skipped. That branch's commit is not in this branch. Instead #116 carries the guard as apCases.recordHistoricalPayment, which binds the hold to the invoice, amount and source hashes. No separate hold run on this branch is recorded. No file in this repo mentions #114.",
        how: "The #112 branch reran the APEX replay and the full test suite locally. This branch's status doc describes the integrated guard.",
        source:
          "git show origin/codex/apex-historical-paid-112:docs/ap-orchestration/evidence/apex-112/README.md, docs/ap-orchestration/USD-INTEGRATION-STATUS.md#implemented-controls",
      },
      {
        id: "agent-worker",
        title: "AP case agent and stored history",
        status: "passed",
        headline: "Worker survived a real SIGKILL. 107 regression tests and 15 targeted tests passed.",
        detail:
          "The case agent waits for missing evidence, resumes when it arrives and proposes payment after independent review. A human still authorizes payment. The transition evidence run passed 893 AP regression tests across 117 files. The history UI passed 8 presentation tests and 1 mounted browser test with 0 API calls. No model or external provider was called.",
        how: "Local Convex-test runs with SQLite FakeBank and simulated people, including a killed worker and an expired lease.",
        source:
          "docs/ap-orchestration/evidence/agent-case-v1/manifest.json, docs/ap-orchestration/evidence/agent-transition-v1/manifest.json, docs/ap-orchestration/evidence/agent-history-ui-v1/manifest.json",
        command: "npm run agents:ap -- --config <private JSON> --once",
        measuredAt: "2026-10-25T12:09:39Z",
      },
    ],
  },
  {
    id: "sandbox",
    title: "Real sandbox evidence",
    summary:
      "One synthetic $678.60 invoice went through real Auth0 login, the Increase bank API sandbox and the QuickBooks Online sandbox. Signed webhooks, returns and credits are not verified.",
    items: [
      {
        id: "live-agent-77",
        title: "Full sandbox run with the case worker, $77 invoice",
        status: "passed",
        headline: "Missing receipt wait, two separate approvals, Increase settlement, QuickBooks Bill 147 and BillPayment 148, bank matched.",
        detail: "Synthetic invoice INV-AGENT-20261025-01. The case waited for a missing document, resumed when it arrived, then a person approved the bill and a different step released the payment. Final state: settled, matched, $0 outstanding, two journals (Dr 5000 / Cr 2000, then Dr 2000 / Cr 1000). The case worker is deterministic, not a model loop. It ran on JJ's laptop from a recovered database copy.",
        how: "JJ ran it against the real Increase and QuickBooks sandboxes, and the readbacks were saved afterwards without new provider calls.",
        source: "docs/ap-orchestration/evidence/agent-live-20261025/flow-summary.json",
        measuredAt: "2026-10-25",
      },
      {
        id: "qbo-bill",
        title: "QuickBooks Bill and BillPayment",
        status: "passed",
        headline: "Bill 145 and BillPayment 146 for $678.60, Bill balance $0",
        detail:
          "Each record exists once under its operation marker with one POST attempt. QuickBooks left out the optional AP account reference on BillPayment 146, which main's connector rejected. The repaired connector checks it through the linked Bill instead, and 156 QuickBooks tests across 19 files pass. The records were rechecked later with fresh reads. The handoff note lists these writes as not run, but the newer sandbox report supersedes it.",
        how: "Fresh authenticated GETs read the existing records back. No new POST was made in the recheck.",
        source: "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits, docs/ap-orchestration/evidence/C4-live-happy-path.md",
        measuredAt: "2026-10-25 04:41 PDT (flow), rechecked later that morning",
      },
      {
        id: "increase-transfer",
        title: "Increase transfer matched to its debit",
        status: "passed",
        headline: "One $678.60 ACH transfer matched one posted -$678.60 debit",
        detail:
          "Settlement is shown by settlement.settled_at plus the posted debit, since the raw transfer status still says submitted. The sandbox simulator was used for submit and settle. A $678.60 test deposit was classified as test capital, and local cash matched the Increase balance at $0 with two matched bank rows and three journals. This is local bank matching, not a formal month close.",
        how: "The transfer and debit were polled from the Increase sandbox API and compared to the stored IDs, account and amount.",
        source:
          "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits, docs/ap-orchestration/evidence/C4-funding-reconciliation.md",
        measuredAt: "2026-10-25 04:50 PDT (funding reconciliation)",
      },
      {
        id: "auth0-login",
        title: "Auth0 live login",
        status: "passed",
        headline: "A real user logged in through Auth0 and clicked the final payment authorization",
        detail:
          "Login went through the existing Google connection, then the observed identity was bound to the workspace. No token was copied or faked. Logout, expired tokens, wrong issuer or audience, and a second user were not tested. Separate approval stages here do not prove separate people (findings F1 and F2).",
        how: "The user signed in in a real browser and the app showed the identity verified by Convex.",
        source: "docs/ap-orchestration/evidence/C2-auth0-live.md, submission/SANDBOX-ACCEPTANCE.md#checks-and-limits",
        measuredAt: "2026-10-25",
      },
      {
        id: "qbo-mappings",
        title: "QuickBooks reference mappings",
        status: "passed",
        headline: "8 reference records created and read back, replay made 0 POSTs",
        detail:
          "The 8 created records are one synthetic supplier, six accounts and one store Class. The existing Accounts Payable account was verified and reused, so the newer sandbox report counts nine mapped references in total.",
        how: "Each record's name, type, currency and ID was read back before the mapping was saved, then a full replay reused every ID.",
        source: "docs/ap-orchestration/evidence/C4-live-mappings.md, submission/SANDBOX-ACCEPTANCE.md#checks-and-limits",
        measuredAt: "2026-10-25T10:08:15Z",
      },
      {
        id: "signed-webhooks",
        title: "Signed webhook delivery",
        status: "not_run",
        headline: "Not verified",
        detail: "No signing secret or public callback was configured. Polling does not prove webhook verification.",
        how: "Not measured.",
        source: "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits",
      },
      {
        id: "returns-credits",
        title: "Returns, credits and repeated partial payments",
        status: "not_run",
        headline: "Not verified against real providers",
        detail:
          "External returns, credits, successive partial payments and the full correction matrix were not run. A fresh end-to-end flow on the updated branch was also not run.",
        how: "Not measured.",
        source: "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits",
      },
    ],
  },
  {
    id: "tests-and-controls",
    title: "Tests, controls and review findings",
    summary:
      "Kernel controls hold 22 of 22 and the full suite passes on this branch. An independent Claude review found 11 control and lifecycle gaps. #116 fixes three of them. The rest are open.",
    items: [
      {
        id: "kernel-controls",
        title: "Kernel control tests",
        status: "passed",
        headline: "22 of 22 hold",
        detail:
          "19 bad actions are refused, including a bill with no source document, paying a bill twice, approving your own payment and a payment of $50k or more without a human. Three positive checks also pass: the hash chain verifies, a real bank transaction books, and a cash entry can be reversed. These tests cover kernel boundaries only, not every AP approval policy.",
        how: "Each case runs against the live kernel and git memory.",
        source: "docs/evals/control-tests.json, docs/RESULTS.md#4-controls-and-payment-recovery, scripts/control-tests.ts",
        command: "npm run controls",
        measuredAt: "2026-10-25T06:37:42Z",
      },
      {
        id: "full-suite-116",
        title: "Full test suite on this branch (#116)",
        status: "passed",
        headline: "1,994 passed, 4 skipped, 0 failed",
        detail:
          "Source, backend and test type checks passed. The console build passed with an existing chunk-size warning. Earlier counts were 1,928 on main after #92 and 1,963 passed with 4 skipped on the #112 branch. The new payment-limit form was checked at 390 and 1440 px in light and dark themes in an isolated preview. No live model, Increase, QuickBooks or Auth0 call was made.",
        how: "Vitest ran the whole repository with four workers on commit ca62ed9.",
        source:
          "evidence/usd-integration-20261025/validation.json, docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/HANDOFF-JJ.md#1",
        command: "npm test -- --maxWorkers=4",
        measuredAt: "2026-10-25",
      },
      {
        id: "recovery-smoke",
        title: "Payment recovery and browser approval smoke",
        status: "passed",
        headline: "Worker crash leaves 1 transfer, 1 debit and 1 journal entry",
        detail:
          "The bank accepts a $100 payment and the response is lost. The dispatcher is killed. After the lease expires, a new dispatcher resends the saved request with the same key and gets the original transfer back. The month closes with the controller's and the human's signatures. Crash recovery and browser approval smoke passed in all 3 CI jobs on e8e4edc.",
        how: "The local demo runs the crash scenario against FakeBank, and CI runs it on every pull request.",
        source: "docs/RESULTS.md#4-controls-and-payment-recovery, submission/HANDOFF-JJ.md#5",
        command: "npm run demo:local",
      },
      {
        id: "accounting-review",
        title: "Independent review: accounting arithmetic",
        status: "passed",
        headline: "Every journal balanced. 58 expected entries balance.",
        detail:
          "The review derived expected outcomes from the PDFs and policy code before reading the PR's expected postings. INV-1001, the quantity hold, partial acceptance, credits, duplicates and recoverable tax matched. This is a Claude model review, not a human accountant sign-off.",
        how: "15 probes ran in memory on convex-test and FakeBank with no providers or model calls.",
        source: "submission/review-105/REVIEW.md#derived-expectations-vs-actual",
      },
      {
        id: "F1",
        title: "F1 (high): payment release separated from bill and bank approval, with amount limits",
        status: "passed",
        headline: "Fixed in #116",
        detail:
          "Payments now need explicit payment groups and cent limits. The field reviewer, bill approvers, supplier callback verifier and destination approver cannot release the same payment. Checked by local tests only. No independent re-review yet.",
        how: "The full local suite on ca62ed9 covers the new release-policy gate.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#implemented-controls, submission/review-105/REVIEW.md#f1",
      },
      {
        id: "F2",
        title: "F2 (high): one person could review, approve, pay and post a credit in first-wave mode",
        status: "passed",
        headline: "Fixed in #116",
        detail:
          "First-wave cases now need configured payment authorizers with cent limits, and the free-text recordCredit path is turned off once a run has AP cases. The old I1 evidence is kept but labeled as a single-operator rehearsal. Checked by local tests only.",
        how: "The full local suite on ca62ed9 covers the new rules.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#implemented-controls, submission/review-105/REVIEW.md#f2",
      },
      {
        id: "F3",
        title: "F3 (high): disputed remainder can't become payable on its original invoice",
        status: "failed",
        headline: "Still open",
        detail: "Same-invoice supplemental recognition is not built yet.",
        how: "Reproduced by the review's sod-remainder probe. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f3",
      },
      {
        id: "F4",
        title: "F4 (medium): field reviewer could cast the recognition vote",
        status: "passed",
        headline: "Fixed in #116",
        detail: "Field reviewers cannot recognize their own reviewed invoice. Checked by local tests only.",
        how: "The full local suite on ca62ed9 covers the rule.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#implemented-controls, submission/review-105/REVIEW.md#f4",
      },
      {
        id: "F5",
        title: "F5 (medium): payment can ignore an available credit, and an AP debit balance doesn't block close",
        status: "failed",
        headline: "Still open",
        detail: "Unused-credit acknowledgement and supplier-debit close treatment are not built yet.",
        how: "Reproduced by the review's credits probe. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f5",
      },
      {
        id: "F6",
        title: "F6 (medium): second invoice number for the same PO and delivery gets no warning",
        status: "failed",
        headline: "Still open",
        detail: "Duplicate receipt and PO soft holds are not built yet.",
        how: "Reproduced by the review's golden G3 probe. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f6",
      },
      {
        id: "F7",
        title: "F7 (medium): changed bank details on an invoice are ignored",
        status: "failed",
        headline: "Still open",
        detail: "Payment still goes to the configured beneficiary, but a changed remit-to on the invoice is not flagged.",
        how: "Found in the review's case F. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f7",
      },
      {
        id: "F8",
        title: "F8 (medium): no internal way to void a bill recognized in error",
        status: "failed",
        headline: "Still open",
        detail: "Governed recognition reversal is not built yet.",
        how: "Found by code reading in the review. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f8",
      },
      {
        id: "F9",
        title: "F9 (low): one approver can clear any disputed amount",
        status: "failed",
        headline: "Still open",
        detail: "Close dispositions still carry no amount and are not routed by amount.",
        how: "Found by code reading in the review. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f9",
      },
      {
        id: "F10",
        title: "F10 (low): a credit can be dated before the invoice and receipt",
        status: "failed",
        headline: "Still open",
        detail: "Credit chronology gates are not built yet.",
        how: "Reproduced by the review's creditdate probe. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f10",
      },
      {
        id: "F11",
        title: "F11 (low): weak spots in the PR's own evidence",
        status: "failed",
        headline: "Still open",
        detail: "Needs refreshed end-to-end evidence after the open workflows are complete.",
        how: "Found by reading the evidence in the review. Listed as outstanding after #116.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance, submission/review-105/REVIEW.md#f11",
      },
      {
        id: "practitioner",
        title: "Human practitioner sign-off",
        status: "not_run",
        headline: "Not done",
        detail: "No human accountant or AP practitioner has signed off. Live model traces for the AP case agent are also outstanding.",
        how: "Not measured.",
        source: "docs/ap-orchestration/USD-INTEGRATION-STATUS.md#validation-and-remaining-acceptance",
      },
    ],
  },
];

export type Connector = {
  id: string;
  name: string;
  role: string;
  mode: "local_fake" | "sandbox_verified" | "sandbox_partial" | "not_configured";
  verified: string[];
  notVerified: string[];
  source: string;
};

export const CONNECTORS: Connector[] = [
  {
    id: "fakebank",
    name: "FakeBank",
    role: "Local bank used by tests, demos and the I1, I2 and APEX replays. Stores transfers in SQLite.",
    mode: "local_fake",
    verified: [
      "Lost response after the bank accepts a payment recovers the original transfer with one create call",
      "Worker crash leaves 1 transfer, 1 debit and 1 journal entry",
      "I1, I2 and APEX case 1 settlements each matched one posted debit",
    ],
    notVerified: ["Real money or a real bank"],
    source: "docs/ap-orchestration/evidence/V2.md, docs/RESULTS.md#4-controls-and-payment-recovery",
  },
  {
    id: "increase",
    name: "Increase",
    role: "Bank API that sends supplier payments. Sandbox only.",
    mode: "sandbox_partial",
    verified: [
      "Authentication and account reads",
      "One $678.60 ACH transfer matched to its posted -$678.60 debit",
      "Test deposit classified as test capital, local cash equal to the Increase balance at $0",
    ],
    notVerified: [
      "Signed webhook delivery",
      "Returns, credits and successive partial payments",
      "A fresh end-to-end flow on the updated branch",
    ],
    source: "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits, docs/ap-orchestration/evidence/C4-funding-reconciliation.md",
  },
  {
    id: "quickbooks",
    name: "QuickBooks Online",
    role: "Accounting system that records the approved bill and the settled payment. Sandbox only.",
    mode: "sandbox_verified",
    verified: [
      "OAuth and company reads",
      "8 reference records created and read back, plus the existing AP account",
      "Bill 145 and BillPayment 146 for $678.60, Bill balance $0",
      "Missing AP account reference on BillPayment handled by the repaired connector",
    ],
    notVerified: [
      "VendorCredit or credit applications against the real sandbox",
      "Export of the test capital journal and QuickBooks bank reconciliation",
      "A fresh end-to-end flow on the updated branch",
    ],
    source: "submission/SANDBOX-ACCEPTANCE.md#checks-and-limits, docs/ap-orchestration/evidence/C4-live-mappings.md",
  },
  {
    id: "auth0",
    name: "Auth0",
    role: "Human login for the AP workspace.",
    mode: "sandbox_partial",
    verified: [
      "A real user logged in through the Google connection",
      "The observed identity was bound to the workspace",
      "That user clicked the final payment authorization",
    ],
    notVerified: [
      "Logout",
      "Expired, wrong-issuer or wrong-audience tokens",
      "A second user and isolation between users",
    ],
    source: "docs/ap-orchestration/evidence/C2-auth0-live.md, submission/SANDBOX-ACCEPTANCE.md#checks-and-limits",
  },
  {
    id: "llamaparse",
    name: "LlamaParse",
    role: "Document parser that reads invoice, PO, receipt and contract PDFs into source-backed fields.",
    mode: "sandbox_partial",
    verified: [
      "Four real completed agentic_plus jobs with 13 hash-verified artifacts, reused by I1",
      "I1: 35 fields with 33 source locations and 2 unresolved",
      "V7 cached replay: 104/104 fields correct, 102/104 with exact locations, 0 network calls",
    ],
    notVerified: [
      "New live parse requests in I1 or V7",
      "The provider-resolved parser version",
      "Real scanner quality and real supplier documents",
    ],
    source:
      "docs/ap-orchestration/evidence/I1-integrated.md, docs/ap-orchestration/evidence/V7-parser-repair.md, docs/ap-orchestration/LLAMAPARSE-SMOKE.md",
  },
  {
    id: "openai",
    name: "OpenAI",
    role: "Agent model, gpt-6.1-sol at medium effort. Used only when OPENAI_API_KEY is set. Spend is capped by AGENT_MAX_USD.",
    mode: "sandbox_partial",
    verified: [
      "Real model calls in the historical benchmarks, $10.59 total model spend",
      "Raw report confirms model gpt-6.1-sol, provider openai, effort medium",
    ],
    notVerified: [
      "Live model traces for the new AP case agent runner",
      "Any model run on this branch (#116 tests inject a model instead)",
    ],
    source:
      "README.md:98, docs/evals/runs/final/sheets-agent-model-s7-mvncnkcd/report.json, docs/ap-orchestration/USD-INTEGRATION-STATUS.md#model-runner",
  },
  {
    id: "convex",
    name: "Convex",
    role: "Ledger and case state. Double entry, idempotent writes, hash chain and approval gates. Runs as a local deployment.",
    mode: "sandbox_verified",
    verified: [
      "22 of 22 kernel control tests hold",
      "Ledger hash chain verifies",
      "AP subledger equals the 2000 control account in the independent review",
      "1,994 tests pass on this branch",
    ],
    notVerified: ["A hosted production deployment"],
    source: "docs/evals/control-tests.json, submission/review-105/REVIEW.md#bottom-line, evidence/usd-integration-20261025/validation.json, docs/ap-orchestration/CURRENT-STATUS.md",
  },
  {
    id: "git-memory",
    name: "Git memory",
    role: "Decision records committed to git, read back by the controller and by Ask why.",
    mode: "sandbox_verified",
    verified: [
      "Kernel control tests run against git memory",
      "Merging your own change and merging without authority are refused",
      "Editing bank details directly in memory is refused",
    ],
    notVerified: ["Nothing beyond the kernel control tests is recorded"],
    source: "docs/RESULTS.md#4-controls-and-payment-recovery, docs/evals/control-tests.json",
  },
];
