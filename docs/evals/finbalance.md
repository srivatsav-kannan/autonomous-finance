# FinBalance: Claude Opus 5.5

FinBalance ([arXiv 2606.15949](https://arxiv.org/abs/2606.15949), EMNLP 2026 Findings) gives a model a bundle
of OCR'd source documents for one reporting period: invoices, bank statements, payment advices, schedules,
contracts, tax notices, and distractors. The model must return balanced journal entries with supporting
document IDs (`doc_refs`), the closing balance sheet, and an inconsistency flag plus code when the
documents contradict each other. We ran `claude-opus-5-5` through the authors' harness
([github.com/Devansh1105/finbalance](https://github.com/Devansh1105/finbalance) at `a1062b7b`). The prompt,
parser and scorer were unmodified, and every number below comes from real API calls made on 2026-10-24.

Raw metrics: [`finbalance.json`](finbalance.json). Runner, adapter and exact commands:
[`evals/external/finbalance/`](../../evals/external/finbalance/README.md).

## Summary

- **The balance sheet is right 69.2% of the time [95% CI 60.7, 77.3]** on 120 standard records from the
  official 710-record split. The best model in the paper, GPT-5, scores 46.5% on all 480 standard records,
  below our CI's lower bound.
- **Opus 5.5 has no aggregation gap.** Replaying its own journal entries gives exactly the same score
  (BS_recon 69.2%), record for record. Its reported balance sheet equals the replay of its entries on 118 of
  120 records. In the paper, four of six models lose 26 to 41 pp between those two numbers.
- **Citing the right documents is still the bottleneck.** Accounts and amounts are right for 84.5% of
  expected postings, but 46.6% of expected postings cite a different document set than the label. Only 6.7%
  of records are fully correct end to end (paper panel: 0 to 6%).
- **Contradiction detection is near ceiling.** All 58 negative controls were flagged. 56 of 58 got exactly
  the right code (96.5%). False alarms hit 2 of 120 clean records, and both trace to a labelling artifact
  in the data.
- **The ledger-feedback ablation has nothing to fix.** On 40 paired records, BS_exact changed by +0.0 pp
  [−9.1, +9.1]. All 32 first drafts already replayed to their own balance sheet, so the verifier reported
  no deltas. The paper reports +30 to +33 pp for its three models that have the gap.
- **Contamination check:** a split that has never been published (generated here, seed 20261024) scores
  66.7% [48.4, 82.9]. The authors' post-cutoff split scores 70.0% [58.2, 80.7]. Both are in line with
  the official split, so training-data exposure is not what drives the score.
- **Cost:** $26.78 for all 354 records (394 calls), including the pilot, ablation and contamination checks.
  The 178-record official-split run cost $12.54 ($0.070 per record) and took 10.0 minutes at concurrency 4.

## Comparison with the paper's six models

Our row: 120 standard and 58 negative-control records from the official `data/main` split, one run, 95%
percentile-bootstrap CIs over records. Paper rows: all 710 records (480 standard, 230 negative).
BS_exact, BS_recon, gap and entry ratio come from Table 5 of the paper. The other columns are the
integers printed in Figure 2. Higher is better everywhere except gap.

| Model | Records | BS_exact | BS_recon | Gap (pp) | Entries correct | Strict end-to-end | Citations correct | Contradiction code | Entry ratio |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Claude Opus 5.5** (ours, 95% CI) | 120 std + 58 neg | **69.2** [60.7, 77.3] | **69.2** [60.7, 77.3] | **0.0** [0.0, 0.0] | **60.8** [51.7, 69.5] | **6.7** [2.5, 11.4] | 53.4 [50.2, 56.6] | **96.5** [91.1, 100.0] | 0.93 |
| GPT-5 (reasoning low) | 480 std + 230 neg | 46.5 | 46.3 | −0.2 | 40 | 5 | 52 | 43 | 0.91 |
| Grok-4.3 (reasoning) | 480 std + 230 neg | 31.0 | 35.0 | +4.0 | 26 | 5 | 84 | 96 | 0.40 |
| Gemini 3 Flash | 480 std + 230 neg | 23.5 | 54.8 | +31.3 | 49 | 6 | 48 | 82 | 0.94 |
| DeepSeek Chat | 480 std + 230 neg | 6.7 | 47.3 | +40.6 | 45 | 2 | 70 | 60 | 0.98 |
| Claude Haiku 4.5 | 480 std + 230 neg | 2.9 | 29.2 | +26.3 | 27 | 1 | 83 | 67 | 0.53 |
| Qwen3 235B | 480 std + 230 neg | 1.3 | 30.2 | +29.0 | 25 | 0 | 71 | 84 | 0.94 |

The columns, using the upstream metric names:

- **BS_exact** (`final_balance_sheet_matches`): the reported balance sheet matches the label to the cent.
- **BS_recon** (`predicted_entries_reconstruct_correct_final_balance_sheet`): the model's own entries,
  replayed through the ledger, produce the labelled balance sheet.
- **Entries correct** (`final_journal_entries_match_no_doc_refs`): every posting matches on accounts and
  amount, ignoring citations.
- **Strict end-to-end**: balance sheet, entries and citations all match.
- **Citations correct**: 1 − (postings with the right accounts and amount but the wrong `doc_refs`) ÷
  (all expected postings). This is the per-posting definition the paper's plotting code uses.
- **Contradiction code** (`inconsistency_code_matches`): the flag is set and the code set equals the label.
- **Entry ratio**: predicted postings ÷ expected postings.

The camera-ready appendix in the repo also reports a reasoning model outside the six-model panel.
DeepSeek Reasoner scored 44.0% BS_exact with a 4.8 pp gap on all 710 records, while raising false alarms
to 29%.

## What the numbers show

**Aggregation is solved; grounding is not.** FinBalance's central finding is the gap between BS_recon
and BS_exact. Models write plausible entries and then report a balance sheet that does not follow from
them. Opus 5.5 with adaptive thinking shows no gap at all: BS_exact and BS_recon disagree on 0 of 120
records. Like GPT-5, its failures happen at the entry level: wrong decompositions, omissions, and
amounts. Ten records reach the right balance sheet even though some postings differ from the
generator's decomposition, for example split versus combined postings that net to the same balances.
That is why BS_exact (69.2%) is higher than entries correct (60.8%).

**Citations.** Of the 877 postings with the right accounts and amount but the wrong `doc_refs`:

- 453 (52%) cite every expected document plus extras. 622 of the 660 extra citations are the bank
  statement, added as support for cash postings.
- 235 (27%) leave out an expected document, usually the invoice a payment settles.
- 189 (22%) overlap only partly.

Counted against postings with the right accounts and amount, the mismatch rate is 55.2% [51.8, 58.6].
That is the base the paper's README uses for its "52% cite the wrong documents" figure (Gemini 3 Flash,
compact split). If a strict superset of the expected documents also counts as correct (the paper's
citation-sensitivity score), strict end-to-end rises from 6.7% to 17.5% [10.9, 24.6]. The paper reports
15.8% for GPT-5 and 8.8% for Gemini on that score.

**Inconsistency detection and grounding:**

| Metric | Value [95% CI] |
|---|---:|
| Flag detection on negatives (`has_inconsistency=true`) | 100.0 [100.0, 100.0] |
| Correct code on negatives (contradiction code) | 96.5 [91.1, 100.0] |
| Flag + code + empty entries and balance sheet | 100.0 [100.0, 100.0] |
| False alarm on standard records | 1.7 [0.0, 4.3] |
| Strict end-to-end, superset doc_refs accepted (citation-sensitivity score) | 17.5 [10.9, 24.6] |
| Doc-ref mismatch per expected posting (Figure 2 definition) | 46.6 [43.4, 49.8] |
| Doc-ref mismatch among postings with correct accounts and amount | 55.2 [51.8, 58.6] |
| Expected postings matched exactly (accounts, amount, doc_refs) | 37.9 [33.8, 42.0] |
| Expected postings matched on accounts and amount | 84.5 [79.5, 89.0] |
| Parse success (all records) | 100.0 [100.0, 100.0] |

Both code misses are `input_tax_mismatch` records. The model listed the right code plus
`tax_total_mismatch` and/or `tax_rate_mismatch`, and the scorer requires an exact code set. That is also
the hardest code in the paper: only 23% of the panel's attempts detected it. All 21 other codes were
detected with the right code on every sampled record.

### By difficulty level (standard records, official split)

| Level | n | BS_exact [95% CI] | BS_recon [95% CI] | Gap (pp) | Strict | Entries correct | Citations correct | Entry ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 24 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | +0.0 | 33.3 | 95.8 | 69.8 | 1.01 |
| 2 | 24 | 66.7 [45.8, 83.3] | 66.7 [45.8, 83.3] | +0.0 | 0.0 | 62.5 | 60.1 | 0.92 |
| 3 | 24 | 62.5 [41.7, 79.2] | 62.5 [41.7, 79.2] | +0.0 | 0.0 | 54.2 | 52.0 | 0.94 |
| 4 | 24 | 62.5 [41.7, 79.2] | 62.5 [41.7, 79.2] | +0.0 | 0.0 | 45.8 | 52.3 | 0.92 |
| 5 | 24 | 54.2 [33.3, 75.0] | 54.2 [33.3, 75.0] | +0.0 | 0.0 | 45.8 | 49.2 | 0.92 |

Paper context: for the anchor model, Gemini 3 Flash, the paper reports BS_exact falling from 0.95 at L1
to 0.02 at L5, with the gap peaking near 46 pp at L3 (v1, Section 6). On the compact split it falls from
88% to 0%. Opus 5.5 degrades much more gently (100% to 54%) and has no gap at any level. All eight strict
end-to-end successes are L1 records.

### By period type and industry (standard records)

| Period | n | BS_exact [95% CI] | Strict | Entries correct | Citations correct |
|---|---:|---:|---:|---:|---:|
| month | 40 | 80.0 [67.5, 92.5] | 7.5 | 70.0 | 46.5 |
| quarter | 40 | 60.0 [45.0, 75.0] | 7.5 | 55.0 | 56.5 |
| year | 40 | 67.5 [52.5, 80.0] | 5.0 | 57.5 | 55.3 |

| Industry | n | BS_exact [95% CI] | Strict | Entries correct | Citations correct |
|---|---:|---:|---:|---:|---:|
| healthcare_clinic | 15 | 100.0 [100.0, 100.0] | 20.0 | 100.0 | 70.2 |
| property_management | 15 | 100.0 [100.0, 100.0] | 20.0 | 100.0 | 50.2 |
| professional_services | 15 | 80.0 [60.0, 100.0] | 0.0 | 53.3 | 49.0 |
| wholesale_distribution | 15 | 73.3 [46.7, 93.3] | 13.3 | 73.3 | 49.1 |
| field_services | 15 | 66.7 [40.0, 86.7] | 0.0 | 66.7 | 52.5 |
| subscription_saas | 15 | 53.3 [26.7, 80.0] | 0.0 | 33.3 | 53.7 |
| manufacturing | 15 | 40.0 [13.3, 66.7] | 0.0 | 40.0 | 38.3 |
| retail | 15 | 40.0 [20.0, 66.7] | 0.0 | 20.0 | 64.2 |

The paper ranks industries the same way: property management and healthcare are easiest, and retail and
manufacturing hardest, in BS_recon across its panel (Figure 14).

### Error taxonomy vs. the paper (share of standard records affected, %)

| Model | Doc linking | Balance reconstruction | Omission | Extra entry | Code failure (negatives) | Account selection | Arithmetic |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Claude Opus 5.5** | 91.7 | 30.8 | 36.7 | 21.7 | 3.4 | 8.3 | 28.3 |
| GPT-5 | 93 | 54 | 57 | 37 | 57 | 13 | 32 |
| Grok-4.3 | 50 | 65 | 70 | 21 | 4 | 8 | 7 |
| Gemini 3 Flash | 93 | 45 | 48 | 32 | 18 | 12 | 27 |
| DeepSeek Chat | 92 | 53 | 45 | 43 | 40 | 28 | 18 |
| Claude Haiku 4.5 | 58 | 71 | 63 | 30 | 33 | 20 | 8 |
| Qwen3 235B | 89 | 70 | 63 | 54 | 16 | 37 | 12 |

Paper values are the printed cells of Figure 14 (arXiv v1, page 18). Ours come from the upstream
`error_taxonomy` summary.

## Ledger-feedback ablation

`forced_ledger_verifier` is the upstream condition the paper uses. The model drafts an answer. The
harness replays the draft's entries and returns the replayed balance sheet with per-account deltas
against the reported one; it gives no ground truth. The model then gets one revision turn. We ran it on
40 records from the official sample: 32 standard records spread over L1 to L5, and 8 negatives. The
baseline is the independent baseline run on the same records, and the CIs are the upstream paired
bootstrap (`analyze_ablation_bootstrap`, 5,000 resamples).

| Metric | Baseline | Ledger feedback | Delta (pp) [95% paired CI] |
|---|---:|---:|---:|
| BS_recon | 68.8 | 68.8 | +0.0 [−9.1, +9.4] |
| BS_exact | 68.8 | 68.8 | +0.0 [−9.1, +9.1] |
| Entries correct (no doc_refs) | 59.4 | 62.5 | +3.1 [+0.0, +10.0] |
| Strict end-to-end | 9.4 | 9.4 | +0.0 [+0.0, +0.0] |
| Contradiction code (8 negatives) | 100.0 | 100.0 | +0.0 [+0.0, +0.0] |
| Doc-ref mismatch per expected posting | 49.1 | 49.3 | +0.2 [−1.1, +1.5] |

All 32 standard drafts already replayed to their own reported balance sheet, so the verifier returned zero
deltas, and no final balance sheet changed from its draft. One record flipped in each direction against
the independent baseline. That is run-to-run sampling noise, not a feedback effect, and it is a useful
estimate of how unstable single records are: 2 of 32. All 8 negative drafts were flagged on the first
pass, so the mechanism behind the paper's detection loss never applied. That loss comes from feedback on
drafts that missed a contradiction.

The paper's Figure 3 (compact split, n=143) shows +32, +30 and +31 pp BS_exact for Gemini 3 Flash,
Qwen3 235B and Claude Haiku 4.5, with contradiction-code losses of −13, −17 and −52 pp. It omits GPT-5
and Grok-4.3 because those models lack the gap. Opus 5.5 behaves like GPT-5 here, with even less
internal inconsistency.

## Contamination check

The official splits were committed to the repo in May 2026 and released with the June 2026 preprint.
Opus 5.5's knowledge cutoff is June 2026, so the model could have seen `data/main`, labels included. We
therefore scored two splits it cannot have seen in training, with identical harness settings:

- The authors' second 710-record split (`data/fresh_seed_20260712`, seed 20260712). It was first
  committed on 2026-08-28, after the cutoff.
- A brand-new 710-record split generated for this run with the repo's own generator:
  `scripts/generate_standard_datasets.py --seed 20261024 --records-per-combo 4 --negative-controls-per-code 10`.
  It uses the same construction as `data/main` and was never published. It passes the upstream structural
  audit 710/710, and rerunning the command reproduces identical records.

Each check sample uses the same stratified sampler, with balanced difficulty and period, and about 32%
negatives.

| Split | Records |
|---|---|
| Official main sample | 120 std + 58 neg |
| Authors' fresh seed 20260712 | 60 std + 29 neg |
| New seed 20261024 (generated here) | 30 std + 14 neg |

| Metric (95% CI) | Official main | Fresh seed 20260712 | New seed 20261024 |
|---|---:|---:|---:|
| BS_exact | 69.2 [60.7, 77.3] | 70.0 [58.2, 80.7] | 66.7 [48.4, 82.9] |
| BS_recon | 69.2 [60.7, 77.3] | 70.0 [58.2, 80.7] | 66.7 [48.4, 82.9] |
| Gap (pp) | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| Entries correct (no doc_refs) | 60.8 [51.7, 69.5] | 65.0 [52.6, 76.2] | 63.3 [44.8, 80.0] |
| Strict end-to-end | 6.7 [2.5, 11.4] | 6.7 [1.5, 13.8] | 10.0 [0.0, 21.9] |
| Citations correct | 53.4 [50.2, 56.6] | 50.3 [46.3, 54.3] | 54.7 [48.0, 61.6] |
| Flag detection (negatives) | 100.0 | 100.0 | 100.0 |
| Contradiction code | 96.5 [91.1, 100.0] | 100.0 [100.0, 100.0] | 92.9 [76.9, 100.0] |
| False alarm (standard) | 1.7 [0.0, 4.3] | 0.0 | 0.0 |
| Parse success | 100.0 | 100.0 | 100.0 |

| Difference vs. official main (pp) [95% CI, unpaired bootstrap] | Fresh seed 20260712 | New seed 20261024 |
|---|---:|---:|
| BS_exact | +0.8 [−14.1, +14.6] | −2.5 [−22.1, +16.0] |
| Strict end-to-end | +0.0 [−7.4, +8.0] | +3.3 [−7.0, +15.4] |
| Citations correct | −3.1 [−8.1, +2.1] | +1.3 [−6.2, +8.7] |
| Contradiction code | +3.5 [+0.0, +8.8] | −3.7 [−20.4, +7.4] |

The unseen splits score within a few points of the official one, and every difference is well inside
its CI. On BS_exact, a contamination effect larger than about 15 to 20 pp is ruled out. Smaller effects
cannot be excluded at these sample sizes. Both unseen splits keep the zero gap and the low strict score.
The one code miss on the new split is again an `input_tax_mismatch` record answered with extra tax codes.

## Cost and wall time

Opus 5.5 list prices: $4 per M input tokens, $20 per M output tokens (thinking included), $0.20 per M
cache reads, $5 per M cache writes.

| Run | Records | Calls | Input tok | Cache read / write | Output tok | Cost (USD) | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Pilot (L1, L3, L5) | 3 | 3 | 32,124 | 0 / 0 | 8,560 | 0.30 | 50 s |
| Official main sample, baseline | 178 | 178 | 1,677,498 | 0 / 0 | 291,748 | 12.54 | 597 s |
| Ledger-feedback ablation | 40 | 80 | 61,638 | 352,267 / 352,267 | 113,297 | 4.34 | 228 s |
| Fresh seed 20260712 | 89 | 89 | 860,553 | 0 / 0 | 147,590 | 6.39 | 301 s |
| New seed 20261024 | 44 | 44 | 418,832 | 0 / 0 | 75,997 | 3.20 | 159 s |
| **Total** | **354** | **394** | | | | **26.78** | **22.3 min** |

- **Calls:** median 9.4 s, longest 54 s. On the official sample, median output was 1,135 tokens
  (thinking included); the largest output of any call was 6,956.
- **Reliability:** every call ended with `end_turn` on the first attempt. There were no retries, no
  `max_tokens` stops and no refusals.
- **Budget:** a hard cap of $39 was enforced by worst-case reservation and never came close to binding.
  The coordinator later raised the budget to $50, which was not needed.
- **Paper comparison:** Figure 11, read off its log scale, puts GPT-5 at about 5 cents per record and the
  other five models below 1 cent. Opus 5.5 costs 7.0 cents per record here.

## Protocol, deviations, and what is not comparable

Unchanged from upstream: the prompt (`build_prompt`, baseline variant, normal visibility, one user turn),
the JSON parser, the scorer (`analyze_submission`), the summaries, the ledger-feedback loop, and the
paired bootstrap. Each record went through upstream `run_ablation_evaluation`. The wrapper only ran
records in parallel and reassembled the official output files.

Deviations from the paper's protocol:

1. **Subset, not the full split.** We scored 178 of the 710 records:
   - 120 of the 480 standard records: one per industry × period × difficulty cell, drawn uniformly from
     that cell's four records with seed 42.
   - 58 of the 230 negatives: 2 or 3 per code, so 33% negatives against the split's 32%.

   The design mirrors the split's composition, so the point estimates are unbiased for the full split.
   They are still estimates, and that is why every row carries a CI. The paper's numbers have no CIs.
2. **Decoding.** We sent no `temperature`, because Opus 5.5 rejects sampling parameters; the paper used
   temperature 0. Thinking cannot be disabled on Opus 5.5, so it ran with adaptive thinking at effort
   `medium`. In the paper's panel, four of six models ran without reasoning, GPT-5 used low effort and
   Grok-4.3 reasoned. This is a different decoding regime, not a like-for-like setting.
3. **Output budget.** `max_tokens` was 32,000, covering thinking plus the answer. That matches the paper's
   GPT-5 setting; its other models used 8k to 16k. No call came near the limit.
4. **Client.** Upstream ships only an OpenAI-compatible client, so a new Anthropic client was written.
   It implements the harness's `ChatClient` protocol, streams responses, uses SDK retries plus at most 2
   retries after a stream breaks, and computes cost from list prices rather than provider billing. Details
   are in [`evals/external/finbalance/README.md`](../../evals/external/finbalance/README.md).
5. **Prompt caching.** In the ledger-feedback run only, one `cache_control` breakpoint sits on the first
   user message, because the revision turn resends the whole record prompt. This affects billing, not
   what the model sees.
6. **Ledger feedback scope.** The paper ran it on its 143-record compact split; ours used 40 records from
   the main split. Our n is small, so the CI (±9 pp) cannot rule out small effects. It does rule out an
   effect of the +30 pp size the paper reports.
7. **Single run.** As in the paper's headline panel, each condition ran once. Our only run-to-run
   evidence is that 2 of 32 records flipped between two independent runs, one in each direction.
8. **Confidence intervals.** Upstream only has the paired bootstrap. The single-run CIs here are a
   percentile bootstrap over record IDs (5,000 resamples, seed 1) that reuses the upstream metric
   functions.
9. **Citation metrics.** The paper's v1 text describes "citations correct" relative to postings that are
   otherwise correct, while its released plotting code divides by all expected postings. We report both
   (46.6% and 55.2% mismatch). The superset-tolerant strict score is our reimplementation from the
   paper's text; upstream has no code for it.

What still limits the comparison:

- **Different models.** Opus 5.5 is a newer frontier model with reasoning always on, measured months after
  the paper's runs and through a different provider. The comparison says how Opus 5.5 does on this
  benchmark. It is not a controlled head-to-head.
- **Different denominators.** Ours are a stratified subset with CIs; the paper's are full-split point
  estimates. Paper columns other than BS_exact, BS_recon, gap and entry ratio are rounded integers read
  from a heatmap.

## Failures and anomalies

- **No transport failures.** There were 0 API errors, 0 parse failures, 0 retries, 0 refusals and 0
  `max_tokens` stops over 394 calls. No records were dropped.
- **Both false alarms are a data artifact.**
  - Records `DB_SUB_Q4_00342` and `DB_SUB_Q5_00345` are labelled consistent. Each has a credit memo that
    prints `Tax Rate: 0.00%` next to a nonzero tax amount (for example $1,367.25 on $10,938.03), which
    contradicts the 6.25% on the original invoice.
  - Opus 5.5 flagged `tax_rate_mismatch` and quoted those numbers. The upstream scorer counts both as
    false alarms and balance-sheet misses.
  - Four records in the 710-record split carry this artifact: `COV_SUB_Q4_0113`, `DB_SUB_Q4_00342`,
    `DB_SUB_Q5_00343` and `DB_SUB_Q5_00345`.
  - Leaving our two affected records out would move BS_exact from 69.2% to 70.3% (83 of 118). We report
    the official number.
- **The code misses are extra codes, not missed contradictions.** All three, across all splits, are
  `input_tax_mismatch` records answered with the right code plus related tax codes. A "contains the
  expected code" rule would score them correct; the official exact-set rule does not.
