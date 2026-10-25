# Judging flow: who stands at which page, what to click, what to say

This flow is for the judging laptop, which runs a local copy of this console with a shorter sidebar (nine pages) and the approver seat picked automatically. The pages and results it describes are the same ones that are in this repo.

Five minutes per judge. Spend about three minutes showing and two answering questions. Laptop 2 has the video ready on a loop or paused on the first frame. Laptop 1 (Srivatsav's) has the console open in Chrome at **http://127.0.0.1:5173/?view=inbox#scenario-1**. The person who is talking also drives the laptop.

## Before the first judge

1. Check that the "judging demo" terminal tab says "Ready". If it doesn't, run `~/Documents/calhacks/demo-judging.sh`, which restarts everything and checks every page in about two minutes.
2. Open the console in Chrome at the address above, in a full-size window. The sidebar should list Inbox, Invoices, Ledger, Finance flow, Team, Live activity, Memory, Results and Control room.
3. Open JJ's architecture diagram in Preview: `~/Documents/calhacks/af-one/docs/images/agent-environment.png`.
4. Between judges, click Inbox and scroll back to the top. Don't click Approve, Release, Acknowledge or any of the Control room inject buttons, because those change what the next judge sees. No agents are running live, so an injected event wouldn't show a reaction anyway.

If something stops working, play the video on laptop 2 and say "this page isn't loading, so here's the recording."

If the cleaned-up console misbehaves, the version from before the cleanup is saved, and this command switches back to it (the page reloads by itself):

```
git -C ~/Documents/calhacks/af-one checkout judging-backup
```

---

## Part 1 · Srivatsav · the department (about 1 minute)

**Page: Inbox.** Start at the top of the page.

> Most finance agents work by driving a spreadsheet or a browser that was built for people. That makes them slow, and it means that nothing checks their work, because a spreadsheet will let you approve your own payment. We built Autonomous Finance so that agents can run accounts payable on a ledger that was built for them, while the human CFO only makes the management decisions. This is the console for the finance department of a simulated Sweetgreen, and this inbox only shows the decisions that need a person.

**Click** "Blocked a suspected fraud attempt against Golden State Produce Co."

> In this case an email from a look-alike domain asked us to send a supplier's payments to a new bank account, and the agent refused. The reasons are listed here: the domain doesn't match the one on file, the email contains instructions aimed at an AI, and the callback to the number on file didn't confirm it. Even if an agent were fooled, the database would reject the change, because only a person can approve new bank details, and it can't be the person who asked for them.

**Close the panel, then click Control room.** The question box already has text in it, so select it and type: *Why did you hold golden-state-produce invoice 1002?* Then click Ask. The answer takes about ten seconds.

> You can ask the team why it did something, and the answer cites the git commit where that decision was recorded. Here it says that six cases of kale were billed but only four arrived, so the invoice was held for the two-case shortage.

**Hand off:** "Arav will show you what happens to a single invoice."

---

## Part 2 · Arav · one invoice from PDF to payment (about 1 minute)

**Page: Invoices.** The page opens signed in as the finance approver, shown in the "Acting as" line at the top. Click the first case, **AVILA-202412-A6**.

> Every invoice becomes a case that keeps the original PDF together with the agreement and the proof that the work was done. This one is a $3,000 invoice from a contract attorney, and every step on it is already finished.

**Scroll** to Source fields, click **Field citation**, and then click **Total amount**. The total is highlighted on the invoice.

> When the PDF is read, each field is linked to the place where it appears in the original, so that a reviewer can check every value against the source. If a field can't be located, it stays marked as unresolved instead of being guessed.

**Click** Original PDF if a judge wants to see the whole file. It can be zoomed and paged through.

**Click** the **Matching** tab.

> The case is checked against the agreement and the record that the work was done, and if any evidence is missing, the case waits until it arrives.

**Click** the **Accounting** tab and point at the $3,000.00 payment marked Settled.

> Approving the bill records what the company owes, but it doesn't pay anything. Releasing the payment is a separate decision, and here a different person, the payment authorizer, released exactly three thousand dollars to the supplier's verified account. Then the bank debit was matched to it.

**Click** the second case, **AVILA-202403-A1**, which shows Held.

> This second invoice had already been paid according to the company's old records, so the system holds it and refuses to pay it a second time.

**Click** Ledger and point at "Hash chain verified".

> Everything the agents do is posted to a double-entry ledger in cents. Each entry has to balance, it's chained to the entry before it so that nothing can be changed quietly, and the last column links to the decision that explains it.

**Hand off:** "JJ will show you how we measured all of this."

---

## Part 3 · JJ · the results and where this goes (about 1 minute)

**Page: Results.** The top of the page is the scored run.

> To check the agents, we generate fourteen days of invoices, bank activity and payroll for three stores and plant thirteen errors in them, with an answer key that the agents never see. In this run they caught all thirteen, they left all three legitimate look-alikes alone, and they raised no false alarms.

**Scroll** to "What we measured" and open **Public benchmarks**, then **Kernel tools vs spreadsheet tools**.

> We also ran fifteen public finance tasks. Our agent team scored 93.3% and the same model on its own scored 84%. When we gave the same model our ledger's tools instead of spreadsheet tools on eleven tasks, it needed 12 tool calls instead of 71 and finished in half the time.

**Open** the **Real sandbox evidence** group.

> Two invoices went through the real QuickBooks and Increase sandboxes from start to finish. They were approved, paid through Increase, written into QuickBooks as a bill and a bill payment, and matched to the bank debit.

**Switch** to the architecture diagram in Preview.

> Next, with a customer's permission, the records of reviewed cases could improve our extraction and the agents' tool choices and help post-train open-weight models, with every update tested before it's used. That's Autonomous Finance: for every payment, a clear answer to what we owe, why we owe it, who authorized it and what happened to the money.

---

## The results, one by one (for questions)

Each item below is on the Results page, and each one lists the file that it came from.

**Scored run (top of Results)**
- *13/13 planted errors caught, 3/3 look-alikes left alone, 0 false alarms.* The simulator plants errors like overcharges, short shipments, duplicate invoices, a fake bank-change email and an unknown wire, and it scores the agents against an answer key that they never see. This run used no model calls.
- *Don't scroll down to the books table.* In this run the books check doesn't close, because invoices that need a CFO decision stay open by design. If someone asks, say that the planted-error scoring is the result we stand behind, and that our earlier runs across four seeds closed on every account before we added the rule that a person has to decide on short-pays.

**Public benchmarks.** These were 15 tasks from APEX-Accounting, DABstep, Invoice Sandbox and FinBalance. Our team scored 93.3% and the same model alone scored 84.0%. By benchmark, the team got APEX 3 of 3 against the model's 2 of 3, DABstep 5 of 5 against 4 of 5, Invoice Sandbox 18 of 18 for both, and FinBalance 4 of 4 balance sheets for both. Each task ran once, so this is small.

**Tools versus spreadsheet.** The same model ran the same 11 tasks twice, once with our ledger's tools and once with spreadsheet tools. With our tools it needed 12 tool calls instead of 71, took 45 seconds instead of 94, and cost $0.12 instead of $0.48.

**AP cases**
- *PDF parsing:* on two supplier layouts that the parser had never seen, it got all 104 checked fields right and found the exact source location for 102 of them.
- *Crash recovery:* in a test where the bank accepted a payment but the response was lost, recovery produced one transfer, one bank debit and one entry in the books.
- *APEX replay:* the $3,000 invoice settled and matched, and the $3,500 invoice that was already paid passed all 12 of its checks, with the second payment refused.

**Sandbox.** The $678.60 invoice became QuickBooks Bill 145 and BillPayment 146 plus one Increase transfer. The $77 invoice became Bill 147 and BillPayment 148. Auth0 login was verified. Signed webhooks and returns or credits have not been verified.

**Tests and controls.** All 22 kernel control tests pass, and the full test suite has about two thousand tests that pass. A separate review by another Claude model checked the accounting and found that every journal balances. Its two most serious payment findings are now fixed: releasing a payment needs a different person from the bill approver, and payments have amount limits. The findings that are still open are listed honestly on the page.

**Connectors (bottom of Results).** For each outside service (Increase, QuickBooks, Auth0, LlamaParse, OpenAI and our own bank simulator), the page lists what we've proven and what we haven't. The "Running now" line shows what this laptop is using right now, which is the local bank simulator and simulated people.

## Questions, and who answers them

- **"Is this real or simulated?"** (Srivatsav) "The company, the invoices, the people's seats and the bank on this laptop are simulated. Two invoices also went through the real Increase and QuickBooks sandboxes, and the bottom of the Results page shows what we've proven against each service."
- **"What if the model is wrong?"** (Arav) "Every field stays linked to the source so that a person can check it, and the database checks the arithmetic, who is allowed to approve and the payment rules. A wrong answer from the model can't move money on its own."
- **"Can you parse a new PDF live?"** (JJ) "On JJ's laptop, yes, because LlamaParse is set up there. On this laptop we show cases that were already read, and the PDF results are what you see in the field citations."
- **"What's still missing?"** (JJ) "The disputed part of an invoice can't yet be approved later, a payment can ignore an available credit, and there's no way to void a bill that was recorded by mistake."
- **"Is it self-improving?"** (JJ) "Not today. The agents can already write and test new parser rules in the simulator, but improving the model itself is on our roadmap, and it would be supervised and tested."
- **"How does this make money?"** (Srivatsav) "The core business is the workflow software. Curated datasets and finance training environments, built only from data that customers authorize, could become a second line later."
