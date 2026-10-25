# Invoice Sandbox Benchmark: plain Claude agent vs agent-native pipeline

Run on 2026-10-24 with `claude-opus-5-5` only, against [ciru-ai/invoice-sandbox-benchmark](https://github.com/ciru-ai/invoice-sandbox-benchmark) at commit `b8cb58f`, scored with the benchmark's own `scripts/score_submission.py`. Machine-readable results: [`invoice-sandbox.json`](invoice-sandbox.json). Harness and reproduce commands: [`evals/external/invoice-sandbox/`](../../evals/external/invoice-sandbox/README.md).

**Coverage is incomplete.** The Anthropic API account ran out of credit ("credit balance is too low", HTTP 400) at 08:14 UTC, partway through the fresh-seed contamination check. Everything on the original fixture finished. On the fresh fixture, System A finished one run; System B finished only its extraction pass, and its adjudication step never ran. No further API calls were made after the failure was confirmed.

## Bottom line

- **Original fixture: both systems scored 18/18 on the official scorer in every run.** System A (plain agent) did it in 3 of 3 scored runs, plus an identical-config pilot. System B (pipeline) did it in 3 of 3. All four reported fields were exact for every customer (count, gross, credit, net), all 9 trap documents were handled correctly (6/6 `traps.json` entries), and there were 0 false exclusions. Scores did not vary between runs.
- **Fresh fixture (new seed, contamination check):** A scored 18/18 in its one run, so A's result holds on data that cannot have been memorized. B is **not measured** there: its partial output, with the 6 documents that need judgment held for review, scores 14/18. All 106 documents its rules settled match the answer key. The 6 held documents are the same kind of case its adjudicator counted in all 3 original runs: travel-line arithmetic invoices with the same invoice numbers. The adjudicator was not run here, so B's fresh result stays unknown.
- **This benchmark does not separate the two designs on accuracy.** Opus 5.5 saturates it. The differences that showed up are cost, wall time and reproducibility:
  - A was cheaper: $1.33 per run on average against $1.68 for B.
  - B was faster once its calls ran in parallel: 83–88 s against about 183 s.
  - B is deterministic in the arithmetic and leaves a per-document decision log. Its extractions were 137/142 byte-identical across two independent samples.

## Results

| Fixture | Run | System | Customers exact (official, net ±$0.01) | All 4 fields exact | Trap docs ok | Trap entries ok | False exclusions | Net abs error | Cost | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| original (seed 487291) | a-pilot (pilot, same config) | A | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.29 | 187 s |
| original (seed 487291) | a-r1 | A | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.30 | 171 s |
| original (seed 487291) | a-r2 | A | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.30 | 180 s |
| original (seed 487291) | a-r3 | A | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.40 | 196 s |
| original (seed 487291) | b-r1 | B | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.68 | 615 s* |
| original (seed 487291) | b-r2 | B | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.68 | 88 s |
| original (seed 487291) | b-r3 | B | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.67 | 83 s |
| fresh (seed 20261024) | a-f1 | A | 18/18 | 18/18 | 9/9 | 6/6 | 0 | $0.00 | $1.47 | 201 s |
| fresh (seed 20261024) | b-f1 (**partial**: no adjudication) | B | 14/18 | 14/18 | 9/9 | 6/6 | 6† | $237,836.81 | $1.55 | n/a |
| fresh (seed 20261024) | a-f2 | A | not run (no API credit) | | | | | | | |
| fresh (seed 20261024) | b-f2 | B | not run (no API credit) | | | | | | | |

\* b-r1 ran before the HTTP/1.1 transport fix (see Deviations), so its parallel calls were served one at a time. Its outputs are unaffected.
† These are the 6 line-arithmetic invoices that the pipeline held for review because the adjudicator was unavailable. They are not rule errors.

Variance, scored runs on the original fixture (n = 3 each):

| | System A | System B |
|---|---|---|
| Customers exact | 18, 18, 18 | 18, 18, 18 |
| Cost per run | $1.30–$1.40 (mean $1.33) | $1.67–$1.68 (mean $1.68) |
| Wall time | 171–196 s (mean 183 s) | 83–88 s (b-r2, b-r3); 615 s (b-r1, serialized) |
| API calls per run | 13 turns, 131–136 tool calls | 148 (142 extractions + 6 adjudications) |
| Output tokens per run | 23.5K–25.3K | 63.6K |

### Trap handling (every completed run, both systems)

| `traps.json` entry | Document(s) | Expected | A | B |
|---|---|---|---|---|
| duplicate_scan | `INV-2025-1013_duplicate_scan_from_email.pdf` | excluded | excluded | excluded (rule: same number as an unmarked copy) |
| superseded_original | `INV-2025-2101_original_superseded.pdf`, `INV-2025-2101_R1_revised.pdf` | original excluded, R1 counted | correct | correct (rule: R1 is the replacement) |
| void_invoice | `INV-2025-2199_VOID_do_not_pay.pdf` | excluded | excluded | excluded |
| credit_memos | `CM-2025-077_C001.pdf`, `CM-2025-091_C010.pdf` | subtracted, not counted as invoices | correct | correct |
| statements_are_not_invoices | `statement_C003_2025_Q3.pdf`, `statement_C007_2025_Q4.pdf` | excluded | excluded | excluded |
| bank_exports_are_payments | `bank_exports/deposits_2025_q4.csv` | listed, not spend | listed | listed |

Both systems also found the six invoices whose travel line has `qty x unit price != amount` (`EXP-TRAVEL`, invoice numbers 1017, 1034, 1051, 1068, 1085 and 1102). Both counted those invoices at their stated, internally consistent totals and flagged them for a human. In B this was the only work that reached the adjudicator: the rules settled the other 106 PDFs. The README's "email quotes a total without an invoice record" rule has **no instance in this fixture**, because every email refers to a PDF in the workspace, so neither system was tested on it.

## What each system is

Both systems got the same task text: the README's scoring contract and dataset rules, word for word. They also shared one output contract: per-customer count, gross, credit and net, plus a list of suspicious documents with a `treatment` field. Neither system ever saw `answer_key/` or `scripts/`.

- **A, plain generalist agent.** One Opus 5.5 agent at effort `high`, with `list_dir`, `read_file` and `submit_results`. `read_file` returns PDFs as pypdf-extracted text, 4,000 characters by default and up to 20,000, pageable. There was no code execution and no calculator, and the agent had at most 40 turns. In every run it read page 1 of all 112 PDFs, mostly in 1,300–2,000-character reads, sampled two appendices, and added the 105 totals in its own reasoning. The final turn produced 7.6K–9.9K output tokens. Its context peaked at 131K–158K tokens.
- **B, agent-native pipeline** (deterministic first, the model for judgment):
  1. Claude extracts each PDF and email into a strict zod schema with structured outputs, at effort `low`, 8 calls in parallel. The extraction input is the primary pages through the totals block, plus any later-page lines that match review keywords.
  2. Code then checks each extraction against the source text. Every amount must appear verbatim, the line items must sum to the subtotal, and subtotal − discount + tax must equal the total. The same code resolves customers through the CRM alias table, applies the README rules, and adds everything up in integer cents.
  3. Claude, at effort `high`, adjudicates only what the rules cannot settle.

  Extractions and adjudications are cached on disk per sample, so rerunning a sample costs nothing and each new `--sample` is an independent pass. All B runs needed 0 re-extractions and had 0 verification failures. About 76% of B's cost is output tokens, from transcribing line items into JSON.

## Fixture checks

- **Determinism (original seed).** The fixture was regenerated with Python 3.12.10, reportlab 5.1.0 and pillow 13.0.0. Against the committed copy:
  - `invoices.csv` and `customer_totals.csv` are byte-identical.
  - `traps.json` differs only in CRLF line endings; the committed copy was generated on Windows.
  - `manifest.json` differs only in `generated_at_utc`.
  - All 112 PDFs give identical pypdf text. Their bytes differ only in embedded timestamps.
  - The other 35 files are identical apart from CRLF, and the mbox differs only in its `From_` timestamp lines.

  So the committed answer key matches the generated fixture.
- **Fresh seed (contamination check).** The committed fixture and answer key are public, so a model could have seen them. `generate_fixture.py` has no seed option; `SEED = 487291` is a module constant. A 2-line patch makes it read `INVOICE_SANDBOX_SEED`, with the default unchanged; it is in `evals/external/invoice-sandbox/patches/seed-override.patch`. With the variable unset, the patched generator reproduces the committed answer key exactly.
  - Seed `20261024`, generated in a separate clone (`benchdata/invoice-sandbox-seed20261024`), has the same structure: 112 PDFs, 105 valid invoices, 2 credit memos, 5 excluded PDFs, 18 customers and the same trap file names.
  - The data does change. None of the 18 customer net totals is the same as in the original, only 2 of 112 invoice totals are the same, and the duplicate scan now belongs to C004.
  - The check therefore tests memorized numbers, not the trap layout, which is identical.

## Published results to compare against

No published result uses this benchmark the way we did. The closest ones:

- **Ciru Inference Lab, the benchmark's author, "Invoice Sandbox" (July 17, 2026)**: [benchmarks-mu.vercel.app/invoicesandbox](https://benchmarks-mu.vercel.app/invoicesandbox/), data in [ciru-ai/benchmarks `invoicesandbox/data/results.json`](https://github.com/ciru-ai/benchmarks). Same commit `b8cb58f`. Four local quantized open-weight models ran in the Pi coding harness, which has `bash`.

  | Model | Customer net exact | Invoice totals exact | Trap families | Note |
  |---|---|---|---|---|
  | HY3 IQ1_M | 18/18 | 105/105 | 6/6 | |
  | Ternary Bonsai 27B | 0/18 (strict) | | 5/6 | Wrote `IDC001` for `C001`; 16/18 after stripping the prefix; missed both credit memos |
  | HY3 iFP2 | 1/18 | 9/105 | 5/6 | A regex matched "Subtotal" |
  | Step 3.7 Flash | failed | | | No dashboard |

  **Not apples-to-apples.** The models and harness differ, and the harness had code execution. Their prompt was prescriptive ("Parse page 1 only; appendix pages are noise", plus which regexes to use) and also asked for an HTML dashboard. Their trap-family scoring is their own audit. The only shared ground is the strict per-customer net metric, where our A and B match their best run at 18/18.
- **Ciru, "Crown Citadel" local-AI report**: Qwen3.6 35B on a Strix Halo box. It avoided every exclusion trap but missed the credit-memo math on two records. It gives no per-customer score.
- **cadel.ai, "Can Coding Agents Do Accounting? Benchmarking Invoice Reconciliation" (July 8, 2026)**: [cadel.ai/us/blog/ai-agents-invoice-reconciliation-benchmark](https://cadel.ai/us/blog/ai-agents-invoice-reconciliation-benchmark). This uses a **different dataset**: 35 synthetic freight invoices matched against purchase orders, workbooks and tax e-invoices. It is not this benchmark and is not comparable. For reference, Claude Code with Opus 4.8 scored 93.9 overall there. No other cadel.ai post uses the invoice sandbox.
- **The GitHub repo itself** has 1 star, 0 forks and 0 issues or PRs. Other repos, such as hackathon reference lists, only link to it. One of them, `mit-bach/hackmit26`, says explicitly that it does not implement it.

## Deviations and caveats

**What the API calls were and what they cost**
- **Model and API settings.** Only `claude-opus-5-5` was used, through `client.beta.messages` (TypeScript SDK 1.3.0) with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"` on every call. Fallbacks were accepted and never triggered: all 668 calls were served by `claude-opus-5-5`, with no refusals and no `max_tokens` stops. Thinking was left at its adaptive default, no sampling parameters were sent, and tool choice was `auto`.
- **Costs are estimates**, computed from `usage` at list prices ($4/$20 per MTok, $0.20 cache read, $5 cache write). Total estimated spend was **$13.53** of the $25 budget, including a $0.20 B pilot on 10 documents and $0.01 of smoke tests.
- **Credit exhaustion.** The account's credit ran out although this harness had spent only about $13.53. The key may be shared with other sessions; the balance itself was not visible to me.
  - After the failure, one probe call confirmed the error (it failed, at no cost). Nothing was called after the stop instruction.
  - The partial b-f1 row was assembled with `--offline`: cached extractions only, under a $0 hard cap. The ledger shows no new calls.

**Changes made during the work**
- **HTTP/2 serialization.** Node 26's fetch uses HTTP/2, and concurrent POSTs over that shared connection were served one at a time. Six concurrent calls finished about 130 ms apart; over HTTP/1.1 they finished together. I moved the client to an HTTP/1.1 agent after b-r1. This changes wall time only. A's calls are sequential anyway.
- **B pilot fix.** The 10-document B pilot showed that 8 simultaneous first calls each paid a prompt-cache write. A warm-up gate now sends the first call alone. This is a cost fix only.

**How the systems and scoring were set up**
- **Extra scoring.** The official scorer reads only `customer_id` and `net_spend_usd`. Per-field exactness, trap handling and false exclusions come from my `score.py`, using criteria I set:
  - an excluded-type trap document must be listed as `excluded_from_spend`;
  - R1 must not be excluded;
  - credit memos must not be excluded, and the customer's credit total must match;
  - the bank CSV must be listed.
- **Not in the benchmark's requirements.** pypdf was added to the benchmark venv for local text extraction. The `treatment` field and the suspicious-document categories are part of our output contract, not the benchmark's.
- **What each system could see.** A's 4,000-character default read size is a harness choice; A could page further and chose short reads. B never sent Claude the appendix pages, except lines matching review keywords.
- **The A pilot** used the final configuration unchanged. It is shown in the table but excluded from the 3-run statistics.
- **Rule-tuning risk.** I read the generator and answer key before writing B's rules. The rules implement only the README rules plus generic arithmetic checks, and nothing keys off file names or IDs. Still, there is no held-out trap structure: the fresh seed changes the numbers, not the traps.

**How far the results reach**
- **Ceiling effect and small n.** The benchmark has one instance of each trap, and every trap document carries explicit status words. Both systems were at the ceiling. There were 3 runs per system on the original fixture and 1 (A only) on the fresh one.
- **No coding-agent baseline.** A had no code execution, as specified. A coding agent with bash or Python, the setup in Ciru's runs, was not tested.
- **Scale is not tested.** A's context grows by about 1.2K tokens per invoice read, while B's is constant per document. Nothing larger than this 112-PDF fixture was measured.

## Missing, and how to resume

These need API credit. Estimated total about $3.2.

```bash
export INVOICE_SANDBOX_DIR=../benchdata/invoice-sandbox-seed20261024
# Extractions are cached, so this re-runs only the 6 adjudications (~$0.11)
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-f1 --sample 1 --reuse-workspace
# These workspaces were created fresh and never touched
npx tsx evals/external/invoice-sandbox/run.ts --system a --run-id a-f2 --reuse-workspace
npx tsx evals/external/invoice-sandbox/run.ts --system b --run-id b-f2 --sample 2 --reuse-workspace
unset INVOICE_SANDBOX_DIR
npx tsx evals/external/invoice-sandbox/report.ts
```
