# Team plan

Deadline: **Sun Oct 25, 8:50 AM PT**. Submit by 8:15. Judging starts 10:30.

## Where we are (Fri 10 PM)

Working end to end:
- kernel
- git memory
- world simulator with 11 planted error types
- 12-seat agent team with dynamic staffing
- scored evals
- console with human gateway

Last deterministic run, 3 stores over 14 days:
- caught 14/14 planted errors; 3/3 decoys handled; 0 false alarms
- books match truth to the cent; all controls pass
- 18 seconds of wall clock
- **coverage gap:** 21 of 65 invoice documents need Claude (narrative and new-format invoices)

## Owners

| Person | Owns | Next |
|---|---|---|
| **Srivatsav** | Agent runtime, Claude paths, integrations engineer, WebMCP | Turn on Claude: extraction, parser learning and "why" answers on a 65/65 coverage run. Factory Droid as the parser writer. |
| **JJ** | Evals and decision quality | Baselines on the same world (a single generalist Claude agent with the same tools; rules only). Held-out error types the rules weren't written for. Act/ask/hold calibration. Multi-seed runs. A FinBalance subset as an external benchmark. |
| **Arav** | Kernel and sponsor rails | Capital One Nessie as the bank, replacing `WorldBank`. CRS checks on vendor onboarding and remit changes (OFAC, business, identity). Auth0 push approvals (stretch). |
| **Arav's friend** | Console, demo, submission | Console polish. The 3-minute story and the video (opens with the moment). Devpost page. Fetch.ai Agentverse CFO agent (stretch). |

## Priorities

1. **P0:** Claude on, a 65/65 coverage eval, and the demo moment rehearsed.
2. **P0:** Baseline comparison table; Hyphenate wants proof.
3. **P1:** Nessie bank rail, CRS checks, Factory Droid for parsers.
4. **P2:** Fetch.ai, Auth0, Moss.

## The moment (video opens here)

A phishing email asks us to send Golden State Produce's money to a new bank. It even tells the AI the change is "pre-approved".
- The payments agent checks the sender's domain against vendor memory.
- It calls the number on file. The real vendor says they didn't send it.
- It blocks the change and writes the attempt into vendor memory.
- It tells the human CFO, while 200 routine transactions keep flowing.

Then show the judge-driven version from the control room.

## Hyphenate's four questions → where we answer them

| Question | Our evidence |
|---|---|
| Is it real enough? | Calibrated to SEC filings. Messy multi-source data: POS, card processor, delivery platforms, suppliers, landlords, payroll, bank. Books vs truth to the cent. |
| Would you hire it? | Seat-level limits enforced by the kernel. The hash-chained ledger and git memory are the clean record. Asks to humans only where policy requires (~9 per 100 events). |
| Did we see something new? | A whole finance org of agents on an agent-native stack, not a copilot layered on human tools. Agents write their own integrations. |
| The moment | Catches fraud, duplicates, ghost employees and fee overcharges; recovers from unknown formats by writing a parser; defends any decision with `git blame` and a cited "why". |

## Sponsors

| Track | Status |
|---|---|
| Hyphenate | primary, all of it |
| Convex | the kernel, live console |
| Microsoft Built for the Real World | production design, controls, cost per transaction |
| Factory Droid SDK | integrations engineer (to wire) |
| CRS | vendor risk checks (to wire) |
| Capital One Nessie | bank rail (to wire) |
| Fetch.ai / Auth0 / Moss | stretch |
