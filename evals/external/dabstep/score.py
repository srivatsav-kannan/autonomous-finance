#!/usr/bin/env python3
"""Score DABstep runs with the official DABstep scoring logic.

The scorer is vendored verbatim from the adyen/DABstep Hugging Face Space (see vendor/README):
`dabstep_benchmark.utils.evaluate`, which calls `question_scorer(agent_answer, ground_truth)`.
This script only groups results into runs, calls `evaluate` once per run, and aggregates.

  uv run --no-project --with pandas python -I evals/external/dabstep/score.py \
      --tasks ../benchdata/dabstep/dev.jsonl \
      --results var/dabstep/runs/dev-x3/results.jsonl \
      --config var/dabstep/runs/dev-x3/config.json \
      --pilot var/dabstep/runs/pilot/results.jsonl \
      --ledger var/dabstep/ledger.jsonl \
      --reference evals/external/dabstep/reference.json \
      --out docs/evals/dabstep.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))

import pandas as pd  # noqa: E402

from dabstep_benchmark.utils import evaluate  # noqa: E402  (official, unmodified)

LEVELS = ("easy", "hard")


def load_jsonl(path: str | Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_match(agent: str, truth: str) -> bool:
    """Diagnostic only (not the benchmark metric): case/whitespace-normalised equality,
    order-insensitive for comma lists. Flags answers the official scorer accepts leniently."""

    def norm(s: str) -> str:
        return " ".join(s.strip().lower().split())

    a, t = norm(agent), norm(truth)
    if a == t:
        return True
    try:  # same number up to float noise (e.g. -0.948103 vs -0.94810300000017)
        return abs(float(a) - float(t)) <= 1e-9
    except ValueError:
        pass
    if "," in a or "," in t:
        split = lambda s: sorted(x.strip() for x in s.split(",") if x.strip())  # noqa: E731
        return split(a) == split(t)
    return False


def latest(records: list[dict]) -> dict[tuple[int, str], dict]:
    """Last record per (run, task_id): a re-run of an errored job supersedes the earlier attempt."""
    out: dict[tuple[int, str], dict] = {}
    for r in records:
        out[(int(r["run"]), str(r["task_id"]))] = r
    return out


def summarize(values: list[float]) -> dict:
    return {
        "mean": statistics.fmean(values) if values else None,
        "std": statistics.stdev(values) if len(values) > 1 else None,
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "per_run": values,
    }


def score_records(recs: dict[tuple[int, str], dict], tasks: list[dict], gt: pd.DataFrame, label: str) -> tuple[list[dict], dict]:
    runs = sorted({run for run, _ in recs})
    per_run = []
    per_task: dict[str, list[dict]] = {str(t["task_id"]): [] for t in tasks}
    for run in runs:
        have = [t for t in tasks if (run, str(t["task_id"])) in recs]
        gt_run = gt[gt["task_id"].isin([str(t["task_id"]) for t in have])]
        answers = pd.DataFrame(
            [{"task_id": str(t["task_id"]), "agent_answer": str(recs[(run, str(t["task_id"]))]["agent_answer"])} for t in have]
        )
        scores = evaluate(agent_answers=answers, tasks_with_gt=gt_run, submission_id=f"{label}-run{run}")
        by_level: dict[str, list[bool]] = {lvl: [] for lvl in LEVELS}
        for s in scores:
            rec = recs[(run, s["task_id"])]
            truth = gt.loc[gt.task_id == s["task_id"], "answer"].values[0]
            by_level.setdefault(s["level"], []).append(bool(s["score"]))
            per_task[s["task_id"]].append(
                {
                    "run": run,
                    "agent_answer": s["agent_answer"],
                    "score": bool(s["score"]),
                    "exact_match": exact_match(s["agent_answer"], truth),
                    "status": rec["status"],
                    "answer_found": rec["answer_found"],
                    "nudges": rec.get("nudges", []),
                    "n_requests": rec["n_requests"],
                    "code_calls": rec["code_calls"],
                    "models_served": rec["models_served"],
                    "cost_usd": round(rec["cost_usd"], 6),
                    "wall_s": round(rec["wall_s"], 1),
                    "tokens": rec["tokens"],
                }
            )
        all_scores = [x for v in by_level.values() for x in v]
        starts = [recs[(run, str(t["task_id"]))]["started_at"] for t in have]
        ends = [recs[(run, str(t["task_id"]))]["finished_at"] for t in have]
        per_run.append(
            {
                "run": run,
                "complete": len(have) == len(tasks),
                "n": {lvl: len(by_level[lvl]) for lvl in LEVELS} | {"overall": len(all_scores)},
                "correct": {lvl: sum(by_level[lvl]) for lvl in LEVELS} | {"overall": sum(all_scores)},
                "accuracy": {lvl: (sum(by_level[lvl]) / len(by_level[lvl]) if by_level[lvl] else None) for lvl in LEVELS}
                | {"overall": sum(all_scores) / len(all_scores) if all_scores else None},
                "token_cost_usd": round(sum(recs[(run, str(t["task_id"]))]["cost_usd"] for t in have), 4),
                "container_usd_upper_bound": round(sum(recs[(run, str(t["task_id"]))]["container_usd_upper_bound"] for t in have), 4),
                "sum_task_wall_s": round(sum(recs[(run, str(t["task_id"]))]["wall_s"] for t in have), 1),
                "first_start": min(starts),
                "last_finish": max(ends),
                "statuses": {st: sum(1 for t in have if recs[(run, str(t["task_id"]))]["status"] == st) for st in sorted({recs[(run, str(t["task_id"]))]["status"] for t in have})},
            }
        )
    return per_run, per_task


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, help="dev.jsonl with ground-truth answers")
    ap.add_argument("--results", required=True, help="results.jsonl written by run.ts")
    ap.add_argument("--config", help="config.json written by run.ts")
    ap.add_argument("--pilot", help="results.jsonl of the pilot (reported separately)")
    ap.add_argument("--ledger", help="var/dabstep/ledger.jsonl (all spend incl. probe and pilot)")
    ap.add_argument("--reference", help="reference.json with leaderboard/paper numbers")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tasks = load_jsonl(args.tasks)
    gt = pd.DataFrame(
        [{"task_id": str(t["task_id"]), "level": str(t["level"]), "answer": str(t["answer"])} for t in tasks]
    )
    recs = latest(load_jsonl(args.results))
    per_run, per_task = score_records(recs, tasks, gt, "main")
    complete = [r for r in per_run if r["complete"]]

    summary = {lvl: summarize([r["accuracy"][lvl] for r in complete]) for lvl in (*LEVELS, "overall")}
    task_rows = []
    for t in tasks:
        tid = str(t["task_id"])
        runs = per_task[tid]
        task_rows.append(
            {
                "task_id": tid,
                "level": t["level"],
                "question": t["question"],
                "guidelines": t["guidelines"],
                "ground_truth": t["answer"],
                "runs": runs,
                "correct_runs": sum(r["score"] for r in runs),
                "n_runs": len(runs),
            }
        )
    by_level_any_all = {}
    for lvl in LEVELS:
        rows = [r for r in task_rows if r["level"] == lvl and r["n_runs"]]
        by_level_any_all[lvl] = {
            "n_tasks": len(rows),
            "solved_in_any_run": sum(r["correct_runs"] > 0 for r in rows),
            "solved_in_every_run": sum(r["correct_runs"] == r["n_runs"] for r in rows),
        }

    all_recs = list(recs.values())
    walls = [r["wall_s"] for r in all_recs]
    costs = [r["cost_usd"] for r in all_recs]
    cost = {
        "pricing": "claude-opus-5-5 list price: $4/M input, $20/M output, $0.20/M cache read, $5/M 5-min cache write",
        "main_token_usd": round(sum(costs), 4),
        "main_container_usd_upper_bound": round(sum(r["container_usd_upper_bound"] for r in all_recs), 4),
        "per_task_run_usd": summarize(costs) | {"per_run": None},
        "tokens": {k: sum(r["tokens"][k] for r in all_recs) for k in ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")},
        "container_note": "Code execution without web tools bills $0.05 per container-hour after 1,550 free hours per org per month, with a 5-minute minimum per container; the upper bound ignores the free hours.",
    }
    if args.ledger:
        ledger = load_jsonl(args.ledger)
        by_label: dict[str, float] = {}
        for e in ledger:
            by_label[e.get("label", "?")] = by_label.get(e.get("label", "?"), 0.0) + float(e["cost_usd"])
        cost["ledger_total_usd"] = round(sum(by_label.values()), 4)
        cost["ledger_by_label_usd"] = {k: round(v, 4) for k, v in sorted(by_label.items())}
        cost["ledger_note"] = "Ledger = every API request made (probe, pilot, main runs) plus container upper bounds."
    timing = {
        "per_task_run_wall_s": summarize(walls) | {"per_run": None, "median": statistics.median(walls) if walls else None},
        "batch_wall_clock_s": None,
    }
    if all_recs:
        from datetime import datetime

        start = min(datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")) for r in all_recs)
        end = max(datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00")) for r in all_recs)
        timing["batch_wall_clock_s"] = round((end - start).total_seconds(), 1)

    out: dict = {
        "benchmark": "DABstep (Data Agent Benchmark for Multi-step Reasoning), Adyen + Hugging Face",
        "split": "dev",
        "n_tasks": len(tasks),
        "n_by_level": {lvl: sum(1 for t in tasks if t["level"] == lvl) for lvl in LEVELS},
        "tasks_sha256": sha256(Path(args.tasks)),
        "scorer": {
            "source": "huggingface.co/spaces/adyen/DABstep @ d4431c2e4a695cbe43c33aab2adaa304a37ae64a",
            "files": {
                p: sha256(HERE / "vendor" / p)
                for p in ("dabstep_benchmark/evaluation/scorer.py", "dabstep_benchmark/utils.py")
            },
            "entrypoint": "dabstep_benchmark.utils.evaluate -> dabstep_benchmark.evaluation.scorer.question_scorer(agent_answer, ground_truth)",
        },
        "config": json.loads(Path(args.config).read_text()) if args.config else None,
        "runs": per_run,
        "summary_complete_runs": {"n_runs": len(complete)} | summary,
        "solved_any_every": by_level_any_all,
        "tasks": task_rows,
        "cost": cost,
        "timing": timing,
    }
    if args.pilot:
        p_recs = latest(load_jsonl(args.pilot))
        p_runs, p_tasks = score_records(p_recs, [t for t in tasks if any(k[1] == str(t["task_id"]) for k in p_recs)], gt, "pilot")
        out["pilot"] = {"runs": p_runs, "tasks": {k: v for k, v in p_tasks.items() if v}}
    if args.reference:
        out["comparison"] = json.loads(Path(args.reference).read_text())
    if out["config"]:
        out["config"].pop("uploads", None)  # file ids are account-specific
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n")

    # ---- markdown tables for docs/evals/dabstep.md ---------------------------------------------
    n = out["n_by_level"]
    print(f"| Run | Easy (n={n['easy']}) | Hard (n={n['hard']}) | Overall (n={len(tasks)}) | Token cost | Sum of task wall time |")
    print("|---|---|---|---|---|---|")
    for r in per_run:
        c = r["correct"]
        print(
            f"| {r['run']}{'' if r['complete'] else ' (incomplete)'} | {c['easy']}/{r['n']['easy']} ({pct(r['accuracy']['easy'])}) "
            f"| {c['hard']}/{r['n']['hard']} ({pct(r['accuracy']['hard'])}) | {c['overall']}/{r['n']['overall']} ({pct(r['accuracy']['overall'])}) "
            f"| ${r['token_cost_usd']:.2f} | {r['sum_task_wall_s'] / 60:.1f} min |"
        )
    s = out["summary_complete_runs"]
    fmt = lambda d: "n/a" if d["mean"] is None else f"{100 * d['mean']:.1f}% ± {100 * (d['std'] or 0):.1f} (min {100 * d['min']:.1f}, max {100 * d['max']:.1f})"  # noqa: E731
    print(f"| Mean ± SD over {s['n_runs']} runs | {fmt(s['easy'])} | {fmt(s['hard'])} | {fmt(s['overall'])} | | |")
    print()
    print("| Task | Level | Ground truth | " + " | ".join(f"Run {r['run']}" for r in per_run) + " | Correct |")
    print("|---|---|---|" + "---|" * len(per_run) + "---|")
    for t in task_rows:
        cells = []
        by_run = {r["run"]: r for r in t["runs"]}
        for run in (pr["run"] for pr in per_run):
            r = by_run.get(run)
            if r is None:
                cells.append("not run")
                continue
            ans = r["agent_answer"] if len(r["agent_answer"]) <= 40 else r["agent_answer"][:37] + "..."
            mark = "pass" if r["score"] else "FAIL"
            lenient = "" if (not r["score"] or r["exact_match"]) else " (lenient)"
            cells.append(f"`{ans}` {mark}{lenient}")
        truth = t["ground_truth"] if len(t["ground_truth"]) <= 40 else t["ground_truth"][:37] + "..."
        print(f"| {t['task_id']} | {t['level']} | `{truth}` | " + " | ".join(cells) + f" | {t['correct_runs']}/{t['n_runs']} |")
    print()
    print(json.dumps({"cost": cost, "timing": timing, "solved_any_every": by_level_any_all}, indent=1))


if __name__ == "__main__":
    main()
