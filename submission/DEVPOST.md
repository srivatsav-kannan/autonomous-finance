# Devpost drafts: Autonomous Finance

Due **Sun Oct 25, 9:00 AM PT (hard deadline)**. Every number below comes from `autonomous-finance/docs/RESULTS.md`. Edit here first. Devpost gets updated from this file. The story now describes the new AP workspace. Historical simulator scores are labeled separately from current acceptance. The video must use the same evidence boundaries.

## Status on Devpost (draft saved, NOT submitted)

**Repo copy updated Oct 25; live Devpost has not been updated or verified in this pass.** The live edit link and video URL were not provided. Copy the story below into the draft; do not treat this file as a submitted entry.

Entered and saved: name, elevator pitch, full story, 15 built-with tags, GitHub link, prize tracks (Hyphenate, Convex, Atlassian), AI tools (OpenAI, Anthropic), the GenAI answer and the tech feedback answer. Team: Srivatsav, Arav Chand, Junjie Xiong.

Still to do:
- [ ] **Video demo link** (required, YouTube or Vimeo). Shot list in `docs/DEMO.md`.
- [ ] **Image:** a console screenshot (3:2), for the thumbnail and the gallery.
- [ ] **Emails** each of us used to apply and confirm on Hive (required).
- [ ] **Schools** we attend (required).
- [ ] **Repo visibility:** it's private, and judges need to see the code.
- [ ] **Submit:** tick the terms box and click Submit project before 9:00 AM. You can still edit afterwards until the deadline.

## Additional info answers (as entered)

**Did you implement a generative AI model or API?**
Yes. Our agents call OpenAI gpt-6.1-sol through one budgeted client with a hard spend cap (Claude is a supported fallback through the same cap). We use the model only where code can't decide:
- reading invoice formats nobody has seen, then writing a parser spec for them (JSON regexes and field mappings, never executed code), which the controller agent tests before merging
- judgment calls on held bills and exceptions
- spotting fraud and prompt injection in bank-change emails
- answering "why did you do X?" with citations from the decision log

In the historical simulator, about 92% of tasks never called the model and a full run cost about 5 cents. Those figures do not measure the new AP document/review workflow. Model output never moves money: the Convex kernel checks arithmetic, evidence and authority on every write. For the APEX-Accounting benchmark, answers are graded by gpt-6-astra. We also used Claude Code and Codex as coding tools while building.

**Tech feedback:**
Convex: the local backend runs without an account, which let anyone who clones our repo set it up with one command. Transactions fit double-entry bookkeeping well, and supported finance checks run inside them. Independent review still found approval and lifecycle gaps. Rough edges: a schema check blocked a deploy when old local test data no longer matched, so we had to reset the local database. The regenerated _generated files also add noise to git.

OpenAI Responses API: strict structured outputs rejected regex and length constraints in our schema, so we split it into a structural schema for the model plus a separate validator. Working well once split.

## Prize tracks to enter

| Track | Why we fit | Note |
|---|---|---|
| **[Hyphenate] The Hyphenated Enterprise** (main) | AP seats run by agents under a human CFO, with the track's own AP example end to end | $8k / $5k / $3k, plus interviews for the top 5 |
| **[Convex] Best use of Convex** ($5,000 cash) | The whole kernel is Convex: double-entry mutations, task queue with leases, OIDC auth for the human, live queries in the console | It changed from hardware to $5k cash. Worth entering |
| **[Atlassian] Best Security Solution for Agents** | Agent permissions are enforced in the database, not the prompt. The prompt-injected fraud email is refused. The CFO's token is kept away from the agents | Must name the track in the description (done at the bottom) |

I'd skip the rest. Microsoft "Built for the Real World" is a maybe if the form makes extra tracks free.

---

## Project name

**Autonomous Finance**

## Elevator pitch (200 characters max)

> One AP case connects supplier documents, reviewed facts, bill approval, payment and accounting. Agents prepare the work; people make the required decisions.

Alternate:
> We fill the AP clerk, payments and controller seats at a 281-restaurant chain. The same agent-native kernel also runs cash, revenue, payroll, leases and close.

## About the project

### Inspiration

Most autonomous finance agents are a model using a spreadsheet or a browser. Those tools were built for people, and an agent needs something different. They're slow for an agent: in our test, one bookkeeping step took about six spreadsheet tool calls instead of one. And they don't check anything. A spreadsheet doesn't stop you approving your own payment.

In accounts payable, that leads to real losses: the same invoice paid twice, a fake "new bank details" email that gets paid, or a payment that left the bank while the system thinks it didn't.

