# Devpost drafts: Autonomous Finance

Due **Sun Oct 25, 9:00 AM PT (hard deadline)**. Every number below comes from `autonomous-finance/docs/RESULTS.md`. Edit here first. Devpost gets updated from this file. If JJ's #97 work changes what the demo shows, update "What it does" and the video. The rest should hold.

## Status on Devpost (draft saved, NOT submitted)

**The story below is newer than what's on Devpost** (new Inspiration plus a plain-language pass). Push it once it's approved.

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

About 92% of tasks in a 14-day run are plain code and never call the model. A full run costs about 5 cents. Model output never moves money: the Convex kernel checks arithmetic, evidence and authority on every write. For the APEX-Accounting benchmark, answers are graded by gpt-6-astra. We also used Claude Code and Codex as coding tools while building.

**Tech feedback:**
Convex: the local backend runs without an account, which let anyone who clones our repo set it up with one command. Transactions fit double-entry bookkeeping well, and we check every finance control inside them. Rough edges: a schema check blocked a deploy when old local test data no longer matched, so we had to reset the local database. The regenerated _generated files also add noise to git.

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

> AI agents run accounts payable for a simulated Sweetgreen at agent speed, on a ledger built for agents. The human CFO only makes the management decisions.

Alternate:
> We fill the AP clerk, payments and controller seats at a 281-restaurant chain. The same agent-native kernel also runs cash, revenue, payroll, leases and close.

## About the project

### Inspiration

Most autonomous finance agents are a model using a spreadsheet or a browser. Those tools were built for people, and an agent needs something different. They're slow for an agent: in our test, one bookkeeping step took about six spreadsheet tool calls instead of one. And they don't check anything. A spreadsheet doesn't stop you approving your own payment.

In accounts payable, that leads to real losses: the same invoice paid twice, a fake "new bank details" email that gets paid, or a payment that left the bank while the system thinks it didn't.

We think agents shouldn't use tools built for humans. If agents are going to run finance at agent speed, they need a ledger built for them, one that enforces the controls itself.

### What it does

Autonomous Finance runs accounts payable for a restaurant chain modeled on Sweetgreen. Agents do the work. People make the decisions that need a person: approving a bill, releasing a payment, settling a dispute.

It all runs in one console: the CFO's inbox, invoices, payments, bank and cash, the ledger, the agents and their memory, the connectors, and every result we measured with the file it came from.

**One invoice, from PDF to reconciled payment:**
- An invoice arrives as a PDF, along with its purchase order and delivery receipt. Each field we extract links back to where it appears in the original, so a reviewer can check it against the source.
- Approving the fields, approving the bill and releasing the payment are three separate decisions. Approving a bill records what we owe. It doesn't pay anything.
- If an invoice bills for more than was ordered or delivered, the case is held and a person decides. The agent doesn't quietly pay less. If only part of an invoice is accepted, the rest stays visible as disputed.
- Payments go out through Increase, a bank API. If the bank accepts a payment and our worker crashes before recording it, a new worker asks the bank about the original payment instead of sending a second one. The result is one transfer and one entry in the books.
- The approved bill and the settled payment are written into QuickBooks, so the company's accountants see them in the tool they already use. Paying a bill reduces what we owe and our cash. It doesn't record the expense a second time.
- We ran one synthetic $678.60 invoice through the real QuickBooks and Increase sandboxes (their test versions): QuickBooks Bill 145, BillPayment 146 linked to it, and one Increase transfer matched to its bank debit.
- A second synthetic invoice, for $77, went through the whole flow in the sandboxes with the case worker. It waited for a missing receipt, picked up again when the receipt arrived, and settled through Increase, with QuickBooks Bill 147 and BillPayment 148 and the bank debit matched.

**The agents, and the rest of the department:**
- In our simulated Sweetgreen (calibrated to its FY2025 10-K: $679.5M revenue, 281 restaurants), invoices arrive in different formats. For a format nobody has seen, the model reads it once and an agent writes a parser for it. The controller agent tests the parser before it's used, and after that the format is read by code with no model call.
- Each bill is checked against the contract price, the receiving log, open credits and earlier invoices. Short shipments, overcharges and duplicates are held with the exact reason.
- A "new bank details" email from a look-alike domain, with "ignore previous instructions" in it, is refused. Even if an agent were fooled, it couldn't change the bank details. The database only accepts that change when a human approves it, and that human can't be the one who proposed it.
- Ask a question like "why did you hold INV-1002?" and the answer cites the git commits where those decisions were recorded.
- The same system runs cash application, revenue, payroll, leases and the month-end close. If AP moves at agent speed but cash and close still wait on people in spreadsheets, AP just ends up waiting on them.

