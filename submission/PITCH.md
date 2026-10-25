# Live judging plan

## How judging works (from the organizers' email)

- The whole team is at the Palace of Fine Arts by **9:30 AM**, and at our assigned table by **10:30 AM**.
- Judging runs **10:30 AM to 12:30 PM**. We have to be at the table the whole time. If a judge comes and we're not there, we don't get judged.
- At least 3 judges will come by. Each one has **5 minutes max**, so plan a **3-minute pitch** and about 2 minutes of questions.
- A **live demo is required**. We also need a **video of the demo saved on the laptop** in case something breaks.
- Up to 3 teams share a table, so keep the laptop and voices contained.

Roles below are a suggestion. Swap names if you want, but keep one person on the keyboard during each part.

- **Srivatsav:** opens, shows the CFO inbox and "ask why", answers the "is this real?" and "too ambitious?" questions.
- **Arav:** drives the laptop for the payment and fraud demo, answers security and controls questions.
- **JJ:** shows the rest of the department and the numbers, answers eval and benchmark questions.

## Before 10:30 (about 15 minutes)

Run these from `autonomous-finance/`, each in its own terminal:

```bash
npm run backend                                                   # terminal 1, leave running
npm run backend:configure                                         # once, after the backend is up
npm run gateway                                                   # terminal 2, leave running
npm run console                                                   # terminal 3, leave running
npm run world -- --run demo --stores 3 --days 14 --pace 3000 --close   # terminal 4, finishes in about a minute
npm run agents -- --run demo                                      # terminal 5, leave running all morning
```

The agents need to keep running so the Control room still works after the 14 days are over. We tested this at 1 AM on a finished run: the fraud email was blocked within seconds.

Open these browser tabs, in this order:
1. `http://localhost:5173/ap-demo`
2. `http://localhost:5173/?view=control#demo` (Control room)
3. `http://localhost:5173/?view=inbox#demo` (Inbox)
4. `http://localhost:5173/?view=flow#demo` (Finance flow)
5. `http://localhost:5173/?view=evals#scenario-check` (a scored run with the model on: 13 of 13)

Also have ready:
- the demo video on the desktop
- the latest green CI run on GitHub, as backup proof for the crash recovery

## Before each judge (Arav, about 1 minute)

The payment crash demo is used up after each judge, so set up a fresh one:

```bash
npm run demo:local -- --browser-approval --lease-wait-seconds 40   # terminal 6. Ctrl-C the previous one first.
```

It prints `awaiting_browser_approval` and the path to `browser-session.json`. Then:
1. Open that file.
2. In the `/ap-demo` tab, paste the `scope` and `jwt` from it.
3. Click **Connect and load review** and tick **Reload this view every 3 seconds**.
4. Stop at the approval checkbox. Don't approve until the judge is watching.

## The 3-minute pitch