We think agents shouldn't use tools built for humans. If agents are going to run finance at agent speed, they need a ledger built for them, one that enforces the controls itself.

### What it does

Autonomous Finance connects supplier evidence, business decisions, payment and accounting in one AP case. Our broader restaurant-chain simulator is calibrated to Sweetgreen's FY2025 10-K ($679.5M revenue, 281 restaurants); its measured slice covers 3 stores over 14 days. The AP demonstration uses separate authored synthetic supplier documents.

**The new AP case workspace (`/ap-system`):**
- Original invoices, purchase orders and receipts stay attached to the case. Extracted fields link to source evidence; uncertain locations remain visible.
- Field review, bill approval and payment authorization are distinct actions. Recognition records what we owe; payment authorization approves an exact amount and destination. These stages do not yet enforce fully independent human approvers.
- An explicit partial acceptance preserves the original claim, accepted obligation and disputed remainder. A short shipment or price overcharge waits for authority; the agent does not automatically short-pay it.
- The internal ledger links the recognition and settlement journals. QuickBooks sync creates the approved Bill and records the settled payment; Increase executes the payment. Settlement reduces AP and cash without expensing the purchase again.

**The broader simulator and payment engine:**
- Invoices arrive in different formats. Known formats are parsed by code. For a format nobody has seen, the model reads it once and an agent writes a parser for it (regexes and field mappings as JSON). The controller agent tests the parser before it's used. After that, invoices in that format are parsed by code with no model call.
- Each bill is checked against the contract price, the receiving log, open credits and earlier invoices. Short shipments, price overcharges and duplicates are held with the exact reason.
- A "new bank details" email from a look-alike domain, with "ignore previous instructions" in it, is refused. Even if an agent were fooled, it couldn't change the bank details. The database only accepts that change when a human approves it, and that human can't be the one who proposed it.
- The simulator routes payments of $50k or more to the human CFO. That legacy threshold is not a payment amount band in the new AP workspace; the independent review found that gap. Agent requester/approver separation also does not guarantee separation between the human bill approver and payment releaser.
- If the bank accepts a payment and the worker dies before recording it, a new worker resends the saved request with the same key, gets the original transfer back and books it once.
- Ask a question like "why did you hold INV-1002?" and the answer cites the git commits where those decisions were recorded.

The separate company simulator also exercises the rest of the finance department: cash application, revenue, payroll, leases and month-end close. If AP moves at agent speed but cash and close still wait on humans in spreadsheets, AP just ends up waiting on them. So the whole department runs on the same ledger.

### How we built it

- **Ledger and controls (Convex):** every change to the books is one database transaction, in integer cents, with double entry, an idempotency key and a hash chain. Twelve agents (AP clerk, controller, payments and so on) each have their own login and limits. The limits are checked in the database, not written in prompts. For example:
  - a cash entry needs a matching bank transaction
  - a bill needs a received invoice
  - whoever requests a payment can't approve it
  - closing a month needs a human signature

  The task queue and the CFO's login also live in Convex, and the console updates live from it.
- **Memory (git):** company knowledge (vendors, bank details, policies, parsers and every decision) is YAML in a git repo, checked against a schema. Each change is a commit by the agent that made it. Changes to bank details or parsers go on a branch that a different agent has to merge, so any number can be traced back with `git blame`.
- **Agents (TypeScript + OpenAI `gpt-6.1-sol`):** routine work is plain code. The model reads unfamiliar documents, makes judgment calls and answers "why" questions, using typed tools checked with zod. In the historical simulator run, 92% of tasks never called the model. Every model call goes through one client with a hard spend cap.
- **Payments:** before a payment is sent, the exact request and its idempotency key are saved. One worker at a time can hold it, for 30 seconds. If that worker dies, another one takes over and asks the bank about the original payment instead of sending a new one. We test against a local bank simulator that can drop responses, and we built an adapter for the Increase sandbox.
- **Simulator and evals:** a simulator generates 14 days of invoices, bank activity, sales and payroll, with 13 planted errors and 3 legitimate look-alikes. We score each run against an answer key the agents never see, and check the books against a separate ledger on every account. We also adapted 15 public tasks (APEX-Accounting, DABstep, Invoice Sandbox, FinBalance) so our agents could run them.
- **Console (React + Vite):** `/ap-system` connects source review, business decisions, payment and accounting evidence. The broader simulator has Inbox, Finance flow, Live activity, Ledger, Memory, Evals and a Control room.

### How the sandbox fits