### How we built it

- **Ledger and controls (Convex):** every change to the books is one database transaction, in integer cents, with double entry, an idempotency key and a hash chain. Each agent has its own login and limits, and the database checks them on every write. For example, a cash entry needs a matching bank transaction, and whoever requests a payment can't approve it.
- **The AP case:** one case links the original documents, the reviewed fields, the bill, its journal entries, the payment and the bank evidence. LlamaParse reads the PDFs, and our code links each field to its place in the source and checks the arithmetic.
- **Payments:** the exact request and its key are saved before anything is sent. One worker at a time can hold a payment. We test against our own bank simulator, which can drop responses, and run the real thing through the Increase sandbox.
- **QuickBooks:** a connector that writes the approved bill and the settled payment, then reads them back to check they match our books. If a write's outcome is unknown, it looks the record up instead of posting it again.
- **People:** the human approver signs in with Auth0. Agents never hold the human's login.
- **Memory (git):** vendors, bank details, policies, parsers and every decision are YAML in a git repo. Each change is a commit by the agent that made it, so any number can be traced back with `git blame`.
- **Agents (TypeScript + OpenAI `gpt-6.1-sol`):** routine work is plain code. The model reads unfamiliar documents, makes judgment calls and answers "why" questions through typed tools. Every model call goes through one client with a hard spend cap.
- **Simulator and evals:** a simulator generates 14 days of invoices, bank activity, sales and payroll with 13 planted errors and 3 legitimate look-alikes, scored against an answer key the agents never see. We also adapted 15 public finance tasks (APEX-Accounting, DABstep, Invoice Sandbox, FinBalance) so our agents could run them.

### Challenges we ran into

- **Paying exactly once when the bank doesn't answer.** A timeout doesn't mean the payment failed. We save the request before sending, let only one worker hold it, and on recovery ask the bank about the original instead of sending a new one.
- **Real services behave differently from fakes.** QuickBooks' real sandbox leaves a field out of payment responses that our connector required, so the first real readback failed. The connector now checks the linked bill instead.
- **Model-written parsers.** The first version ran the model's JavaScript inside a process that holds credentials. We replaced it with JSON parser specs that fixed code applies. Nothing the model writes is executed.
- **Measuring honestly.** Our first benchmark harness gave one agent half the turn budget, so it ran out of turns before writing an answer. Fixing that changed our team score from 86.7% to 93.3%.

### Accomplishments that we're proud of

All measured, with raw outputs in the repo:
- **The sandbox run:** one synthetic invoice went from PDF to approval, an Increase payment, a QuickBooks bill and payment, and a reconciled bank debit.
- **Simulated Sweetgreen, 14 days, 3 stores:** 13 of 13 planted errors caught, 3 of 3 look-alikes left alone, 0 false alarms. Since the new AP rules, two of those invoices wait for a person's decision instead of being short-paid automatically. In our earlier runs across 4 seeds, the books matched on every account.
- **Same model, our ledger's tools vs spreadsheet tools, 11 tasks:** 12 vs 71 tool calls, 45 vs 94 seconds, $0.12 vs $0.48.
- **15 public benchmark tasks:** our agents scored 93.3% and the same model alone scored 84.0%.
- **Controls:** 22 of 22 control tests pass. A separate review by another Claude model checked the accounting: every journal balances, and paying a bill never records the expense twice.

### What we learned

- Put the controls in the database. An agent can be talked out of a rule written in its prompt. It can't get past a database write that rejects the action.
- Approving a bill and releasing money are different decisions, and the software should treat them that way.
- Fakes only get you so far. The real QuickBooks sandbox found a bug our tests didn't.
- Most finance work doesn't need a model. We call it for new formats and judgment calls.

### What's next

- Fix the three gaps the review found: the person who approved a bill can also release its payment, and payments have no amount limits. In the simpler setup, one person can still do every step. And the disputed part of an invoice can't later be approved on the same invoice.
- Run more invoices through the sandboxes, including returns and credits, and verify Increase's webhooks.
- Read more document formats, and turn reviewed corrections into rules the agents reuse.

**Atlassian track:** Best Security Solution for Agents.

## Built with

`typescript` `convex` `react` `vite` `node.js` `openai` `zod` `git` `yaml` `python` `vitest` `playwright` `exceljs` `increase` `github-actions` `quickbooks` `auth0` `llamaparse`

## Try it out links

- GitHub: https://github.com/srivatsav-kannan/autonomous-finance (private, see checklist)
- Video: (to add)

## Team

Srivatsav Kannan · Junjie (JJ) Xiong · Arav
