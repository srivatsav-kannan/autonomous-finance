# Devpost drafts: Autonomous Finance

Due **Sun Oct 25, 9:00 AM PT (hard deadline)**. Every number below comes from `autonomous-finance/docs/RESULTS.md`. Edit here first. Devpost gets updated from this file. If JJ's #97 work changes what the demo shows, update "What it does" and the video. The rest should hold.

## Status on Devpost (draft saved, NOT submitted)

The text below was rewritten on Oct 25 at 8:25 AM in full sentences, and it includes the one-console paragraph, the $77 sandbox run and the review fixes from #116. Devpost still has the earlier version until someone pastes this in.

Still to do:
- [ ] **Video demo link** (required, YouTube or Vimeo).
- [ ] **Image:** a console screenshot (3:2), for the thumbnail and the gallery.
- [ ] **Emails** each of us used to apply and confirm on Hive (required).
- [ ] **Schools** we attend (required).
- [ ] **Repo visibility:** it's private, and judges need to see the code.
- [ ] **Submit:** tick the terms box and click Submit project before 9:00 AM.

## Additional info answers (as entered)

**Did you implement a generative AI model or API?**
Yes. Our agents call OpenAI's gpt-6.1-sol through one budgeted client that has a hard spend cap, and Claude is supported as a fallback through the same cap. We only use the model where code can't make the decision. It reads invoice formats that nobody has seen before and writes a parser spec for each one, which is a set of JSON regexes and field mappings rather than code that gets executed, and the controller agent tests that spec before it is merged. The model also makes judgment calls on held bills and exceptions, spots fraud and prompt injection in emails that ask to change bank details, and answers questions like "why did you do this?" with citations from the decision log.

About 92% of the tasks in a 14-day run are plain code that never calls the model, and a full run costs about 5 cents. Model output never moves money, because the Convex kernel checks the arithmetic, the evidence and the authority on every write. For the APEX-Accounting benchmark, the answers are graded by gpt-6-astra. We also used Claude Code and Codex as coding tools while we built the project.

**Tech feedback:**
Convex: The local backend runs without an account, which meant that anyone who clones our repo can set it up with one command. Transactions fit double-entry bookkeeping well, and we check every finance control inside them. The rough edge was that a schema check blocked a deploy when old local test data no longer matched the schema, so we had to reset the local database. The regenerated _generated files also add noise to git.

OpenAI Responses API: Strict structured outputs rejected the regex and length constraints in our schema, so we split it into a structural schema for the model and a separate validator. It worked well once we made that split.

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

> AI agents run accounts payable for a simulated Sweetgreen on a ledger that was built for agents, so the work moves at an agent's pace and the CFO only makes the management decisions.

## About the project

### Inspiration

Most autonomous finance agents today are a model that drives a spreadsheet or a browser. Those tools were built for people, and they don't fit what an agent needs. They are slow for an agent, because in our test a single bookkeeping step took about six spreadsheet tool calls instead of one. They also don't check anything, which means that a spreadsheet will let you approve your own payment.

In accounts payable, that gap leads to real losses. The same invoice gets paid twice, a fake email asking to update a supplier's bank details gets paid, or a payment leaves the bank while the system still thinks that it didn't.

We think that agents shouldn't be using tools that were built for humans. If agents are going to run finance at the pace that agents work, they need a ledger that was built for them and that enforces the controls itself.

### What it does

Autonomous Finance runs accounts payable for a restaurant chain that we modeled on Sweetgreen. The agents do the work, and people only make the decisions that need a person, such as approving a bill, releasing a payment or settling a dispute. Everything runs in one console that holds the CFO's inbox, the invoices, payments, bank and cash, the ledger, the agents and their memory, the connections to outside services, and every result that we measured along with the file that it came from.

**One invoice, from PDF to reconciled payment**
- An invoice arrives as a PDF together with its purchase order and delivery receipt. Each field that we extract is linked to the place where it appears in the original, so that a reviewer can check it against the source.
- Approving the fields, approving the bill and releasing the payment are three separate decisions. Approving a bill records what the company owes, but it doesn't pay anything.
- If an invoice bills for more than was ordered or delivered, the case is held until a person decides what to do, and the agent never quietly pays a smaller amount. If only part of an invoice is accepted, the rest stays visible as disputed.
- Payments go out through Increase, which is a bank API. If the bank accepts a payment and our worker crashes before it records the result, the next worker asks the bank about the original payment instead of sending a second one, so the company ends up with one transfer and one entry in the books.
- The approved bill and the settled payment are written into QuickBooks, so that the company's accountants can see them in the tool that they already use. Paying a bill reduces what the company owes and its cash, and it doesn't record the expense a second time.
- We ran two synthetic invoices through the real QuickBooks and Increase sandboxes, which are the test versions of those services. The first, for $678.60, produced QuickBooks Bill 145, BillPayment 146 and one Increase transfer that matched its bank debit. The second, for $77, went through the whole flow with the case worker. It waited for a missing receipt, picked up again when the receipt arrived, and settled through Increase with QuickBooks Bill 147 and BillPayment 148.

