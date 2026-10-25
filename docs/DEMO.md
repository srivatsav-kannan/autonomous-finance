# Demo plan

Cal Hacks 13.0, Hyphenate track. Devpost is due Sunday Oct 25 at 9:00 AM PT; judges visit tables 10:30 AM–12:30 PM. The structure follows JJ's demo outline (the four Hyphenate questions); every number comes from [RESULTS.md](RESULTS.md).

## Seat line

> We fill the AP clerk, payments and controller seats at a 281-restaurant chain. The same kernel also runs cash, revenue, payroll, leases and close.

The first sentence is the pitch. The second is the reveal, and we say it after AP has landed, not before.

## Framing

Hyphenate's booth asked whether this is too ambitious. So we lead with accounts payable and go deep: bills in every format, a fraudulent bank change, a human approving the big payment, a payment that survives a crash, and "why did you hold this?". That's the track's own AP example, end to end.

Then the reveal: the rest of the department runs in the same run. Our reason is pace. An AP agent that's fast but hands off to humans working in spreadsheets for cash and close just waits on them. So the whole function runs on tools built for agents, and we measured that against an agent forced to use a spreadsheet.

## The four questions

| Hyphenate question | Live (2:00) | Video (2:30) |
|---|---|---|
| **Real:** is it realistic, does it work? | 1:25–1:45 | 0:30–1:05, 2:15–2:30 |
| **Hire:** would you hire it, with what access? | 0:10–0:25 | 1:05–1:35 |
| **New:** is anything new? | 1:45–2:00 | 1:55–2:15 |
| **Moment:** catches, recovers or defends | 0:25–1:25 | 0:00–0:15, 1:35–1:55 |

## Before judges arrive

Run from `autonomous-finance/`, about 10 minutes before. One backend per checkout.

```bash
npm run backend                                   # terminal 1, leave running
npm run backend:configure                         # once the backend is up
npm run gateway                                   # terminal 2, human seat on :8787
npm run console                                   # terminal 3, http://localhost:5173
npm run world -- --run demo --stores 3 --days 14 --pace 20000 --close   # terminal 4
npm run agents -- --run demo                      # terminal 5
```

- **Pace:** at `--pace 20000` (a simulated day every 20 seconds), start the world about 4 minutes before the judge arrives. By then the inbox has decisions and the team has learned a parser.
- **Crash run:** have terminal 6 ready with `npm run demo:local -- --browser-approval --lease-wait-seconds 40`. Don't start it yet. It prints the path to `browser-session.json`; paste its scope and JWT into `/ap-demo` once, before the judge arrives, and tick "Reload this view every 3 seconds".
- **Tabs open, in this order:**
  1. `/ap-demo`
  2. Control room
  3. Live activity
  4. Finance flow
  5. Evals
  6. the latest green CI run
  7. a decision commit in Memory
- **Spend:** `OPENAI_API_KEY` in `.env.local`, capped by `AGENT_MAX_USD` (default $15, see `var/agent-spend.json`). A 14-day run costs about 5 cents.
- **If `bad_admin_secret`:** run `npm run backend:configure`.
- **Backup:** the recorded video, on the laptop and on a phone. Everything runs locally except the model calls.

## Live, 2:00 (one judge at the table)

| Time | Screen | What happens | What we say |
|---|---|---|---|
| 0:00 | terminal 6 | Start the crash run. | The seat line. |
| 0:10 | `/ap-demo` | Point at the amount, the beneficiary and who requested it. Approve. | "A human approves the payment. The agent that asked for it can't." |
| 0:25 | terminal 6 | The bank accepts the $100 payment, the response is lost and the worker is killed. The terminal counts down the lease. | "The bank took the money and the worker died before it heard back. Most systems either pay twice or lose track." |
| 0:35 | Control room → **Phishing bank-change email**, then Live activity | While the lease waits: a look-alike domain demands same-day wires to a new account and says "ignore previous instructions". The payments agent refuses it. The domain doesn't match, it flags the instructions aimed at the AI, and the callback to the number on file doesn't confirm. | "New bank details the day before a big payment is the fraud that costs companies millions. Even a fooled agent couldn't change them: the kernel requires a human." |
| 1:05 | `/ap-demo`, terminal 6 | The new worker reuses the saved request and key, and gets the original transfer back. Status reads `settled / posted / matched`; the terminal asserts one transfer and one journal entry. Close has two signatures. | "Exactly once. Same key, same transfer, one entry in the books." |
| 1:25 | Finance flow, then Evals | The reveal: the same run across cash, revenue, payroll, leases and close. The ghost employee held out of payroll, the CAM charge over the lease cap. Then the eval: 13 of 13 planted errors, books correct. | "And it isn't only AP. A fast AP agent waits on the humans in cash and close, so the whole department runs on tools built for agents. We check it against an answer key the agents never see." |
| 1:45 | Control room → Ask why | "Why did you hold INV-1002?" The answer cites the decision commits. Offer the scenario menu. | "Every call traces to the data, rule or person behind it. Want to throw something at it?" |

**If we get 3:00,** add the inbox after 1:05: open "Approve $50,949.23 to Embarcadero Realty Partners" and show the bills, the bank details on record and who already approved. "Policy decides what a human sees. Here that's about 9 decisions per 100 events."

