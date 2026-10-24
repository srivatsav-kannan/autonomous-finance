#!/usr/bin/env python3
"""Summarize FinBalance runs produced by run_finbalance.py and compare them with the paper.

Point estimates come from the upstream summarizer (`summarize_ablation_results`) over the
per-record rows the official scorer produced. Confidence intervals:

* single-run 95% CIs: percentile bootstrap over record IDs (5000 resamples, seed 1),
  reusing the upstream metric functions from `finbalance.benchmark.bootstrap` and the
  same percentile indexing as its `_bootstrap_diffs`. Upstream only ships the paired
  (baseline vs ablation) bootstrap, so the single-run wrapper lives here.
* ledger-feedback delta: the upstream paired bootstrap, `analyze_ablation_bootstrap`,
  run unmodified over the result directory (baseline = prompt_baseline).
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

from finbalance.benchmark.ablations import summarize_ablation_results
from finbalance.benchmark.bootstrap import _metric_functions, _safe_rate, analyze_ablation_bootstrap

# Paper numbers: arXiv 2606.15949 v1 (identical in the camera-ready source in the repo).
# BS_exact / BS_recon / gap / entry ratio: Table 5 ("Three regimes on the 480 standard records").
# Entries correct / strict / citations correct / contradiction code: Figure 2 heatmap (integers,
# 710-record core split; balance-sheet and entry metrics over 480 standard records, code over 230).
PAPER_MODELS = [
    {"model": "GPT-5 (reasoning low)", "bs_exact": 0.465, "bs_recon": 0.463, "gap": -0.002, "entry_ratio": 0.91,
     "entries_correct": 0.40, "strict_end_to_end": 0.05, "citations_correct": 0.52, "inconsistency_code": 0.43},
    {"model": "Grok-4.3 (reasoning)", "bs_exact": 0.310, "bs_recon": 0.350, "gap": 0.040, "entry_ratio": 0.40,
     "entries_correct": 0.26, "strict_end_to_end": 0.05, "citations_correct": 0.84, "inconsistency_code": 0.96},
    {"model": "Gemini 3 Flash", "bs_exact": 0.235, "bs_recon": 0.548, "gap": 0.313, "entry_ratio": 0.94,
     "entries_correct": 0.49, "strict_end_to_end": 0.06, "citations_correct": 0.48, "inconsistency_code": 0.82},
    {"model": "DeepSeek Chat", "bs_exact": 0.067, "bs_recon": 0.473, "gap": 0.406, "entry_ratio": 0.98,
     "entries_correct": 0.45, "strict_end_to_end": 0.02, "citations_correct": 0.70, "inconsistency_code": 0.60},
    {"model": "Claude Haiku 4.5", "bs_exact": 0.029, "bs_recon": 0.292, "gap": 0.263, "entry_ratio": 0.53,
     "entries_correct": 0.27, "strict_end_to_end": 0.01, "citations_correct": 0.83, "inconsistency_code": 0.67},
    {"model": "Qwen3 235B", "bs_exact": 0.013, "bs_recon": 0.302, "gap": 0.290, "entry_ratio": 0.94,
     "entries_correct": 0.25, "strict_end_to_end": 0.00, "citations_correct": 0.71, "inconsistency_code": 0.84},
]
# Figure 3 (compact split, n=143: BS_exact over 120 standard, code over 23 negatives), read off the plot.
PAPER_LEDGER_FEEDBACK = [
    {"model": "Gemini 3 Flash", "bs_exact_delta_pp": 32, "inconsistency_code_delta_pp": -13},
    {"model": "Qwen3 235B", "bs_exact_delta_pp": 30, "inconsistency_code_delta_pp": -17},
    {"model": "Claude Haiku 4.5", "bs_exact_delta_pp": 31, "inconsistency_code_delta_pp": -52},
]

ITERATIONS = 5000
SEED = 1
CONFIDENCE = 0.95

CHECK_METRICS = (
    "bs_exact", "bs_recon", "gap_recon_minus_exact", "entries_correct_no_doc_refs", "strict_end_to_end",
    "citations_correct", "inconsistency_flag_detection_rate", "inconsistency_code_match_rate",
    "false_inconsistency_alarm_rate", "parse_success_rate",
)
CHECK_DIFF_METRICS = ("bs_exact", "bs_recon", "strict_end_to_end", "citations_correct", "inconsistency_code_match_rate")


def load_rows(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _standard(rows):
    return [r for r in rows if not r["metrics"]["expected_inconsistency"]]


def _negative(rows):
    return [r for r in rows if r["metrics"]["expected_inconsistency"]]


def _bool_rate(key: str, population: Callable) -> Callable:
    def rate(rows):
        subset = population(rows)
        return _safe_rate(sum(1 for r in subset if r["metrics"].get(key)), len(subset))

    return rate


def _sum_ratio(numerator: Callable, denominator: Callable) -> Callable:
    def rate(rows):
        subset = _standard(rows)
        return _safe_rate(sum(numerator(r["metrics"]) for r in subset), sum(denominator(r["metrics"]) for r in subset))

    return rate


def _mismatch_pairs(row):
    """(expected refs, predicted refs) for expected postings matched on accounts+amount but not refs."""
    predicted = row["entry_diagnostics"]["predicted_entries"]
    for entry in row["entry_diagnostics"]["expected_entries"]:
        if entry["status"] == "doc_refs_mismatch":
            yield set(entry["posting"]["doc_refs"]), set(predicted[entry["matched_predicted_index"]]["posting"]["doc_refs"])


def _tolerant_strict(row) -> bool:
    """Paper appendix 'citation sensitivity': strict end-to-end, but a strict superset of the
    expected doc_refs also counts. Not in the upstream code; reimplemented from the paper text."""
    metrics = row["metrics"]
    if not (metrics.get("final_balance_sheet_matches") and metrics.get("journal_entries_accounting_matched")):
        return False
    return all(expected < predicted for expected, predicted in _mismatch_pairs(row))


def doc_ref_mismatch_structure(rows) -> dict[str, Any]:
    from collections import Counter

    kinds: Counter = Counter()
    extra: Counter = Counter()
    missing: Counter = Counter()
    for row in _standard(rows):
        index = row["document_index"]
        for expected, predicted in _mismatch_pairs(row):
            if expected < predicted:
                kinds["superset_expected_plus_extras"] += 1
            elif predicted < expected:
                kinds["subset_missing_some"] += 1
            elif expected & predicted:
                kinds["partial_overlap"] += 1
            else:
                kinds["disjoint"] += 1
            for doc in predicted - expected:
                extra[f"{index.get(doc, {}).get('role', '?')}:{index.get(doc, {}).get('doc_type', '?')}"] += 1
            for doc in expected - predicted:
                missing[f"{index.get(doc, {}).get('role', '?')}:{index.get(doc, {}).get('doc_type', '?')}"] += 1
    return {
        "mismatched_postings": sum(kinds.values()),
        "kinds": dict(kinds),
        "extra_citations_total": sum(extra.values()),
        "extra_citations_top": extra.most_common(6),
        "missing_citations_total": sum(missing.values()),
        "missing_citations_top": missing.most_common(6),
    }


def metric_functions() -> dict[str, Callable]:
    upstream = _metric_functions()  # same definitions the paper's paired bootstrap uses
    bs_exact = upstream["final_balance_sheet_matches_rate"]
    bs_recon = upstream["predicted_entries_reconstruct_correct_final_balance_sheet_rate"]
    doc_ref = upstream["strict_doc_ref_mismatch_rate"]
    return {
        "bs_exact": bs_exact,
        "bs_recon": bs_recon,
        "gap_recon_minus_exact": lambda rows: bs_recon(rows) - bs_exact(rows),
        "entries_correct_no_doc_refs": upstream["final_journal_entries_match_no_doc_refs_rate"],
        "strict_end_to_end": upstream["final_balance_sheet_and_journal_entries_match_rate"],
        "strict_end_to_end_superset_tolerant": lambda rows: _safe_rate(
            sum(1 for r in _standard(rows) if _tolerant_strict(r)), len(_standard(rows))
        ),
        "doc_ref_mismatch_per_expected_posting": doc_ref,
        "citations_correct": lambda rows: 1.0 - doc_ref(rows),
        "doc_ref_mismatch_among_account_amount_correct": _sum_ratio(
            lambda m: int(m.get("doc_refs_mismatch_count", 0)),
            lambda m: int(m.get("doc_refs_mismatch_count", 0)) + int(m.get("exact_entry_match_count", 0)),
        ),
        "entry_exact_posting_rate": _sum_ratio(
            lambda m: int(m.get("exact_entry_match_count", 0)), lambda m: int(m.get("expected_entry_count", 0))
        ),
        "entry_accounting_posting_rate": _sum_ratio(
            lambda m: int(m.get("exact_entry_match_count", 0)) + int(m.get("doc_refs_mismatch_count", 0)),
            lambda m: int(m.get("expected_entry_count", 0)),
        ),
        "entry_ratio_predicted_over_expected": _sum_ratio(
            lambda m: int(m.get("predicted_entry_count", 0)), lambda m: int(m.get("expected_entry_count", 0))
        ),
        "false_inconsistency_alarm_rate": _bool_rate("false_inconsistency_alarm", _standard),
        "inconsistency_code_match_rate": upstream["inconsistency_code_match_rate"],
        "inconsistency_flag_detection_rate": _bool_rate("inconsistency_flag_matches", _negative),
        "inconsistency_empty_answer_rate": _bool_rate("inconsistency_empty_answer", _negative),
        "parse_success_rate": _bool_rate("parse_success", lambda rows: rows),
    }


def bootstrap(rows, fns: dict[str, Callable], *, iterations=ITERATIONS, seed=SEED, confidence=CONFIDENCE):
    rng = random.Random(seed)
    n = len(rows)
    samples: dict[str, list[float]] = defaultdict(list)
    for _ in range(iterations):
        resample = [rows[rng.randrange(n)] for _ in range(n)]
        for name, fn in fns.items():
            samples[name].append(fn(resample))
    alpha = 1.0 - confidence
    low_index = min(int((alpha / 2.0) * iterations), iterations - 1)
    high_index = min(int((1.0 - alpha / 2.0) * iterations), iterations - 1)
    out = {}
    for name, fn in fns.items():
        values = sorted(samples[name])
        out[name] = {"value": round(fn(rows), 4), "ci_low": round(values[low_index], 4), "ci_high": round(values[high_index], 4)}
    return out


def unpaired_difference(rows_a, rows_b, fn: Callable, *, iterations=ITERATIONS, seed=SEED, confidence=CONFIDENCE):
    """Percentile bootstrap CI for fn(b) - fn(a) over two independent record samples."""
    rng = random.Random(seed)
    diffs = []
    for _ in range(iterations):
        sample_a = [rows_a[rng.randrange(len(rows_a))] for _ in rows_a]
        sample_b = [rows_b[rng.randrange(len(rows_b))] for _ in rows_b]
        diffs.append(fn(sample_b) - fn(sample_a))
    diffs.sort()
    alpha = 1.0 - confidence
    low = diffs[min(int((alpha / 2.0) * iterations), iterations - 1)]
    high = diffs[min(int((1.0 - alpha / 2.0) * iterations), iterations - 1)]
    return {"diff": round(fn(rows_b) - fn(rows_a), 4), "ci_low": round(low, 4), "ci_high": round(high, 4)}


def slice_table(rows, field: str) -> dict[str, Any]:
    groups: dict[str, list] = defaultdict(list)
    for row in rows:
        value = row.get(field)
        if value is None:
            value = row.get("record_features", {}).get(field)
        groups[str(value)].append(row)
    fns = metric_functions()
    keep = ["bs_exact", "bs_recon", "gap_recon_minus_exact", "strict_end_to_end", "entries_correct_no_doc_refs",
            "citations_correct", "entry_ratio_predicted_over_expected"]
    table = {}
    for key in sorted(groups):
        standard = _standard(groups[key])
        if not standard:
            continue
        ci = bootstrap(standard, {name: fns[name] for name in ("bs_exact", "bs_recon")}, iterations=2000)
        table[key] = {
            "n_standard": len(standard),
            **{name: round(fns[name](standard), 4) for name in keep},
            "bs_exact_ci": [ci["bs_exact"]["ci_low"], ci["bs_exact"]["ci_high"]],
            "bs_recon_ci": [ci["bs_recon"]["ci_low"], ci["bs_recon"]["ci_high"]],
        }
    return table


def spend_by_run(ledger_path: Path) -> dict[str, Any]:
    by_run: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    latencies: dict[str, list[float]] = defaultdict(list)
    for row in load_rows(ledger_path):
        run = row["run"]
        for key in ("cost_usd", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            by_run[run][key] += float(row.get(key, 0) or 0)
        by_run[run]["calls"] += 1
        latencies[run].append(float(row.get("latency_seconds", 0.0)))
    out = {}
    for run, totals in by_run.items():
        out[run] = {key: round(value, 6) if key == "cost_usd" else int(value) for key, value in totals.items()}
        out[run]["median_call_latency_seconds"] = round(statistics.median(latencies[run]), 1)
        out[run]["max_call_latency_seconds"] = round(max(latencies[run]), 1)
    out["_total_cost_usd"] = round(sum(v["cost_usd"] for k, v in out.items() if not k.startswith("_")), 4)
    return out


def wall_seconds(ablation_dir: Path) -> float:
    path = ablation_dir / "_run_sessions.jsonl"
    if not path.exists():
        return 0.0
    return round(sum(float(s.get("wall_seconds", 0.0)) for s in load_rows(path)), 1)


def failures(rows) -> dict[str, Any]:
    parse_fail = [r for r in rows if not r["metrics"]["parse_success"]]
    return {
        "parse_failures": len(parse_fail),
        "api_error_rows": sum(1 for r in rows if r.get("api_error")),
        "max_tokens_stops": sum(1 for r in rows if (r.get("raw_provider_payload") or {}).get("stop_reason") == "max_tokens"),
        "refusal_stops": sum(1 for r in rows if (r.get("raw_provider_payload") or {}).get("stop_reason") == "refusal"),
        "failed_records": [
            {"record_id": r["record_id"], "error": (r.get("error") or "")[:200],
             "stop_reason": (r.get("raw_provider_payload") or {}).get("stop_reason")}
            for r in parse_fail
        ],
    }


def _pct(value: float) -> str:
    return f"{100 * value:.1f}"


def _ci(entry: dict[str, float]) -> str:
    return f"{_pct(entry['value'])} [{_pct(entry['ci_low'])}, {_pct(entry['ci_high'])}]"


def render_markdown(result: dict[str, Any]) -> str:
    h = result["headline"]
    n = result["n"]
    lines = [
        "### Comparison with the paper's panel",
        "",
        "| Model | Records | BS_exact | BS_recon | Gap (pp) | Entries correct | Strict end-to-end | Citations correct | Contradiction code | Entry ratio |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        f"| **Claude Opus 5.5** (ours, 95% CI) | {n['standard']} std + {n['negatives']} neg | {_ci(h['bs_exact'])} | {_ci(h['bs_recon'])} | "
        f"{_ci(h['gap_recon_minus_exact'])} | {_ci(h['entries_correct_no_doc_refs'])} | {_ci(h['strict_end_to_end'])} | "
        f"{_ci(h['citations_correct'])} | {_ci(h['inconsistency_code_match_rate'])} | {h['entry_ratio_predicted_over_expected']['value']:.2f} |",
    ]
    for row in PAPER_MODELS:
        lines.append(
            f"| {row['model']} | 480 std + 230 neg | {_pct(row['bs_exact'])} | {_pct(row['bs_recon'])} | {100 * row['gap']:+.1f} | "
            f"{100 * row['entries_correct']:.0f} | {100 * row['strict_end_to_end']:.0f} | {100 * row['citations_correct']:.0f} | "
            f"{100 * row['inconsistency_code']:.0f} | {row['entry_ratio']:.2f} |"
        )
    lines += [
        "",
        "### Inconsistency detection and grounding",
        "",
        "| Metric | Value [95% CI] |",
        "|---|---:|",
        f"| Flag detection on negatives (`has_inconsistency=true`) | {_ci(h['inconsistency_flag_detection_rate'])} |",
        f"| Correct code on negatives (contradiction code) | {_ci(h['inconsistency_code_match_rate'])} |",
        f"| Flag + code + empty entries and balance sheet | {_ci(h['inconsistency_empty_answer_rate'])} |",
        f"| False alarm on standard records | {_ci(h['false_inconsistency_alarm_rate'])} |",
        f"| Strict end-to-end, superset doc_refs accepted (paper's citation-sensitivity score) | {_ci(h['strict_end_to_end_superset_tolerant'])} |",
        f"| Doc-ref mismatch per expected posting (paper's Figure 2 definition) | {_ci(h['doc_ref_mismatch_per_expected_posting'])} |",
        f"| Doc-ref mismatch among postings with correct accounts and amount | {_ci(h['doc_ref_mismatch_among_account_amount_correct'])} |",
        f"| Expected postings matched exactly (accounts, amount, doc_refs) | {_ci(h['entry_exact_posting_rate'])} |",
        f"| Expected postings matched on accounts and amount | {_ci(h['entry_accounting_posting_rate'])} |",
        f"| Parse success (all records) | {_ci(h['parse_success_rate'])} |",
        "",
    ]
    for title, key in (("difficulty level", "by_difficulty"), ("period type", "by_period_type"), ("industry", "by_industry")):
        lines += [
            f"### By {title} (standard records)",
            "",
            f"| {title.capitalize()} | n | BS_exact [95% CI] | BS_recon [95% CI] | Gap (pp) | Strict | Entries correct | Citations correct | Entry ratio |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for name, row in result[key].items():
            lines.append(
                f"| {name} | {row['n_standard']} | {_pct(row['bs_exact'])} [{_pct(row['bs_exact_ci'][0])}, {_pct(row['bs_exact_ci'][1])}] | "
                f"{_pct(row['bs_recon'])} [{_pct(row['bs_recon_ci'][0])}, {_pct(row['bs_recon_ci'][1])}] | "
                f"{100 * row['gap_recon_minus_exact']:+.1f} | {_pct(row['strict_end_to_end'])} | {_pct(row['entries_correct_no_doc_refs'])} | "
                f"{_pct(row['citations_correct'])} | {row['entry_ratio_predicted_over_expected']:.2f} |"
            )
        lines.append("")
    lines += ["### Negatives by code", "", "| Code | n | Flagged | Correct code |", "|---|---:|---:|---:|"]
    for code, row in sorted(result["negatives_by_code"].items()):
        lines.append(f"| `{code}` | {row['n']} | {_pct(row['flag_rate'])} | {_pct(row['code_match_rate'])} |")
    lines.append("")
    feedback = result.get("ledger_feedback")
    if feedback:
        lines += [
            f"### Ledger feedback (paired, {feedback['matched_records']} records: {feedback['standard']} standard + {feedback['negatives']} negative)",
            "",
            "| Metric | Baseline | Ledger feedback | Delta (pp) [95% paired CI] |",
            "|---|---:|---:|---:|",
        ]
        for row in feedback["paired_bootstrap_upstream"]:
            lines.append(
                f"| `{row['metric']}` | {_pct(row['baseline_rate'])} | {_pct(row['ablation_rate'])} | "
                f"{100 * row['diff']:+.1f} [{100 * row['ci_low']:+.1f}, {100 * row['ci_high']:+.1f}] |"
            )
        lines.append("")
    checks = result.get("contamination_checks") or {}
    if checks:
        labels = list(checks)
        header = "| Metric | Official main sample | " + " | ".join(labels) + " |"
        lines += [
            "### Contamination check: official split vs freshly generated splits (95% CI)",
            "",
            "| Split | Records | Origin |",
            "|---|---|---|",
            f"| Official main sample | {n['standard']} std + {n['negatives']} neg | released `data/main` (committed 2026-05, published with the June 2026 preprint) |",
        ]
        for label, check in checks.items():
            lines.append(f"| {label} | {check['n']['standard']} std + {check['n']['negatives']} neg | {check['description']} |")
        lines += ["", header, "|---|---:|" + "---:|" * len(labels)]
        for name in CHECK_METRICS:
            cells = [_ci(checks[label]["headline"][name]) for label in labels]
            lines.append(f"| `{name}` | {_ci(h[name])} | " + " | ".join(cells) + " |")
        lines += ["", "| Difference vs official main sample (pp) [95% CI] | " + " | ".join(labels) + " |",
                  "|---|" + "---:|" * len(labels)]
        for name in CHECK_DIFF_METRICS:
            cells = []
            for label in labels:
                diff = checks[label]["minus_main_unpaired"][name]
                cells.append(f"{100 * diff['diff']:+.1f} [{100 * diff['ci_low']:+.1f}, {100 * diff['ci_high']:+.1f}]")
            lines.append(f"| `{name}` | " + " | ".join(cells) + " |")
        lines += ["", "| Level | Official main BS_exact | " + " | ".join(f"{label} BS_exact" for label in labels) + " |",
                  "|---|---:|" + "---:|" * len(labels)]
        for level, row in result["by_difficulty"].items():
            cells = []
            for label in labels:
                other = checks[label]["by_difficulty"].get(level)
                cells.append(f"{_pct(other['bs_exact'])} (n={other['n_standard']})" if other else "")
            lines.append(f"| {level} | {_pct(row['bs_exact'])} (n={row['n_standard']}) | " + " | ".join(cells) + " |")
        lines.append("")
    lines += ["### Spend", "", "| Run | Calls | Input tok | Cache-read tok | Cache-write tok | Output tok | Cost (USD) | Median call (s) |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for run, row in result["spend"].items():
        if run.startswith("_"):
            continue
        lines.append(
            f"| {run} | {row['calls']} | {row['input_tokens']:,} | {row['cache_read_input_tokens']:,} | "
            f"{row['cache_creation_input_tokens']:,} | {row['output_tokens']:,} | {row['cost_usd']:.2f} | {row['median_call_latency_seconds']} |"
        )
    lines.append(f"| **Total** | | | | | | **{result['spend']['_total_cost_usd']:.2f}** | |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results-root", required=True, help="dir holding prompt_baseline/ (and forced_ledger_verifier/)")
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--sample-file", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--tables-md", help="also write markdown tables to this path")
    parser.add_argument("--dataset", help="main records.jsonl; enables the zero-rate credit-memo artifact count")
    parser.add_argument(
        "--check",
        action="append",
        nargs=4,
        default=[],
        metavar=("LABEL", "RESULTS_ROOT", "SAMPLE_FILE", "DESCRIPTION"),
        help="a baseline run on another split to compare with the official sample (repeatable)",
    )
    args = parser.parse_args()

    root = Path(args.results_root)
    base_rows = load_rows(root / "prompt_baseline" / "per_record_results.jsonl")
    summary = summarize_ablation_results(base_rows)
    fns = metric_functions()
    headline = bootstrap(base_rows, fns)
    sample = json.loads(Path(args.sample_file).read_text(encoding="utf-8"))

    negatives_by_code = {
        code: {"n": stats["inconsistency_records"], "code_match_rate": stats["inconsistency_code_match_rate"],
               "flag_rate": stats["inconsistency_flag_match_rate"]}
        for code, stats in summary["by_inconsistency_code"].items() if code != "none"
    }

    result: dict[str, Any] = {
        "benchmark": "FinBalance (arXiv 2606.15949, EMNLP 2026 Findings)",
        "harness": "github.com/Devansh1105/finbalance (unmodified scorer, prompt, parser, ablation loop)",
        "model": "claude-opus-5-5",
        "config": {
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "medium"},
            "max_tokens": 32000,
            "temperature": "not sent (rejected by the model); paper used 0.0",
            "prompt": "upstream build_prompt, prompt_variant=baseline, visibility=normal, single user turn",
        },
        "sample": {"file": args.sample_file, "seed": sample["seed"], **sample["counts"]},
        "n": {"records": len(base_rows), "standard": summary["standard_records"], "negatives": summary["inconsistency_records"]},
        "headline": headline,
        "bootstrap": {"iterations": ITERATIONS, "seed": SEED, "confidence": CONFIDENCE,
                      "method": "percentile bootstrap over record IDs; upstream metric definitions"},
        "upstream_summary_scalars": {k: v for k, v in summary.items() if isinstance(v, (int, float, str)) and not k.startswith("by_")},
        "error_taxonomy": summary["error_taxonomy"],
        "by_difficulty": slice_table(base_rows, "difficulty_level"),
        "by_period_type": slice_table(base_rows, "period_type"),
        "by_industry": slice_table(base_rows, "industry"),
        "negatives_by_code": negatives_by_code,
        "doc_ref_mismatch_structure": doc_ref_mismatch_structure(base_rows),
        "internal_consistency": {
            "reported_equals_replayed_balance_sheet": sum(
                1 for r in _standard(base_rows) if r["metrics"]["predicted_balance_sheet_matches_reconstructed_balance_sheet"]
            ),
            "bs_exact_differs_from_bs_recon": sum(
                1 for r in _standard(base_rows)
                if r["metrics"]["final_balance_sheet_matches"]
                != r["metrics"]["predicted_entries_reconstruct_correct_final_balance_sheet"]
            ),
            "standard_records": len(_standard(base_rows)),
        },
        "false_alarms": [
            {"record_id": r["record_id"], "codes": r["parsed_submission"]["inconsistency_codes"],
             "note": (r["parsed_submission"]["inconsistency_notes"] or [""])[0][:300]}
            for r in _standard(base_rows) if r["metrics"]["false_inconsistency_alarm"]
        ],
        "negatives_wrong_code": [
            {"record_id": r["record_id"], "expected": r["record_features"].get("expected_inconsistency_code"),
             "predicted": r["parsed_submission"]["inconsistency_codes"]}
            for r in _negative(base_rows) if not r["metrics"]["inconsistency_code_matches"]
        ],
        "output_tokens": {
            "median": statistics.median(r["completion_tokens"] for r in base_rows),
            "max": max(r["completion_tokens"] for r in base_rows),
            "max_tokens_setting": 32000,
        },
        "failures": failures(base_rows),
        "paper_models": PAPER_MODELS,
        "paper_ledger_feedback": PAPER_LEDGER_FEEDBACK,
        "wall_seconds": {"prompt_baseline": wall_seconds(root / "prompt_baseline")},
        "spend": spend_by_run(Path(args.ledger)),
    }

    verifier_dir = root / "forced_ledger_verifier"
    if (verifier_dir / "per_record_results.jsonl").exists():
        boot = analyze_ablation_bootstrap(root, baseline_name="prompt_baseline", iterations=ITERATIONS,
                                          confidence=CONFIDENCE, seed=SEED)
        verifier_rows = load_rows(verifier_dir / "per_record_results.jsonl")
        ids = {r["record_id"] for r in verifier_rows}
        matched_base = [r for r in base_rows if r["record_id"] in ids]
        base_by_id = {r["record_id"]: r for r in matched_base}
        flips_up = flips_down = changed_vs_draft = 0
        for row in _standard(verifier_rows):
            before = base_by_id[row["record_id"]]["metrics"]["final_balance_sheet_matches"]
            after = row["metrics"]["final_balance_sheet_matches"]
            flips_up += int(after and not before)
            flips_down += int(before and not after)
            draft = (row.get("verifier_feedback") or [{}])[0].get("submitted_balance_sheet") or {}
            final = row["parsed_submission"]["balance_sheet"]
            for section in ("assets", "liabilities", "equity"):
                accounts = set(draft.get(section, {})) | set(final.get(section, {}))
                if any(abs(draft.get(section, {}).get(a, 0.0) - final.get(section, {}).get(a, 0.0)) > 0.01 for a in accounts):
                    changed_vs_draft += 1
                    break
        result["ledger_feedback"] = {
            "matched_records": len(ids),
            "standard": len(_standard(verifier_rows)),
            "negatives": len(_negative(verifier_rows)),
            "paired_bootstrap_upstream": [row for row in boot["comparisons"] if row["ablation_name"] == "forced_ledger_verifier"],
            "baseline_on_subset": {name: round(fn(matched_base), 4) for name, fn in fns.items()},
            "feedback_on_subset": {name: round(fn(verifier_rows), 4) for name, fn in fns.items()},
            "failures": failures(verifier_rows),
            "verifier_first_draft_self_consistent_rate": _safe_rate(
                sum(1 for r in _standard(verifier_rows)
                    if (r.get("verifier_feedback") or [{}])[0].get("submitted_balance_sheet_matches_reconstructed")),
                len(_standard(verifier_rows)),
            ),
            "standard_final_balance_sheet_changed_vs_draft": changed_vs_draft,
            "standard_flips_vs_independent_baseline": {
                "feedback_right_baseline_wrong": flips_up,
                "baseline_right_feedback_wrong": flips_down,
            },
            "negatives_draft_flagged_inconsistency": sum(
                1 for r in _negative(verifier_rows)
                if (r.get("verifier_feedback") or [{}])[0].get("claimed_inconsistency")
            ),
        }
        result["wall_seconds"]["forced_ledger_verifier"] = wall_seconds(verifier_dir)

    if args.check:
        result["contamination_checks"] = {}
    for label, check_root, check_sample_file, description in args.check:
        check_rows = load_rows(Path(check_root) / "prompt_baseline" / "per_record_results.jsonl")
        check_sample = json.loads(Path(check_sample_file).read_text(encoding="utf-8"))
        result["contamination_checks"][label] = {
            "description": description,
            "dataset": check_sample.get("dataset"),
            "sample_file": check_sample_file,
            "sample": check_sample.get("counts"),
            "n": {"records": len(check_rows), "standard": len(_standard(check_rows)), "negatives": len(_negative(check_rows))},
            "headline": bootstrap(check_rows, {name: fns[name] for name in CHECK_METRICS}),
            "minus_main_unpaired": {name: unpaired_difference(base_rows, check_rows, fns[name]) for name in CHECK_DIFF_METRICS},
            "by_difficulty": slice_table(check_rows, "difficulty_level"),
            "failures": failures(check_rows),
            "wall_seconds": wall_seconds(Path(check_root) / "prompt_baseline"),
        }

    if args.dataset:
        import re

        artifact_ids = set()
        with Path(args.dataset).open(encoding="utf-8") as handle:
            for line in handle:
                record = json.loads(line)
                if record["expected_inconsistency"]:
                    continue
                for document in record["documents"]:
                    amount = re.search(r"Tax Amount: [^\d\n]*([\d,]+\.\d\d)", document["ocr_text"])
                    if "Tax Rate: 0.00%" in document["ocr_text"] and amount and float(amount.group(1).replace(",", "")) > 0:
                        artifact_ids.add(record["record_id"])
        result["standard_records_with_zero_rate_but_nonzero_tax_document"] = {
            "in_main_split": sorted(artifact_ids),
            "in_sample": sorted(artifact_ids & {r["record_id"] for r in base_rows}),
            "note": "documents print 'Tax Rate: 0.00%' next to a nonzero tax amount in records labelled consistent",
        }

    result["protocol_deviations"] = [
        "subset: 178 of 710 main-split records (120 of 480 standard, one per industry x period x level cell; 58 of 230 negatives, 2-3 per code); paper ran all 710",
        "temperature not sent (claude-opus-5-5 rejects sampling parameters); paper decoded at temperature 0",
        "adaptive thinking at effort medium (thinking cannot be disabled on claude-opus-5-5); 4 of the paper's 6 models ran without reasoning",
        "max_tokens 32000 for thinking plus answer (paper: 8k-32k per model); largest observed output 6,956 tokens",
        "new Anthropic Messages API client (upstream ships only an OpenAI-compatible client); streaming; SDK retries plus bounded stream retries",
        "cost computed from list prices ($4/$20/$0.20 per M input/output/cache-read tokens), not provider-billed",
        "concurrency 4 via one upstream run_ablation_evaluation call per record; prompt, parser and scorer unchanged",
        "single-run 95% CIs come from a percentile bootstrap over record IDs written here (upstream ships only the paired bootstrap)",
        "ledger feedback on 40 main-split records (32 standard + 8 negative), paper used the 143-record compact split; prompt caching on the first user message in that run only (billing only)",
        "paper per-model values: Table 5 (BS_exact, BS_recon, gap, entry ratio) and Figure 2 heatmap integers (other columns)",
    ]
    Path(args.output_json).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.tables_md:
        Path(args.tables_md).write_text(render_markdown(result), encoding="utf-8")
    print(json.dumps({"headline": headline, "n": result["n"], "spend_total": result["spend"]["_total_cost_usd"],
                      "wall_seconds": result["wall_seconds"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