**The agents and the rest of the department**
- Our simulated Sweetgreen is calibrated to its FY2025 10-K, which reports $679.5M of revenue across 281 restaurants. Invoices arrive in different formats, and when a format shows up that nobody has seen before, the model reads it once and an agent writes a parser for it. The controller agent tests that parser before anyone uses it, and from then on the format is read by code without calling the model.
- Each bill is checked against the contract price, the receiving log, any open credits and earlier invoices, so that short shipments, overcharges and duplicates are held with the exact reason.
- When an email from a look-alike domain asks us to change a supplier's bank details and includes "ignore previous instructions", the agent refuses it. Even if an agent were fooled, it couldn't change the bank details, because the database only accepts that change when a human approves it, and that human can't be the person who proposed it.
- When someone asks a question like "why did you hold INV-1002?", the answer cites the git commits where those decisions were recorded.
- The same system also runs cash application, revenue, payroll, leases and the month-end close. That matters because if accounts payable moves at an agent's pace while cash and close still wait on people in spreadsheets, accounts payable just ends up waiting on them.

### How we built it

- **Ledger and controls (Convex):** Every change to the books is a single database transaction in integer cents, with double entry, an idempotency key and a hash chain. Each agent has its own login and limits, and the database checks them on every write. For example, a cash entry needs a matching bank transaction, and the person who requests a payment can't be the one who approves it.
- **The AP case:** One case links the original documents, the reviewed fields, the bill, its journal entries, the payment and the bank evidence. LlamaParse reads the PDFs, and our code links each field to its place in the source and checks the arithmetic.
- **Payments:** We save the exact request and its key before anything is sent, and only one worker at a time can hold a payment. We test against our own bank simulator, which can drop responses on purpose, and we run the real thing through the Increase sandbox.
- **QuickBooks:** A connector writes the approved bill and the settled payment and then reads them back to check that they match our books. If the outcome of a write is unknown, it looks the record up instead of posting it again.
- **People:** The human approver signs in with Auth0, and the agents never hold the human's login.
- **Memory (git):** Vendors, bank details, policies, parsers and every decision are stored as YAML in a git repository. Each change is a commit by the agent that made it, so that any number can be traced back with `git blame`.
- **Agents (TypeScript and OpenAI `gpt-6.1-sol`):** Routine work is plain code. The model reads unfamiliar documents, makes judgment calls and answers "why" questions through typed tools, and every model call goes through one client that has a hard spend cap.
- **Simulator and evals:** A simulator generates 14 days of invoices, bank activity, sales and payroll with 13 planted errors and 3 legitimate look-alikes, and it scores the agents against an answer key that they never see. We also adapted 15 public finance tasks from APEX-Accounting, DABstep, Invoice Sandbox and FinBalance so that our agents could run them.

### Challenges we ran into

- **Paying exactly once when the bank doesn't answer.** A timeout doesn't mean that the payment failed. We save the request before sending it and allow only one worker to hold it, and when a worker recovers it asks the bank about the original payment instead of sending a new one.
- **Real services behave differently from fakes.** The real QuickBooks sandbox leaves out a field in payment responses that our connector required, so our first real readback failed. The connector now checks the linked bill instead.
- **Model-written parsers.** Our first version ran JavaScript that the model wrote inside a process that holds credentials. We replaced it with JSON parser specs that fixed code applies, so nothing that the model writes is ever executed.
- **Measuring honestly.** Our first benchmark harness gave one agent half the turn budget, so it ran out of turns before it could write an answer. Fixing that changed our team score from 86.7% to 93.3%.

### Accomplishments that we're proud of

Everything here was measured, and the raw outputs are in the repo.
- **The sandbox runs:** Two synthetic invoices, for $678.60 and $77, went from PDF to approval, an Increase payment, a QuickBooks bill and payment, and a matched bank debit.
- **Simulated Sweetgreen over 14 days and 3 stores:** The agents caught 13 of 13 planted errors, left all 3 look-alikes alone and raised no false alarms. Under the new AP rules, two of those invoices now wait for a person's decision instead of being short-paid automatically. In our earlier runs across 4 seeds, the books matched on every account.
- **The same model with our ledger's tools compared with spreadsheet tools, over 11 tasks:** It needed 12 tool calls instead of 71, took 45 seconds instead of 94, and cost $0.12 instead of $0.48.
- **15 public benchmark tasks:** Our agents scored 93.3%, while the same model on its own scored 84.0%.
- **Controls:** All 22 control tests pass. A separate review by another Claude model checked the accounting and found that every journal balances and that paying a bill never records the expense twice. Since that review, two of its three most serious findings have been fixed in code, so releasing a payment now needs a different person from the one who approved the bill, and payments have amount limits.

### What we learned

- Controls belong in the database. An agent can be talked out of a rule that is written in its prompt, but it can't get past a database write that rejects the action.
- Approving a bill and releasing money are different decisions, and the software should treat them that way.
- Fakes only get you so far, and the real QuickBooks sandbox found a bug that our tests had missed.
- Most finance work doesn't need a model at all, so we only call it for new formats and judgment calls.

### What's next

- We want to close the review findings that are still open. The disputed part of an invoice can't yet be approved later on the same invoice, a payment can ignore a supplier credit that is available, a second invoice number for the same order isn't flagged as a possible duplicate, changed bank details printed on an invoice aren't flagged, and there is no way to void a bill that was recorded by mistake.
- We want to run more invoices through the sandboxes, including returns and credits, and verify the webhooks that Increase sends.
- We want to read more document formats and turn the corrections that reviewers make into rules that the agents reuse.

**Atlassian track:** Best Security Solution for Agents.

## Built with

`typescript` `convex` `react` `vite` `node.js` `openai` `zod` `git` `yaml` `python` `vitest` `playwright` `exceljs` `increase` `github-actions` `quickbooks` `auth0` `llamaparse`

## Try it out links

- GitHub: https://github.com/srivatsav-kannan/autonomous-finance (private, see checklist)
- Video: (to add)


## Team

Srivatsav Kannan · Junjie (JJ) Xiong · Arav
