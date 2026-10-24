# Evaluation results

Status as of Oct 24, 2026. Three evals test our system itself:
- the simulated Sweetgreen finance team
- the kernel control tests
- a head-to-head against one plain Claude agent on the same simulated world

The four outside benchmarks run so far (FinBalance, Invoice Sandbox, DABstep, Vals Finance Agent) measured Claude Opus 5.5 by itself; none of our code was involved. Our system now runs on Invoice Sandbox too ("System C"). It is built and checked end to end, with Claude off and with a fake local Claude API. The paid Claude-on runs are waiting for credit.

The API key ran out of credit at about 08:14 UTC on Oct 24 (1:14 AM PT). Every run that calls Claude is paused until the key is topped up or replaced.

## Summary

| Eval | Tests our system? | Result | Comparison | Cost | Status | Source |
|---|---|---|---|---|---|---|
| Simulated world, seed 7 | Yes, full system | 13/13 errors, 3/3 decoys, 0 false alarms, 64/64 invoices, books exact | none (self-built) | $0.15 | done | [run](runs/eval-claude-on-hardened-s7-mvm2qxru.md) |
| Same, Claude off | Yes (ablation) | 13/13 errors, 3/3 decoys, 43/64 invoices | Claude on reads 21 more invoices | $0 | done | [run](runs/eval-regress-off-s7-mvmr5s8a.md) |
| Unseen seeds 11, 23, 42 | Yes | same as seed 7 on every seed | same as seed 7 | $0.12–0.13 each | done | [11](runs/eval-unseen-s11-mvm3xv56.md), [23](runs/eval-unseen-s23-mvm3zmlb.md), [42](runs/eval-unseen-s42-mvm41ecs.md) |
| Control tests | Yes, kernel + memory | 23/23 hold | none | $0 | done | [control-tests.json](control-tests.json) |
| Head-to-head | Yes, vs plain Claude | ours 13/13 and 3/3; plain Claude 12/13 and 2/3 | $0.15 vs $7.80; 87 s vs 42 min | $7.80 | done, 1 seed | [run](runs/baseline-s7-mvm30964.md) |
| Invoice Sandbox via our system (System C) | Yes, full system | Claude off: 0/18 (can't read the PDF layout), 148/148 documents accounted for. Claude on: pending | A and B: 18/18 | $0 so far; est. under $2/run | built; Claude-on runs need credit | [below](#invoice-sandbox-run-through-our-system-system-c) |
| FinBalance | No, Claude only | 69.2% of balance sheets exact | GPT-5: 46.5% (paper) | $26.78 | done (178 of 710 records) | [finbalance.md](finbalance.md) |
| Invoice Sandbox A and B | No (B copies our design, not our code) | 18/18 for both, every run | author's best run: 18/18 | $13.53 | fresh-seed check incomplete | [invoice-sandbox.md](invoice-sandbox.md) |
| DABstep dev | No, Claude only | 83.3% ± 5.8 (10 tasks × 3 runs) | not comparable (leaderboard uses 450 hidden tasks) | $2.72 | done | [dabstep.md](dabstep.md) |
| Vals Finance Agent | No, Claude only | 77.3% on 44 of 50 graded | not comparable (leaderboard uses a private set) | $13.11 | stopped by the credit outage | [vals-finance-agent.md](vals-finance-agent.md) |

Result files for our own runs are copied into [`runs/`](runs/), because `var/`, where runs write them, is gitignored.

## Our system

### Simulated Sweetgreen finance team

The world covers 3 stores over 14 simulated days (Jan 1–14, 2026), calibrated to Sweetgreen's FY2025 SEC filing. It contains:
- 64 vendor invoices
- 13 planted errors worth $3,774.33 on seed 7
- 3 decoys that look wrong but are legitimate

The answer key is generated with the world and never given to the agents. Scorer: [`src/evals/score.ts`](../../src/evals/score.ts).

| Run | Errors caught | Decoys right | False alarms | Invoices read | Books (7 lines) | Claude calls / tasks | Cost | Time |
|---|---|---|---|---|---|---|---|---|
| Seed 7, Claude on | 13/13 ($3,774.33) | 3/3 | 0 | 64/64 | exact | 11 / 232 | $0.15 | 87 s |
| Seed 7, Claude off* | 13/13 | 3/3 | 0 | 43/64 | exact | 0 / 220 | $0 | 18 s |
| Seed 11 | 13/13 ($3,986.24) | 3/3 | 0 | 64/64 | exact | 11 / 232 | $0.13 | 82 s |
| Seed 23 | 13/13 ($3,778.82) | 3/3 | 0 | 64/64 | exact | 11 / 232 | $0.12 | 82 s |
| Seed 42 | 13/13 ($3,900.09) | 3/3 | 0 | 64/64 | exact | 11 / 232 | $0.12 | 82 s |

\* Rerun on the current code (with receivables added) on Oct 24. It matches the earlier Claude-off run on merged main exactly ([run](runs/eval-main-merged-s7-mvm1gfos.md)). A Claude-on run made before the evidence hardening scored the same as the hardened run: 13/13, 64/64, $0.14 ([run](runs/eval-claude-on-s7-mvm2g0ta.md)).

What this shows:
- The rules catch all 13 planted error types without Claude.
- Claude's job here is reading invoice formats the code doesn't know yet. It read the 21 unfamiliar invoices and wrote 2 parsers. The controller agent reviewed and merged them, and those formats then ran as plain code.
- 95% of tasks run as plain code. The agents sent the human CFO 21 messages, 6 of them decisions.

Weaknesses:
- We built the world, the error types and the scorer, and the agents were written for these 13 error types.
- The extra seeds change amounts and which store gets each error. They don't change the error types, the vendors involved or the days, and several planted amounts are the same in every seed. So they show the system isn't keyed to specific numbers, not that it catches new kinds of errors.
- The books check covers 7 lines: revenue for each of 3 channels, sales tax, gift card liability, payroll, and rent plus CAM charges. It doesn't check vendor-bill totals, which is why the Claude-off run shows exact books with 21 invoices unread.
- There was one run per seed.

### Control tests (kernel and memory)

[`scripts/control-tests.ts`](../../scripts/control-tests.ts) runs 23 scripted cases against the live kernel and the git memory store, without Claude. Result: **23/23 hold** ([control-tests.json](control-tests.json)). These are scripted cases, not an AI attacker.

- **Must be refused (19):**
  - a bill with no document; one document backing two bills
  - cash posted with no bank evidence; the AP clerk posting cash
  - approving your own payment; paying a bill twice
  - a bank change after approval (it voids the payment); a payment of $50k or more with no human approval
  - an agent hiring a control-role seat; closing a period without a human signature
  - a direct bank-detail change in memory; merging your own change; an unauthorized merge
  - paying an unregistered vendor
  - booking a bank transaction twice; a cash amount that differs from the bank's
  - posting an entry label only the kernel may use
  - an agent making a bank change effective
  - answering your own question to the human
- **Integrity check (1):** the ledger hash chain verifies.
- **Legitimate path still works (3):**
  - a real bank transaction can be booked
  - a cash entry can be corrected by reversal
  - a human can approve a bank change

The first version of the suite found 4 controls that didn't hold. All 4 were fixed in commit `3ef9c92`:
- bills must cite a received invoice, one bill per document
- cash entries must cite a real bank transaction of the same amount, booked once (#4)
- payments go only to registered vendors at bank details a human verified, and bank changes need a human approver
- cash entries can be corrected by reversal (#5)

### Head-to-head: our system vs one plain Claude agent

Both systems ran on the same world (seed 7), with the same data, the same kernel underneath and the same scorer. The baseline ([`src/evals/baseline.ts`](../../src/evals/baseline.ts)) is one Claude Opus 5.5 agent at effort medium. It judges every event itself and has no specialized seats, rules or learned parsers.

| | Our system | Plain Claude agent |
|---|---|---|
| Planted errors caught | 13/13 | 12/13 |
| Decoys handled right | 3/3 | 2/3 |
| False alarms | 0 | 0 |
| Invoices recorded | 64/64 | 64/64 |
| Claude usage | 11 calls | 581 turns, 636 tool calls |
| Cost | $0.15 | $7.80 |
| Wall time | 87 s | 2,522 s (42 min) |
| Postings the kernel refused | 0 | 3 |

- **Missed duplicate:** the plain agent never recorded or rejected the exact duplicate invoice ($139.70). It wasn't paid, but nothing shows anyone saw it.
- **Blocked a legitimate change:** it blocked a genuine change to a vendor's bank details. Our system verified the same change by calling the number on file, then approved it.
- **Kernel refusals:** the kernel refused 3 of its payroll postings, because the payroll seat may not post to account 6000 (General & Administrative).
- **Payroll books aren't comparable:** the credit ran out near the end, and 4 of its 160 events failed (3 payroll registers on Jan 14 and 1 Uber Eats payout report).
- **How far it reaches:** one seed, one run each. 13 vs 12 is a single error. The solid differences are cost (about 50×) and time (about 29×).

A 1-store, 2-day pilot of the same baseline caught 3 of 4 errors for $0.49 in 207 s ([run](runs/baseline-s7-mvm2v6gk.md)).

### Invoice Sandbox, run through our system (System C)

**What it is.** Our actual system, not a copy of its design. [`system-c.ts`](../../evals/external/invoice-sandbox/system-c.ts) does three things:
- creates a fresh company run
- delivers each of the 148 workspace files as a received document, labeled only by folder and file extension
- runs the agent team until nothing is queued, then reads the answer back from the kernel: open invoices and credit memos per customer, plus every document's disposition

It uses the same fresh workspace, the same text extraction and the same scorer as A and B. No benchmark-specific code runs inside the team.

**What we built for it.** These pieces are part of the product now, not benchmark code:
- **Receivables in the kernel** ([`convex/receivables.ts`](../../convex/receivables.ts)):
  - the customer master; customer invoices and credit memos, with the header checked in integer cents (subtotal − discount + tax = total)
  - one record per document and one count per invoice number
  - voids that reverse the entry and block the number; revisions that take the original out of the books, whichever arrives first
  - a disposition for every document received
  - an email can't void revenue, and a recorded document can't be excluded by relabeling it
  - 10 kernel tests ([`tests/receivables.test.ts`](../../tests/receivables.test.ts))
- **An AR clerk agent** ([`src/agents/handlers/ar.ts`](../../src/agents/handlers/ar.ts)). It reads each document and applies the status policy kept in git memory (`policies/receivables.yaml`). Anything the policy doesn't cover goes to a person.
- **Parser writing for customer documents.** The integrations engineer writes a parser for each new document layout, and repairs it when a new variant fails, keeping every earlier test. The controller reviews and merges each one. Other documents in a layout that's still being learned wait for the parser instead of each paying for a Claude read.
- **Held documents.** The controller resolves them. A line arithmetic error on an invoice we issued is counted at the billed total and flagged. Anything else goes to the human CFO.

**Results so far.**

| Run | Customers exact | Documents with a disposition | Claude calls | Cost | Time |
|---|---|---|---|---|---|
| Claude off ([c-off-r1](runs/invoice-sandbox-c-off-r1/)) | 0/18 | 148/148 | 0 | $0 | 34 s |
| Claude on, 3 runs + fresh seed | pending: needs API credit | | | est. under $2 per run | |

- **Claude off scores 0/18.** No built-in code can read this issuer's PDF layout. The integrations engineer asks for Claude credentials once, and all 112 PDFs stay unread but accounted for. The extended trap count from that run (4 of 6) means nothing: unread documents are left out, which happens to be the right treatment for most trap documents.
- **Free end-to-end check of the Claude path.** [`scripts/smoke-receivables.ts`](../../scripts/smoke-receivables.ts) runs the whole flow against a fake Claude API on localhost, using 17 synthetic documents (none from the benchmark). All 17 checks pass. The documents include:
  - a credit memo; an unmarked duplicate copy and a marked duplicate scan
  - an invoice with a line arithmetic error; a void
  - a marked and an unmarked superseded original
  - an unknown status; a statement
  - two emails, a bank export and a notes file

  The model was called twice: one extraction and one parser written. Every other document ran as code.
- **What the paid runs can show.** On accuracy they can at best tie A and B at 18/18. The useful comparison is Claude calls and cost:
  - A sends the documents through one Claude agent ($1.30–1.40 per run).
  - B has Claude read every document ($1.67–1.68).
  - Ours should read one document per layout and write a parser for the rest.

**Disclosure.**
- The receivables agent was built after A's and B's runs on this fixture.
- The trap categories come from the benchmark README, which every system gets.
- The status words in the policy are printed on the workspace documents: OPEN, PAID, PARTIAL, CREDIT, VOID, SUPERSEDED, DUPLICATE_SCAN, STATEMENT.
- We knew from A's and B's runs that six invoices have line amounts that don't multiply out. Our policy counts the billed total and flags it, which is also what A and B did.
- While setting up I saw the answer key's column headers and its first four rows. Nothing in the system is derived from them, and no Claude-on run has been scored yet.

## Claude only (no autonomous-finance code involved)

These runs put Claude Opus 5.5 through each benchmark's own harness, or our port of it. They tell us about the model our agents run on, not about our system. Claude alone already saturates or nearly saturates them, so they can't show our system adding accuracy. What our system adds is control over money, low cost at volume and an audit trail, and none of these benchmarks measure that.

### FinBalance (EMNLP 2026 Findings)

- **Accuracy:** the balance sheet is exactly right on 69.2% of 120 standard records [95% CI 60.7, 77.3]. That is a stratified subset of the official 480. The paper's best model, GPT-5, scored 46.5% on all 480.
- **Contradictions:** on 58 records with a planted contradiction, it named the exact problem 96.5% of the time. The paper reports Grok-4.3 at 96% and GPT-5 at 43%.
- **No aggregation gap:** replaying its own journal entries gives the same verdict on all 120 records. Four of the paper's six models lose 26–41 points there.
- **Ledger check:** a forced ledger check changed the score by +0.0 points [−9.1, +9.1] on 40 paired records. The paper reports +30 to +33 for its models that have the gap.
- **Weak spot:** citations. 46.6% of expected postings cite a different set of documents than the answer key, and only 6.7% of records are right end to end.
- **Contamination check:** it scored 66.7% [48.4, 82.9] on a split we generated, which has never been published, and 70.0% [58.2, 80.7] on the authors' post-cutoff split. Memorization isn't driving the score.
- **Caveats:**
  - only 178 of 710 records
  - no temperature setting, because Opus 5.5 rejects it (the paper used 0)
  - thinking always on
  - one run, while the paper's rows are full-split point estimates
- **Cost:** $26.78 for 394 calls. [finbalance.md](finbalance.md)

### Invoice Sandbox (ciru-ai, commit `b8cb58f`)

The workspace holds 112 PDFs, 30 emails, a CRM file, bank exports and notes for 18 customers. The score is per-customer net spend.
- **A, one plain Claude agent:**
  - 18/18 customers exact in 3 of 3 runs, all 9 trap documents handled and 0 false exclusions, at $1.30–1.40 per run
  - on a fresh seed we generated: 18/18 for $1.47, in 1 run
- **B, a pipeline built the way ours is but not our code** (Claude extracts, rules decide):
  - 18/18 in 3 of 3 runs, at $1.67–1.68 per run and 83–88 s
  - fresh seed not measured: the credit ran out before its 6 adjudication calls (the cases its rules couldn't settle). Rebuilt offline from saved extractions with those 6 held back, it scores 14/18.
- **Published comparison:** the benchmark author's best run, a local open-weight model with a bash shell, also scored 18/18 under a different setup.
- **Caveats:**
  - there is one instance of each trap, and every trap document carries an explicit status word
  - B's rules were written after reading the generator
  - the fresh seed changes the numbers, not the trap types
- **Cost:** $13.53. [invoice-sandbox.md](invoice-sandbox.md)

### DABstep dev split (Adyen)

- **Result:** 83.3% ± 5.8 over 3 runs of the 10 public dev tasks (easy 77.8%, hard 85.7%), using server-side code execution and the official scorer.
- **Not comparable to the leaderboard:** the leaderboard scores 450 hidden tasks; the top validated entry has 87.50% easy and 89.95% hard. The dev answers are public, and nothing was submitted.
- **Cost:** $2.72. [dabstep.md](dabstep.md)

### Vals AI Finance Agent (v1.1 public set)

- **Coverage:** the run was stopped by the credit outage. 47 of 50 questions were answered and 44 graded.
- **Result:** 77.3% (34/44) passed every rubric check [Wilson 95% CI 63.0, 87.2], or 69.1% class-balanced. Across all 50 questions it would land between 68.0% and 80.0%.
- **Unofficial harness:**
  - different search and document tools
  - a Claude judge instead of GPT-5.2
  - a harness bug that blocked most SEC EDGAR filing fetches (fixed, not yet rerun)
- **Not comparable to published numbers:** Vals publishes results only for a private test set; the v1.1 leader is Claude Opus 4.7 at 64.37%.
- **Cost:** $13.11. [vals-finance-agent.md](vals-finance-agent.md)

## What needs API credit, and why

Topping up the balance or adding a new key both work. The key goes in `autonomous-finance/.env.local` as `ANTHROPIC_API_KEY`. That file is gitignored; never commit the key. Costs are measured at list prices unless marked "est."

| Run | Command (repo root) | Cost per run | Why it needs Claude |
|---|---|---|---|
| Our system, simulated world | `npm run eval -- --seed 7 --label x` | $0.12–0.15 | Reads invoice formats the code doesn't know and writes parsers for them (11 calls). Without Claude, 21 of 64 invoices go unread. |
| Our system, Invoice Sandbox (System C) | `npx tsx evals/external/invoice-sandbox/run.ts --system c --run-id c-r1` | est. under $2 (capped at $3 per run by `--run-cap`) | Reads one document per new layout, writes a parser for it, and repairs the parser if a variant breaks it; the rest runs as code. Start with one run to measure the real cost. |
| Live demo, and "why" answers in the console | `npm run agents`, `npm run gateway` | not measured | Same document reading as above. Each "why" question is one short tool loop. |
| Plain-Claude baseline | `npm run -s baseline -- --stores 3 --days 14 --seed 7 --limit-usd 25` | $7.80 (pilot $0.49) | Claude does all the work. |
| Invoice Sandbox A or B | `npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id <id>` (or `--system b ... --sample <n>`) | A $1.29–1.47, B $1.55–1.68 | Claude only. Finishing the stopped fresh-seed runs: about $3.20. |
| FinBalance | see its [harness README](../../evals/external/finbalance/README.md) | $12.54 per 178 records | Claude only. |
| DABstep dev × 3 | `npx tsx evals/external/dabstep/run.ts --label dev-x3 --runs 3 --concurrency 5 --budget-usd 15` | $0.71–0.99 per 10 tasks | Claude only. |
| Vals Finance Agent | `npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --all --reuse-from pilot --concurrency 8`, then `src/grade.ts --run-id main --samples 3` | est. about $1 to finish the 6 missing questions; about $13 for a full rerun | Claude answers, and Claude grades. |

These run without credit:
- `npm run controls`: the 23 control tests.
- `npm test` and `npm run smoke`: 179 unit tests and the smoke suites.
- `npx tsx scripts/smoke-receivables.ts`: the receivables flow end to end against a fake local Claude API.
- `AGENT_LLM=off npx tsx evals/external/invoice-sandbox/run.ts --system c --run-id <id>`: our system on Invoice Sandbox with Claude off (0/18; it checks the plumbing).
- `AGENT_LLM=off npm run eval -- --seed 7 --label claude-off`: our system with Claude off. On seed 7 it catches 13/13 errors and reads 43/64 invoices.
- Rescoring saved outputs:
  - Invoice Sandbox: `score.py` and `report.ts`, plus `run.ts --system b --offline`
  - DABstep: `score.py`
  - FinBalance: `analyze_finbalance.py`
  - Not Vals grading, which uses Claude as the judge.

## Spend so far

| Item | Cost | Tests our system? | Ledger (paths from repo root) |
|---|---|---|---|
| FinBalance | $26.78 | No | `../benchdata/finbalance/results/opus55_spend_ledger.jsonl` |
| Invoice Sandbox A and B | $13.53 | No | `../benchdata/invoice-sandbox/ledger.jsonl` |
| Vals Finance Agent | $13.11 | No | `var/evals/vals-finance-agent/ledger.jsonl` |
| Plain-Claude baseline (full run + pilot) | $8.29 | Comparison only | `var/evals/baseline-s7-*.json` |
| DABstep | $2.72 | No | `var/dabstep/ledger.jsonl` |
| Our system (5 Claude-on runs, 55 calls) | $0.65 | Yes | `var/evals/eval-*.json` |
| **Total** | **$65.08** | | |

These are list prices; billed amounts are on the Usage page of the Anthropic console.
- 99% ($64.43) paid for Claude working by itself; $0.65 paid for our system's own runs.
- Of that 99%, only the $8.29 baseline tells us anything about our system, because it ran on our world as the comparison.
- The other $56.14 bought scores for the model alone.

## Planned evals

1. **Held-out error types, run blind.** Someone who didn't write the agents adds new kinds of errors to the simulator. We run our system once with no code changes and publish the first-pass result before fixing anything. This answers the biggest weakness above. Cost is cents per run.
2. **Invoice Sandbox through our system (System C).** Built; needs credit.
   - Plan: three Claude-on runs on the original fixture plus one on the fresh seed, scored with the official scorer next to A and B.
   - The best it can do on accuracy is tie their 18/18. What it shows is whether our system works on documents we didn't create, and at what cost and number of calls.
   - Disclosure: the receivables agent was built after seeing A's and B's results on this fixture, and the trap categories are listed in the benchmark README.
3. **More head-to-head seeds.** Run two more seeds of our system against the plain agent, at about $8 each for the plain agent, to see whether 13 vs 12 holds.
4. **FinBalance through our kernel (low priority).**
   - How it would work: agents propose entries, and the kernel enforces balance and computes the balance sheet.
   - Expected gain is near zero. Opus 5.5 has no aggregation gap on FinBalance, and the forced ledger check added +0.0 points.
   - Its misses are in entry choice and citations, which a kernel doesn't fix.

## Reproduce

From the `autonomous-finance` repo root, with the local backend running (`npm run backend`):

```bash
npm run eval -- --stores 3 --days 14 --seed 7 --label claude-on      # our system
AGENT_LLM=off npm run eval -- --seed 7 --label claude-off            # our system, Claude off
npm run -s baseline -- --stores 3 --days 14 --seed 7 --limit-usd 25  # one plain Claude agent
npm run controls                                                     # control tests -> docs/evals/control-tests.json
npm test && npm run smoke
npx tsx evals/external/invoice-sandbox/run.ts --system c --run-id c-r1          # our system on Invoice Sandbox (needs credit)
AGENT_LLM=off npx tsx evals/external/invoice-sandbox/run.ts --system c --run-id c-off-r2   # same, Claude off
```

Results land in `var/evals/<runId>.json` and `.md`, which are gitignored. Outside benchmarks:
- [Invoice Sandbox](../../evals/external/invoice-sandbox/README.md)
- [FinBalance](../../evals/external/finbalance/README.md)
- [DABstep](../../evals/external/dabstep/README.md)
- [Vals Finance Agent](../../evals/external/vals-finance-agent/README.md)