| Time | Who | Screen | What to do | What to say (roughly) |
|---|---|---|---|---|
| 0:00 | Srivatsav | none | Face the judge. | "Finance agents today are a model driving a spreadsheet or a browser. Those tools were made for people. For an agent they're slow, and they don't check anything. A spreadsheet will let you approve your own payment. So we built a ledger for agents instead. Our agents run accounts payable for a restaurant chain modeled on Sweetgreen, and the human CFO only makes the management calls. Arav will show you." |
| 0:25 | Arav | `/ap-demo` | Point at the amount, the vendor and who requested it. Tick the box and approve. | "This is the CFO's screen. A $660 payment to Golden State Produce. The agent that asked for it isn't allowed to approve it, so I do." |
| 0:40 | Arav | terminal 6 | Point at the line that says the bank accepted and the worker was killed. | "The bank just took the payment, and we killed the worker before it could write that down. This is where most systems pay twice or lose track of the money. A new worker takes over in 40 seconds. While we wait…" |
| 0:50 | Arav | Control room, then Inbox | Click **Phishing bank-change email**. Wait about 10 seconds. Open the Inbox item "Blocked a suspected fraud attempt against Bay Farms Protein LLC". | "This is an email from a fake domain asking us to send money to a new bank account. It even says 'ignore previous instructions' to the AI. The payments agent blocked it: the domain doesn't match, it's talking to the AI, and the callback to the number we have on file didn't confirm. Even if an agent got fooled, the database won't change bank details without a human." |
| 1:20 | Arav | `/ap-demo`, terminal 6 | Show `settled / posted / matched` and the terminal's `bankTransfers: 1`, `paymentJournalEntries: 1`. | "The new worker asked the bank about the original payment instead of sending another one. One transfer, one entry in the books." |
| 1:35 | Srivatsav | Control room | Type "Why did you hold INV-1002?" and click Ask. Switch tabs while it thinks. | "You can ask the agents why they did anything." |
| 1:40 | Srivatsav | Inbox | Open "Approve $50,949.23 to Embarcadero Realty Partners". Don't approve it, so it's there for the next judge. | "This is all the CFO sees: the decisions that need a person, like this rent payment, with the bills and bank details attached. Everything else the agents handle." |
| 1:55 | Srivatsav | Control room | Show the answer. | "The answer: a short shipment. Golden State billed 6 cases of kale and we received 4, so the controller paid $77 less. And it links to the exact records where that was decided." |
| 2:10 | JJ | Finance flow | Point across the stages. | "It's not just AP. The same system runs cash, revenue, payroll, leases and the month-end close. If AP moves at agent speed but close still waits on people in spreadsheets, AP just waits on them." |
| 2:25 | JJ | Evals | Point at 13/13 and the books table. | "We tested it. We plant 13 errors in 14 days of Sweetgreen-sized activity, with an answer key the agents never see. They catch all 13 on every seed, the books come out right, and a run costs about 5 cents. We gave the same model spreadsheet tools on the same work: 71 tool calls instead of 12, twice as slow, four times the cost, and it missed an error. On 15 public finance benchmark tasks, our agents scored 93% and the same model on its own scored 84%." |
| 2:55 | Srivatsav | none | Wrap up. | "That's Autonomous Finance. Happy to take questions." |

If we're running long, cut the "ask why" part (1:35 and 1:55) first.

## Questions, and who answers them

**Srivatsav**
- **"Is this real data?"** "The company is simulated, but it's calibrated to Sweetgreen's public filing: revenue, store count, payables, leases. The benchmarks are public datasets other people wrote."
- **"Isn't this too ambitious?"** "We went deep on accounts payable: invoice formats, matching, fraud, approvals, and paying exactly once. The other parts run in the same system because a fast AP team that hands off to a slow close process still ends up waiting."
- **"Who would use this?"** "A finance team at a multi-location business, where AP is high volume and mostly routine, but the mistakes are expensive."

**Arav**
- **"What if the model is wrong?"** "The model never moves money. Every write goes through the database, and it checks the math, the evidence and who's allowed to do it. If the numbers don't add up, the write is rejected and a person gets asked."
- **"Prompt injection?"** "Documents are treated as data. You saw the fraud email get blocked. And even a fooled agent can't change bank details, because that needs a human who didn't propose the change."
- **"How do you stop double payments?"** "We save the exact request and its key before sending, and only one worker can hold a payment at a time. On a crash, the new worker asks the bank about the original. CI kills a worker mid-payment on every pull request."

**JJ**
- **"Did you plant the errors yourselves?"** "Yes, and the agents never see the answer key. That's why we also ran public benchmarks other people wrote."
- **"Why several agents instead of one?"** "Separation of duties, the same reason companies split it between people. On the public tasks, the controller's review fixed both answers the model got wrong on its own."
- **"What does it cost?"** "About 5 cents for 14 days of 3 stores. 92% of tasks are plain code, and the model is only called for new invoice formats and judgment calls."

## If something breaks

- **The crash demo stalls or errors:** skip it. Say "this runs on every pull request in CI" and show the green CI run. Then go on with the fraud email.
- **The model is slow or the wifi is down:** skip "ask why". The fraud email still works, because the domain check and callback don't need the model. If the whole demo is down, play the video.
- **A tab shows an error:** refresh it. If the console is stuck, restart `npm run console`. The data lives in the backend, so nothing is lost.
