# Judging brief

For the table, Sunday 10:30 AM to 12:30 PM. The walkthrough is in [ONE-CONSOLE.md](ONE-CONSOLE.md). This file covers what to say: the numbers, the startup questions and who does what.

## One line on the seats

> We fill the accounts payable seats at a multi-location restaurant chain. The agents read every bill, match it to the order and the delivery, catch the duplicates and the fraud, and prepare the payment. The controller and CFO keep approval and release.

Hyphenate asks for this line explicitly. Say it in the first 15 seconds.

## Lines that land

Use these as they are. Each is true and backed by a file in the repo.

- "The agent can't pay anyone. A person can, and it can't be the person who asked."
- "A spreadsheet will let you approve your own payment. Our ledger won't."
- "If the bank goes quiet, we ask the bank. We don't pay twice."
- "Every new invoice format costs us one model call. After that it's code."
- "Two weeks of books for three stores took 82 seconds, cost five cents and needed five decisions from the CFO."

## Before and after

Lead with what we measured. Use industry figures only for the "before" side, and say where they come from.

| | Before | With us | Source |
|---|---|---|---|
| Cost to process an invoice | $9.40 on average, $2.78 for the best AP teams | Under a tenth of a cent in model cost per invoice. Document parsing and the human decisions come on top. | Ardent Partners 2025 (industry); our seed-7 run: $0.05 for 218 tasks and 64 invoices |
| Time to process an invoice | 9.2 days on average, 3.1 days for the best | Agent work is done in seconds. What's left is however long the approver takes. | Ardent Partners 2025; seed-7 run: 82 s for 14 simulated days |
| Human touches | Someone handles every invoice | 5 CFO decisions across 230 events and 64 invoices in two weeks | Seed-7 run (before #105; two more invoice types now wait for a person) |
| Same model, same 11 tasks, spreadsheet vs our ledger | 71 tool calls, 94 s, $0.48, 3 of 4 errors caught | 12 tool calls, 45 s, $0.12, 4 of 4 caught | [RESULTS.md §1](../docs/RESULTS.md) |
| 18 bad bookkeeping operations | Spreadsheet missed 10 completely | We stopped all 18 (15 before they landed, 3 right after) | [RESULTS.md §1](../docs/RESULTS.md) |
| One generalist agent vs our team, same world | $7.80, 42 minutes, 12 of 13 errors | $0.15, 87 s, 13 of 13 | [RESULTS.md §2](../docs/RESULTS.md), Claude run |
| Duplicate and erroneous payments | 0.8% to 2% of everything a company pays out | Zero bills paid twice; a duplicate is refused by the database | APQC (industry); seed-7 controls table |

For the fraud email: business email compromise, where a fake email asks to redirect a payment, cost US companies about $2.8B in 2024 according to the FBI.

Short version for the pitch: "An AP team spends about nine dollars and nine days per invoice. Our agents do the work in seconds for a fraction of a cent, and the people only make the decisions."

Productivity, said carefully: industry exception rates are around 14%, so in a typical team most invoices could be handled without a person. In our two-week run, the CFO made 5 decisions out of 230 events. Don't turn that into a percentage of headcount saved. We haven't measured headcount.

**Back-of-envelope if a judge asks for scale.** In our simulation, each store gets about 21 invoices every two weeks. Across Sweetgreen's 281 stores that's roughly 156,000 invoices a year, or about $1.5M a year at the industry average processing cost. At 0.8% to 2% duplicate or erroneous payments, the leakage on supplier spend is bigger than that. Say it's an estimate built from our simulation and published averages.

## Hyphenate's four questions

| Their question | Our answer | What to show |
|---|---|---|
| Is it real enough? | We simulated a Sweetgreen calibrated to its FY2025 10-K, with 13 planted errors and an answer key the agents never see. Two invoices went through the real Increase and QuickBooks sandboxes. | Evals & tests page, Connectors page |
| Would you hire it? | It has its own login with limits, every decision is a git commit you can blame, and it holds a bill instead of short-paying it when something is off. | Invoice case history, the held invoices in the Inbox |
| Did we see something new? | Most finance agents drive a spreadsheet or a browser. We built a ledger for agents, where the controls live in the database instead of the prompt. | The fraud email: even a fooled agent can't change bank details |
| The moment | It refuses a fraud email that says "ignore previous instructions". It refuses to pay an invoice that was already paid. It pays exactly once after a crash. | Open with the fraud email |

Their "what makes it hard" list maps straight onto what we built. Use their words when you answer.

- **Sources that disagree:** each bill is checked against the contract, the purchase order, the delivery receipt and the bank.
- **Time:** an old credit gets applied to a later invoice. An invoice that was paid in last year's records is held. A parser learned once is reused.
- **Working with others:** the agent asks the CFO only when a decision needs a person, and it waits for a missing receipt and then picks the case back up.
- **Limits:** whoever requests a payment can't approve it, and releasing payment needs a different person from the one who approved the bill.
- **Explainable:** ask "why did you hold INV-1002?" and the answer cites the commits.

**They may ask us to run their own scenario.** The Control room injects a fraud email, a duplicate invoice or an unknown wire, and has an "ask why" box. Practise each one once. If they hand us a PDF, it only works with `LLAMA_CLOUD_API_KEY` in `.env.local`, so put a key on the laptop before 10:30.

## Startup questions

**Who is the customer?** Multi-location operators with 50 to 500 sites, like restaurant groups, clinics and retail chains. They have hundreds of suppliers, every invoice format you can think of, and a small finance team.

**Who buys it?** The controller or the CFO. They own the books and they carry the risk if a payment goes wrong.

**How do you make money?** We'd charge per invoice processed. The industry average is $9.40 an invoice, and our model cost is under a cent, so there's room to price well below what they spend now. This is a hypothesis; we haven't tested pricing with a customer.

**Who else does this?** Bill.com, Tipalti, Stampli and Ramp digitize the AP workflow, but a person still does the work at each step. We do the work and keep the person for the decisions. Agent startups that drive spreadsheets or browsers have no controls underneath them. Ours are in the ledger.

**What's the moat?** Each customer's invoice formats become code after the first read, so our cost per invoice goes down as they grow. Every decision and every learned rule builds up as their own history in git, which makes switching to someone else costly.

**Why now?** Models can finally read any invoice. Trust is what stops a company from letting one pay a supplier, and that's the part we built.

**What's the biggest risk?** That a company won't trust an agent with money. That's why the agent can't move money. A person authorizes the exact amount and the exact destination, and it's never the same person who asked.

**What's next?** First we close the open control findings from our review. Then we find a design partner, run their real invoices in shadow mode next to their AP team, and measure how often we agree with their decisions.

**What's real and what's simulated?** The company, its documents and the bank in our tests are simulated. The model, LlamaParse, Auth0 and the Increase and QuickBooks sandboxes are real. Say this before they ask.

## Roles

If asked "what did each of you do", answer like a founding team. Each of us owns about a third.

- **Srivatsav, CEO and product.** He designed the company we simulate and the evals that score us, built the one console, and owns the story and the submission.
- **JJ, CTO.** He built the AP case system: reading invoices, linking every field to the source, the separate approvals, and the QuickBooks, Increase and Auth0 connections. He takes the deep technical questions.
- **Arav, payments and reliability.** He built bank execution and settlement: pending holds, applying credits once, matching bank activity to payments, and making payments survive a crash. He also set up CI, and he runs the laptop during the demo.

Speaking order follows [ONE-CONSOLE.md](ONE-CONSOLE.md): Srivatsav opens, Arav walks the invoices, JJ does proof and connectors and takes the technical questions.

## Don't say

- Don't say the books close in the current scored run. Two invoices now wait for a CFO decision on purpose.
- Don't say "production-ready" or "exactly once, guaranteed". Say "one transfer in our crash test".
- Don't say the review findings are all fixed. F3 and F5 to F11 are still open.
- Don't scale the planted-error dollars up to a yearly savings number. We planted those errors ourselves.

Industry sources: [Ardent Partners metrics via apexanalytix](https://www.apexanalytix.com/resources/blog/ardent-partners-key-ap-metrics-2025/), [APQC duplicate payments via CFO.com](https://www.cfo.com/news/metric-of-the-month-detect-and-prevent-duplicate-or-erroneous-payments/), [FBI IC3 2024 business email compromise losses](https://www.nacha.org/news/fbis-ic3-finds-almost-85-billion-lost-business-email-compromise-last-three-years).