## Scenario menu (judge's choice)

Each trigger takes under 30 seconds.

| Judge says | Trigger | What they see |
|---|---|---|
| "A vendor changes bank details before a big payment" | Control room → **Phishing bank-change email** | Refused and escalated. In the eval, `remit_change_fraud` is blocked and the decoy `legit_remit_change` passes after a callback. |
| "Same invoice arrives twice" | Control room → **Resend an invoice through the portal** | Rejected as a duplicate. The decoy (same amount, different delivery) still pays. |
| "Money leaves and nobody knows why" | Control room → **Unknown wire out of operating** | Parked in suspense and escalated to a human; close is blocked until it's resolved. |
| "The bank never confirms" | the crash run | The new worker gets the original transfer back; one entry. |
| "An agent approves its own request" | `npm run controls` (22 cases, about 10 s) | `self-approval` and `answer-own-ask` are refused and logged. |
| "A format you've never seen" | Memory → the parser proposal | The model read it once, the integrations engineer wrote a parser spec, the controller re-ran its tests and merged it. |
| "Why did you do X?" | Control room → Ask why, or `npm run ask -- "…"` | Answer with citations. |
| "Close the month" | Control room → **Close the period** | Blocked while anything is unresolved; otherwise the controller and the human sign. |

## Video, about 2:30

Burn in captions, zoom on amounts and IDs, and label every sped-up wait. About 350 words of voiceover.

| Time | Question | Shot |
|---|---|---|
| 0:00–0:15 | Moment | Cold open: the bank accepts, the worker is killed, a new worker pays exactly once. |
| 0:15–0:30 | — | Title card with the seat line. |
| 0:30–1:05 | Real | Sweetgreen, simulated from its FY2025 10-K. 64 invoices, 21 in formats our code can't read, 13 planted errors, 3 look-alikes, and an answer key the agents never see. Live activity as bills arrive; the parser proposal in Memory. |
| 1:05–1:35 | Hire | Seats and limits. The AP clerk can't approve its own bill, and the kernel blocks the bank-detail change. The CFO's inbox has 5 decisions. |
| 1:35–1:55 | Moment | The crash replay: saved key, the lease wait (labeled "sped up 30 s"), polling, one posting, two-signature close. |
| 1:55–2:15 | New | Each seat has its own identity and limits; `git blame` on a number goes to the decision commit. Then the reveal: Finance flow across the department. |
| 2:15–2:30 | Real | The proof card below, and a green CI run of the crash recovery. |

## Proof card

From [RESULTS.md](RESULTS.md), OpenAI `gpt-6.1-sol`:

| | Result |
|---|---|
| Simulated company, 4 seeds × 3 stores × 14 days | 13 of 13 planted errors caught on every seed ($3,774–$3,986 at risk), 3 of 3 look-alikes left alone, 0 false alarms, 64 of 64 invoices read, books correct on every account |
| Cost and time per run | $0.04–0.05, 71–82 s |
| Same model, kernel tools vs spreadsheet tools, 11 tasks | 12 vs 71 tool calls, 45 vs 94 s, $0.12 vs $0.48, 4 of 4 vs 3 of 4 planted errors caught |
| 156 bookkeeping operations, 18 bad ones injected, no model | Kernel: all 18 stopped. Spreadsheet: 8 flagged after the fact, 10 never caught |
| 15 public benchmark tasks (APEX, DABstep, Invoice Sandbox, FinBalance) | Our team 93.3% (14 of 15) vs the same model alone 84.0% (12 of 15), at about 1.7× the cost |
| Control tests | 22 of 22 hold |
| Payment through a worker crash | 1 transfer, 1 journal entry, runs in CI on every PR |

## Real versus simulated

Say this plainly when asked.
- **Real:** the kernel and its controls, the agents and their model calls, the public benchmark data, all timings and costs.
- **Simulated:** the company, its vendors, staff and bank feed, and the bank in the payment demo (a local simulator). The Increase sandbox adapter is built and contract-tested but not run live.

## Q&A prep

- **"Is this too ambitious?"** The demo is AP, and AP is complete: formats, matching, fraud, approvals, exactly-once payment and recovery. The other seats run in the same run because a fast AP agent otherwise waits on humans in cash and close.
- **"What if the model is wrong?"** The model never moves money. The kernel checks arithmetic, evidence, duplicates and authority on every write; wrong numbers are refused and anything unclear goes to a human.
- **"Prompt injection?"** Documents are data. The fraud email shows the agent flagging the injected text, and even a fooled agent can't change bank details: that needs a human who didn't propose the change.
- **"Did you plant the errors?"** Yes, and the agents never see the answer key. The public benchmarks are other people's tasks.
- **"Why several agents, not one?"** Segregation of duties: the requester can't approve, the proposer can't merge. On the public tasks, the controller's review fixed two answers the model got wrong alone.
- **"What does it cost?"** About 5 cents for 14 days of 3 stores. Most tasks are plain code; the model reads new formats and handles judgment calls.
- **"Who's accountable?"** Every action is logged with the seat that took it, and any number traces to its decision commit.