A real company already has accounting software and a bank. Our internal ledger keeps the workflow's accounting; the QuickBooks connector records approved bills and settled payments in the company's books, while Increase handles the bank instruction. Their sandboxes use real APIs with test books and simulated money. Automated tests use FakeBank and mock QuickBooks; a sandbox run checks the actual services separately.

One synthetic $678.60 invoice completed on our dedicated Auth0 runtime: QuickBooks Bill 145, linked BillPayment 146, one Increase transfer and matching debit, and local bank reconciliation. We checked the provider records again on Oct 25. The check exposed a QuickBooks response difference on merged main, now repaired and verified on the documentation/repair branch. This is one bounded case, not full sandbox acceptance: a fresh flow on the updated branch, signed webhooks, external returns/credits and formal period close remain unverified.

### Challenges we ran into

- **Model-written parsers.** The first version ran the model's JavaScript in `node:vm`, which isn't a security boundary, inside a process that holds credentials. We replaced it with JSON parser specs that fixed code applies, with checks on every regex. Nothing the model writes is executed.
- **Paying exactly once when the bank doesn't answer.** A timeout doesn't mean the payment failed. We save the request and its key before sending, let only one worker hold the payment at a time, and on recovery ask the bank about the original instead of sending a new one. CI kills the worker in the middle of a payment on every pull request.
- **Keeping the CFO's login away from the agents.** The CFO's token sat in the same file the agents loaded, so we split it out. What each approval button does is now stored in the database, so the agent asking the question can't change it.
- **Measuring honestly.** Our first benchmark harness gave the first agent half the turn budget, so it ran out of turns before writing an answer. Fixing that changed our team score from 86.7% to 93.3%.

### Accomplishments that we're proud of

Historical measurements and the reported current acceptance are linked in docs/RESULTS.md:
- **Current reported simulator run after #105, seed 7:** 13/13 planted errors caught and 0 false alarms. The books check remains incomplete because INV-1002 and INV-1004 wait for a human decision. No unattended answer or automatic short-pay closes those holds.
- **Historical simulated company, 4 seeds, before #105:**
  - 13 of 13 planted errors caught on every seed
  - 3 of 3 look-alikes left alone, 0 false alarms
  - 64 of 64 invoices read
  - books matched every account in those historical runs; this is not the current result
  - $0.04–0.05 and 71–82 seconds per 14-day run
- **Same model, our ledger's tools vs spreadsheet tools, 11 tasks:** 12 vs 71 tool calls, 45 vs 94 seconds, $0.12 vs $0.48. With our tools it caught 4 of 4 planted errors. With the spreadsheet it caught 3 of 4.
- **156 bookkeeping operations with 18 bad ones mixed in, no model:** our ledger stopped all 18. The spreadsheet flagged 8 after the fact and never caught 10, including self-approval and posting to a closed month.
- **15 public benchmark tasks:** our agents scored 93.3% (14 of 15) and the same model alone scored 84.0% (12 of 15). The controller's review fixed both answers the model got wrong alone, at about 1.7× the cost. Small sample, one run each.
- **Kernel controls:** 22/22 checks passed in the reported merged-main acceptance. A separate Claude independent model review found arithmetic held in its probes, but three high-severity gaps remain: payment release can share the bill/bank approver and has no amount bands; first-wave mode permits a single operator and unlinked credits; a disputed remainder cannot become payable on its original invoice. Medium findings remain too. We do not claim production readiness or accountant sign-off.

### What we learned

- Put the controls in the database. An agent can be talked out of a rule written in its prompt. It can't get past a database write that rejects the action.
- Most tasks in our historical simulator did not need a model. Its roughly 5-cent run cost does not estimate document parsing, human review or the new provider workflow.
- A second agent reviewing the first catches real mistakes. On the public benchmark tasks, the controller's review fixed both answers the model got wrong on its own.

### What's next

- Fix independent payment authorization and amount bands, retire the single-operator/unlinked-credit bypass, and support governed supplemental acceptance on the original invoice (F1–F3).
- Extend source matching and field grounding beyond the supported synthetic documents and declared formats.
- Rerun the complete sandbox workflow on the updated branch, then verify signed webhooks, external returns, credits and corrections separately.
- Expand the shared work queue and turn reviewed corrections into scoped, testable precedents.

**Atlassian track:** Best Security Solution for Agents.

## Built with

`typescript` `convex` `react` `vite` `node.js` `openai` `zod` `git` `yaml` `python` `vitest` `playwright` `exceljs` `increase` `github-actions`

## Try it out links

- GitHub: https://github.com/srivatsav-kannan/autonomous-finance (private, see checklist)
- Video: (to add)

## Team

Srivatsav Kannan · Junjie (JJ) Xiong · Arav
