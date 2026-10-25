# Evaluation results

Status as of Oct 24, 2026, 7:30 PM PT. This is the record of every eval run so far, what each one actually tests, and what it cost.

- **Our system itself:** the simulated Sweetgreen finance team, the kernel control tests, and a head-to-head against one plain Claude agent on the same simulated world.
- **Claude by itself, none of our code:** the four outside benchmarks run so far (FinBalance, Invoice Sandbox, DABstep and Vals Finance Agent).
- **Going forward:** our system is evaluated on outside benchmarks through the eight-task APEX and DABstep comparison in [`docs/EXTERNAL_EVALS.md`](../EXTERNAL_EVALS.md) (#68). It runs our specialist team, one generalist agent and plain rules on the same tasks, with OpenAI or Anthropic models. Its paid run is waiting for budget approval (#67).
- **Credit:** the Anthropic key ran out at 08:14 UTC on Oct 24 (1:14 AM PT). Claude-dependent runs below are paused until it is topped up or replaced, or until they're pointed at OpenAI.

## Summary

| Eval | Tests our system? | Result | Comparison | Cost | Status | Source |
|---|---|---|---|---|---|---|
| Simulated world, seed 7 | Yes, full system | 13/13 errors, 3/3 decoys, 0 false alarms, 64/64 invoices, books exact | none (self-built) | $0.15 | done | [run](runs/eval-claude-on-hardened-s7-mvm2qxru.md) |
| Same, Claude off | Yes (ablation) | 13/13 errors, 3/3 decoys, 43/64 invoices | Claude on reads 21 more invoices | $0 | done | [run](runs/eval-regress-off-s7-mvmr5s8a.md) |
| Unseen seeds 11, 23, 42 | Yes | same as seed 7 on every seed | same as seed 7 | $0.12–0.13 each | done | [11](runs/eval-unseen-s11-mvm3xv56.md), [23](runs/eval-unseen-s23-mvm3zmlb.md), [42](runs/eval-unseen-s42-mvm41ecs.md) |
| Control tests | Yes, kernel + memory | 20/20 hold on current main plus #72 | none | $0 | done | [control-tests.json](control-tests.json) (added by #72) |
| Spreadsheet tools vs kernel, part A (no model) | Yes, kernel vs an .xlsx workbook | 1 vs 5.78 tool calls per operation; 0.12 vs 1.12 ms median in memory, 7.67 ms saving the file; bad operations stopped 18/18 vs 0/18 (workbook checks flagged 8 afterwards) | same stream, same 18 bad operations | $0 | done | [spreadsheet-vs-kernel.md](spreadsheet-vs-kernel.md) |
| Spreadsheet tools vs kernel, part B (agent in the loop) | Yes, same model, two tool sets | not run yet | | est. ~$1.67, hard cap `--confirm-usd` | built, not yet run | `npm run eval:sheets-agent -- --dry-run` |
| Head-to-head | Yes, vs plain Claude | ours 13/13 and 3/3; plain Claude 12/13 and 2/3 (one decoy was unfair to it, see below) | $0.15 vs $7.80; 87 s vs 42 min | $7.80 | done, 1 seed | [run](runs/baseline-s7-mvm30964.md) |
| Eight-task APEX + DABstep (#68) | Yes: full team vs generalist vs rules | not run yet | published APEX best about 56% | capped by an approved budget | waiting on #67 | [EXTERNAL_EVALS.md](../EXTERNAL_EVALS.md) |
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

\* Rerun on the #51 branch on Oct 24, and again on current main plus #72 (13/13, 3/3, 0 kernel blocks for honest agents). It matches the earlier Claude-off run on merged main exactly ([run](runs/eval-main-merged-s7-mvm1gfos.md)). A Claude-on run made before the evidence hardening scored the same as the hardened run: 13/13, 64/64, $0.14 ([run](runs/eval-claude-on-s7-mvm2g0ta.md)).

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

[`scripts/control-tests.ts`](../../scripts/control-tests.ts), added by #72, runs 20 scripted cases against the live kernel and the git memory store, without Claude. On current main plus #72: **20/20 hold** ([control-tests.json](control-tests.json)). These are scripted cases, not an AI attacker.

- **Must be refused (16):**
  - a bill with no document; one document backing two bills
  - cash posted with no bank evidence; the AP clerk posting cash
  - approving your own payment; paying a bill twice; a payment of $50k or more with no human approval
  - an agent hiring a control-role seat; closing a period without a human signature
  - a direct bank-detail change in memory; merging your own change; an unauthorized merge
  - booking a bank transaction twice; a cash amount that differs from the bank's; re-booking a bank transaction after a double reversal
  - posting an entry label only the kernel may use
  - answering your own question to the human
- **Integrity check (1):** the ledger hash chain verifies.
- **Legitimate path still works (3):** a real bank transaction can be booked; a cash entry can be corrected by reversal; a bank transaction released by a reversal can be booked again.

History:
- The first version (16 cases, in #51) found 4 controls that didn't hold: bills without a source document, cash without bank evidence (#4), no correction of cash by reversal (#5), and payments to unregistered vendors.
- The first three are fixed in #72.
- The fourth, payee checks, now lives in the scoped payment module (#49, #61), so its registry cases were dropped from this suite.
- #72 also fixes the reversal-chain hole JJ found in review.

### Spreadsheet tools vs the kernel

Most AI-for-finance tools give the agent a spreadsheet. This asks what our typed kernel buys over that, for the same agent on the same work. Code: [`src/evals/spreadsheet/`](../../src/evals/spreadsheet/).

**Part A, deterministic benchmark (done, $0).** One seeded world (seed 7, 3 stores, 14 days: 230 events, 156 bookkeeping operations) is applied two ways:
- through the kernel's real mutation handlers (record bill, resolve held bill, post entry, match bank transaction), in process against `tests/helpers/kernelHarness.ts`
- through a real .xlsx workbook (exceljs) laid out like a finance team's: Ledger, AP register, Bank, a SUMIFS trial balance and a Checks sheet with five reconciliations; the agent's only tools are `read_range`, `write_range`, `find_rows` and `recalc` (recalculate and save)

Both end with identical books on the clean stream. Then 18 bad operations are injected into fresh copies of each. Results from `npm run eval:sheets-bench` (10 trials after 2 warm-ups, Apple M5 Pro, Node 26.5) are in [spreadsheet-vs-kernel.md](spreadsheet-vs-kernel.md) and [.json](spreadsheet-vs-kernel.json):

| | Kernel | Spreadsheet |
|---|---|---|
| Tool calls per operation | 1 | 5.78 (record bill 6.88, match bank 6, post entry 4) |
| Median / p95 per operation, in memory | 0.12 / 0.16 ms | 1.12 / 2.23 ms |
| Median / p95 per operation, saving the file each time | (no durable commit measured) | 7.67 / 13.5 ms |
| Per operation, first tenth vs last tenth of the stream | 0.12 vs 0.12 ms | 0.20 vs 2.23 ms in memory; 2.62 vs 13.3 ms saved |
| Bad operations stopped before they landed | 16 of 18 refused or absorbed; the other 2 (direct edits) caught by the hash chain | 0 of 18; checks flagged 8 afterwards, 10 left no trace |

What this shows:
- The pace difference for an agent is mostly tool calls: almost 6 per operation instead of 1, and each is a model or network round trip. The in-process milliseconds are small on both sides.
- Spreadsheet operations get slower as the books grow (whole-ledger SUMIFS, whole-file saves); kernel operations don't.
- The kernel refused every unbalanced, duplicate, unauthorized, unevidenced and closed-period write. The workbook took them all. Its reconciliations caught the ones that move totals (unbalanced entries, a bad account, cash that doesn't match the bank, an exact duplicate). They missed what doesn't move a total: fractional cents, closed periods, a duplicate typed differently, bad line math, no source document, approval limits, self-approval, a retried posting and an edited sales entry.

Weaknesses:
- The kernel ran against an in-memory DB double with no durable commit, while the saved spreadsheet column writes a file every time. Compare compute with the in-memory column. A live Convex deployment was out of scope.
- We wrote the spreadsheet's formula evaluator (exceljs has none), and amounts are integer cents in both paths. Both choices favor the spreadsheet.
- The bad operations are ours, chosen to cover the kernel's invariants, so 18/18 is by construction; the informative number is how many the workbook misses.
- One machine and one seed. Part A has no model, so it says nothing about judgment.

**Part B, agent in the loop (built, not yet run).** The same model processes the same slice (seed 7, 1 store, 2 days: 11 tasks, 4 planted errors) with either the kernel tools (`record_bill`, `post_entry`, `match_bank_transaction`, `flag_exception`) or the four spreadsheet tools, with identical business instructions. It records tool calls, refused calls, model turns, tokens, wall time and cost, and scores both end states with `evaluateBooks` from `src/evals/books.ts` (the books oracle `score.ts` uses) plus the planted-error answer key. Calls go through `src/agents/llm.ts` `runTools`, so `BudgetedModelClient` and the local spend cap apply. The harness runs only on the OpenAI path because its cost estimate is priced for it.

```bash
npm run eval:sheets-agent -- --dry-run            # plan and cost estimate, no calls
npm run eval:sheets-agent -- --agent scripted     # $0 reference run without a model
npm run eval:sheets-agent -- --confirm-usd 5      # paid run; needs OPENAI_API_KEY and budget approval
```

Cost estimate from the dry run (GPT-6.1 Sol at $2 / $10 per million input / output tokens, effort medium, 16 turns max per task): about 22 requests and $0.32 for the kernel tools, about 70 requests and $1.35 for the spreadsheet tools, **about $1.67 in total**. That assumes one tool call per turn, 800 output tokens per turn and no caching. If every task hit the 16-turn cap at maximum output it would be about $86, which is why a paid run requires `--confirm-usd`: the harness sets the local spend cap to the recorded spend plus that amount, and the client refuses any request whose worst-case reservation would exceed it. The scripted reference run books every operation with no judgment: 9 kernel calls vs 53 spreadsheet calls, 0 of 4 planted errors caught either way.

### Head-to-head: our system vs one plain Claude agent

Both systems ran on the same world (seed 7), with the same data, the same kernel underneath and the same scorer. The baseline is one Claude Opus 5.5 agent at effort medium. Its code is `src/evals/baseline.ts` at commit `3ef9c92` on branch `evals-and-hardening`, and isn't on main; #68 now runs the same kind of comparison on outside benchmarks. It judges every event itself and has no specialized seats, rules or learned parsers.

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
- **Blocked a legitimate change:** it blocked a genuine change to a vendor's bank details, which our system verified by calling the number on file and then approved. **This decoy was unfair to the baseline.** JJ's review of #51 found that none of its tools could create the vendor proposal the scorer looks for. So its 2/3 on decoys isn't a real loss, and the accuracy gap comes down to the one missed duplicate.
- **Kernel refusals:** the kernel refused 3 of its payroll postings, because the payroll seat may not post to account 6000 (General & Administrative).
- **Payroll books aren't comparable:** the credit ran out near the end, and 4 of its 160 events failed (3 payroll registers on Jan 14 and 1 Uber Eats payout report).
- **How far it reaches:** one seed, one run each. 13 vs 12 is a single error. The solid differences are cost (about 50×) and time (about 29×).

A 1-store, 2-day pilot of the same baseline caught 3 of 4 errors for $0.49 in 207 s ([run](runs/baseline-s7-mvm2v6gk.md)).

### Invoice Sandbox through our system (System C): parked

#51 added receivables (an AR clerk, a receivables kernel and parser learning for customer documents) and an adapter that runs our team on Invoice Sandbox. It was checked end to end:
- with Claude off: 0/18, because nothing can read the PDFs without Claude, but all 148 documents were accounted for
- against a fake local Claude API: 17/17 checks

It never had a paid run. The invoice work now lives in #63, a separate invoice workspace in the console, so System C isn't on main. The code stays on branch `evals-and-hardening`, commit `951b2df`, in case we want to score #63 or the team on Invoice Sandbox later.

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

Our application agents call Claude (`ANTHROPIC_API_KEY`). The eight-task external eval (#68) can use OpenAI or Anthropic models (`OPENAI_API_KEY`), but only under an approved budget file. Keys go in the gitignored `.env.local`; never commit them. Costs are measured at list prices unless marked "est."

| Run | Command (repo root) | Cost per run | Why it needs a model |
|---|---|---|---|
| Our system, simulated world | `npm run eval -- --seed 7 --label x` | $0.12–0.15 (Claude) | Reads invoice formats the code doesn't know and writes parsers for them (11 calls). Without a model, 21 of 64 invoices go unread. |
| Eight-task APEX + DABstep (#68) | `npm run bench:run` with an approved policy file (see [EXTERNAL_EVALS.md](../EXTERNAL_EVALS.md)) | capped by the approved `maxCostUsd` | The full team and the generalist both need a model. `--modes rules-only --judge off` is free. |
| Spreadsheet tools vs kernel, part B | `npm run eval:sheets-agent -- --confirm-usd 5` | est. ~$1.67, capped by `--confirm-usd` | The comparison is about how a model works with each tool set. OpenAI only, because the cost estimate is priced for that path. |
| Live demo, and "why" answers in the console | `npm run agents`, `npm run gateway` | not measured | Same document reading as above. Each "why" question is one short tool loop. |
| Invoice Sandbox A or B | `npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id <id>` (or `--system b ... --sample <n>`) | A $1.29–1.47, B $1.55–1.68 | Claude only. Finishing the stopped fresh-seed runs: about $3.20. |
| FinBalance | see its [harness README](../../evals/external/finbalance/README.md) | $12.54 per 178 records | Claude only. |
| Invoice Sandbox + FinBalance through our system (opt-in) | `npm run bench:run -- --tasks finbalance,invoice-sandbox` with an approved policy file (see [EXTERNAL_EVALS.md](../EXTERNAL_EVALS.md#opt-in-cases-invoice-sandbox-and-finbalance)) | est. $2–5 per repeat of all 7 cases (not measured) | Full team and generalist need a model; rules-only is free. |
| DABstep dev × 3 | `npx tsx evals/external/dabstep/run.ts --label dev-x3 --runs 3 --concurrency 5 --budget-usd 15` | $0.71–0.99 per 10 tasks | Claude only. |
| Vals Finance Agent | `npx tsx evals/external/vals-finance-agent/src/run.ts --run-id main --all --reuse-from pilot --concurrency 8`, then `src/grade.ts --run-id main --samples 3` | est. about $1 to finish the 6 missing questions; about $13 for a full rerun | Claude answers and Claude grades. Set `SEC_USER_AGENT="name email"` first. |

These run without credit:
- `npm run controls`: the 20 control tests (with #72).
- `npm test`: the unit tests (558 on main with #72). The `scripts/smoke-*.ts` suites need the local backend.
- `npm run eval:sheets-bench`: spreadsheet tools vs kernel, part A (about 25 s).
- `npm run eval:sheets-agent -- --dry-run` and `-- --agent scripted`: part B's plan, estimate and model-free reference run.
- `AGENT_LLM=off npm run eval -- --seed 7 --label claude-off`: our system with Claude off. On seed 7 it catches 13/13 errors and reads 43/64 invoices.
- `npm run bench:run -- --modes rules-only --repeats 1 --judge off`: the rules-only row of the eight-task eval. Add `--tasks finbalance,invoice-sandbox` for the opt-in cases (after `npm run bench:prepare -- --batch extra`).
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

1. **The eight-task APEX + DABstep comparison (#68),** once #67's budget is approved. It's the first outside benchmark that runs our actual team, so it's the most useful next number. APEX also has published scores to compare against.
2. **Held-out error types, run blind.** Someone who didn't write the agents adds new kinds of errors to the simulator. We run our system once with no code changes and publish the first-pass result before fixing anything. Cost is cents per run.
3. **More head-to-head seeds,** with the baseline given a way to approve a legitimate bank change. That shows whether the single missed duplicate is a pattern.
4. **Invoice Sandbox and FinBalance through our system: adapters built, not yet run.** These are seven opt-in cases in the same external framework ([EXTERNAL_EVALS.md](../EXTERNAL_EVALS.md#opt-in-cases-invoice-sandbox-and-finbalance)): one Invoice Sandbox case and six FinBalance records (four standard, two contradictions). Each runs as full team vs generalist vs rules. In full-team FinBalance, the controller's entries are booked through the ledger kernel, and the balance sheet comes from the kernel's trial balance, not the model. Scoring uses each benchmark's own metric, ported and checked against the saved runs above: 0 differences on 218 FinBalance responses and 8 Invoice Sandbox runs.
   - **Free rules-only run:** 7/7. Treat it as a harness check, not a baseline: the rules were written by someone who had seen these records' keys while picking them.
   - **Model runs:** not done; waiting on budget. Estimated $2–5 for one repeat (ceiling $40.48), $5–17 for three (ceiling $121.44).
   - **Expected gain:** still small for FinBalance. Opus 5.5 has no aggregation gap there, and its misses are entry choice and citations, which a kernel doesn't fix. These are also low-difficulty records.
   - **Supersedes System C:** this replaces the parked System C idea; the old branch `evals-and-hardening` is untouched.

## Reproduce

From the `autonomous-finance` repo root, with the local backend running (`npm run backend`):

```bash
npm run eval -- --stores 3 --days 14 --seed 7 --label claude-on      # our system
AGENT_LLM=off npm run eval -- --seed 7 --label claude-off            # our system, Claude off
npm run controls                                                     # control tests -> docs/evals/control-tests.json (#72)
npm test
npm run bench:run -- --dry-run                                       # eight-task external eval (#68); see docs/EXTERNAL_EVALS.md
npm run eval:sheets-bench                                            # spreadsheet vs kernel, part A (no backend needed)
npm run eval:sheets-agent -- --dry-run                               # spreadsheet vs kernel, part B plan and cost estimate
```

Results land in `var/evals/<runId>.json` and `.md`, which are gitignored. Outside benchmarks:
- [Invoice Sandbox](../../evals/external/invoice-sandbox/README.md)
- [FinBalance](../../evals/external/finbalance/README.md)
- [DABstep](../../evals/external/dabstep/README.md)
- [Vals Finance Agent](../../evals/external/vals-finance-agent/README.md)
