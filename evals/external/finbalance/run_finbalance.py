#!/usr/bin/env python3
"""Run FinBalance (arXiv 2606.15949) against Claude through the official harness.

Subcommands
-----------
select   Build the deterministic stratified sample (record-ID files) from data/main.
run      Evaluate one FinBalance ablation spec (prompt_baseline, forced_ledger_verifier)
         over a record-ID file with N concurrent workers, a hard spend cap, and resume.

Everything that defines the benchmark comes from the upstream package, unmodified:
prompt construction (`build_prompt`), the per-record loop including the ledger-feedback
protocol (`run_ablation_evaluation`), JSON parsing (`parse_submission`), scoring
(`analyze_submission`), summaries (`summarize_ablation_results`) and the output layout
(`write_ablation_outputs`). This wrapper only adds the Claude client, concurrency
(one `run_ablation_evaluation` call per record), checkpointing and the budget guard.

Run with the FinBalance checkout's virtualenv, e.g.
    $FINBALANCE/.venv/bin/python run_finbalance.py run --help
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from finbalance.benchmark.ablations import (
    FatalAblationRunError,
    run_ablation_evaluation,
    select_ablation_specs,
    summarize_ablation_results,
    write_ablation_outputs,
)
from finbalance.benchmark.dataset import load_records
from finbalance.generation.helpers import PERIOD_TYPES
from finbalance.industry_schemas import INDUSTRIES
from finbalance.inconsistencies import INCONSISTENCY_CODES

sys.path.insert(0, str(Path(__file__).resolve().parent))
from anthropic_client import AnthropicChatClient, BudgetExceeded, SpendLedger, load_api_key  # noqa: E402


# --------------------------------------------------------------------------- select


def select_sample(
    dataset: str,
    *,
    per_cell: int,
    negatives: int,
    ablation_standard: int,
    ablation_negatives: int,
    seed: int,
) -> dict[str, Any]:
    """Stratified sample of the main split.

    Standard records: `per_cell` records in every (difficulty level x period type)
    cell, each from a different industry; industries rotate across cells so every
    level sees all eight industries and industry totals differ by at most one.
    Within an (industry, period, level) cell the record is drawn uniformly from the
    four main-split records. Negative controls: equal full rounds over the 23
    inconsistency codes (main has ten per code), with any remainder going to codes
    drawn without replacement; records within a code are drawn without replacement.
    The ledger-feedback subset is drawn from that sample.
    """

    records = load_records(dataset)
    rng = random.Random(seed)
    standard_by_cell: dict[tuple[int, str, str], list[str]] = defaultdict(list)
    negatives_by_code: dict[str, list[str]] = defaultdict(list)
    for record in records:
        if record.expected_inconsistency:
            negatives_by_code[record.expected_inconsistency_codes[0]].append(record.record_id)
        else:
            key = (record.difficulty_level, str(record.metadata.get("period_type")), record.industry)
            standard_by_cell[key].append(record.record_id)

    standard: list[dict[str, Any]] = []
    cell_index = 0
    for level in range(1, 6):
        for period in PERIOD_TYPES:
            for offset in range(per_cell):
                industry = INDUSTRIES[(per_cell * cell_index + offset) % len(INDUSTRIES)]
                candidates = sorted(standard_by_cell[(level, period, industry)])
                standard.append(
                    {
                        "record_id": rng.choice(candidates),
                        "difficulty_level": level,
                        "period_type": period,
                        "industry": industry,
                    }
                )
            cell_index += 1

    codes = list(INCONSISTENCY_CODES)
    full_rounds, remainder = divmod(negatives, len(codes))
    chosen_codes = codes * full_rounds + rng.sample(codes, remainder)
    negative_rows: list[dict[str, Any]] = []
    used: set[str] = set()
    for code in chosen_codes:
        candidates = sorted(rid for rid in negatives_by_code[code] if rid not in used)
        record_id = rng.choice(candidates)
        used.add(record_id)
        negative_rows.append({"record_id": record_id, "expected_inconsistency_code": code})

    # Ledger-feedback subset: standard records spread over levels, plus a few negatives.
    by_level: dict[int, list[str]] = defaultdict(list)
    for row in standard:
        by_level[row["difficulty_level"]].append(row["record_id"])
    ablation_ids: list[str] = []
    base, extra = divmod(ablation_standard, 5)
    for level in range(1, 6):
        take = base + (1 if level > 5 - extra else 0)  # extra records go to the hardest levels
        ablation_ids += rng.sample(by_level[level], take)
    ablation_ids += rng.sample([row["record_id"] for row in negative_rows], ablation_negatives)

    order = {record.record_id: index for index, record in enumerate(records)}
    main_ids = sorted({row["record_id"] for row in standard} | {row["record_id"] for row in negative_rows}, key=order.get)
    return {
        "dataset": dataset,
        "seed": seed,
        "per_cell": per_cell,
        "standard": standard,
        "negatives": negative_rows,
        "record_ids": main_ids,
        "ablation_record_ids": sorted(ablation_ids, key=order.get),
        "counts": {
            "standard": len(standard),
            "negatives": len(negative_rows),
            "total": len(main_ids),
            "standard_by_level": dict(Counter(row["difficulty_level"] for row in standard)),
            "standard_by_period": dict(Counter(row["period_type"] for row in standard)),
            "standard_by_industry": dict(Counter(row["industry"] for row in standard)),
            "ablation_total": len(ablation_ids),
        },
    }


# --------------------------------------------------------------------------- run


def _load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _is_api_error(row: dict[str, Any]) -> bool:
    """True when no completion came back (transport/API failure), not a model failure."""

    return bool(row.get("error")) and not row.get("usage") and not str(row.get("raw_response") or "").strip()


def run(args: argparse.Namespace) -> int:
    spec = select_ablation_specs(matrix="targeted", names=[args.ablation])[0]
    all_records = load_records(args.dataset)
    order = {record.record_id: index for index, record in enumerate(all_records)}
    wanted = json.loads(Path(args.record_ids_file).read_text(encoding="utf-8"))
    if isinstance(wanted, dict):
        wanted = wanted[args.record_ids_key]
    wanted_set = set(wanted)
    records = [record for record in all_records if record.record_id in wanted_set]
    missing = wanted_set - {record.record_id for record in records}
    if missing:
        raise SystemExit(f"record ids not found in dataset: {sorted(missing)[:5]}")
    if args.limit:
        records = records[: args.limit]

    output_root = Path(args.output_dir)
    ablation_dir = output_root / spec.name
    checkpoint_path = ablation_dir / "_checkpoint_rows.jsonl"
    run_log_path = ablation_dir / "_run_sessions.jsonl"
    ablation_dir.mkdir(parents=True, exist_ok=True)

    existing = {row["record_id"]: row for row in _load_rows(checkpoint_path)}
    todo = []
    for record in records:
        row = existing.get(record.record_id)
        if row is None or (args.retry_api_errors and _is_api_error(row)):
            todo.append(record)
    print(
        json.dumps(
            {
                "ablation": spec.name,
                "selected_records": len(records),
                "already_done": len(records) - len(todo),
                "to_run": len(todo),
                "concurrency": args.concurrency,
                "model": args.model,
                "effort": args.effort,
                "max_output_tokens": args.max_output_tokens,
            }
        ),
        flush=True,
    )

    ledger = SpendLedger(args.ledger, args.budget_cap)
    client = AnthropicChatClient(
        api_key=load_api_key(args.env_file),
        model=args.model,
        effort=args.effort,
        ledger=ledger,
        run_label=f"{output_root.name}/{spec.name}",
        sdk_max_retries=args.sdk_max_retries,
        stream_retries=args.stream_retries,
        cache_first_user_message=spec.tool_variant != "no_tools",
    )

    lock = threading.Lock()
    stop = threading.Event()
    fatal: list[str] = []
    session_started = datetime.now(timezone.utc).isoformat()
    wall_start = time.monotonic()
    completed = 0

    def work(record) -> dict[str, Any] | None:
        if stop.is_set():
            return None
        client.set_record_context(record.record_id)
        evaluation = run_ablation_evaluation(
            [record],
            client=client,
            dataset_path=args.dataset,
            spec=spec,
            backend_name="anthropic",
            temperature=0.0,
            max_tokens=args.max_output_tokens,
            timeout=args.timeout,
            agent_max_steps=8,
        )
        return evaluation["results"][0]

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        pending = set()
        queue = list(todo)
        while queue or pending:
            while queue and len(pending) < args.concurrency and not stop.is_set():
                record = queue.pop(0)
                future = pool.submit(work, record)
                future.record_id = record.record_id  # type: ignore[attr-defined]
                pending.add(future)
            if not pending:
                break
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                record_id = future.record_id  # type: ignore[attr-defined]
                try:
                    row = future.result()
                except FatalAblationRunError as exc:
                    stop.set()
                    fatal.append(str(exc))
                    print(f"[fatal] {record_id}: {exc}", flush=True)
                    continue
                except Exception as exc:  # outside the harness's own try/except; keep going, no row
                    print(f"[error] {record_id}: {type(exc).__name__}: {exc}", flush=True)
                    continue
                if row is None:
                    continue
                row["api_error"] = _is_api_error(row)
                with lock:
                    existing[record_id] = row
                    with checkpoint_path.open("a", encoding="utf-8") as handle:
                        handle.write(json.dumps(row) + "\n")
                    completed += 1
                metrics = row["metrics"]
                print(
                    json.dumps(
                        {
                            "done": completed,
                            "of": len(todo),
                            "record_id": record_id,
                            "level": row["difficulty_level"],
                            "neg": metrics["expected_inconsistency"],
                            "parse": metrics["parse_success"],
                            "bs_exact": metrics["final_balance_sheet_matches"],
                            "bs_recon": metrics["predicted_entries_reconstruct_correct_final_balance_sheet"],
                            "inc_code": metrics["inconsistency_code_matches"] if metrics["expected_inconsistency"] else None,
                            "out_tok": row["completion_tokens"],
                            "cost": round(row["cost"], 4),
                            "spent_total": round(ledger.spent, 4),
                            "api_error": row["api_error"],
                            "error": (row.get("error") or "")[:120],
                        }
                    ),
                    flush=True,
                )
            if stop.is_set():
                queue.clear()

    wall_seconds = round(time.monotonic() - wall_start, 1)
    with run_log_path.open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "session_started": session_started,
                    "session_completed": datetime.now(timezone.utc).isoformat(),
                    "wall_seconds": wall_seconds,
                    "records_completed": completed,
                    "concurrency": args.concurrency,
                    "fatal": fatal,
                    "ledger_spent_after": round(ledger.spent, 6),
                }
            )
            + "\n"
        )

    # Official summary + output layout over every row we have for the selected records.
    rows = sorted(
        (existing[record.record_id] for record in records if record.record_id in existing),
        key=lambda row: order[row["record_id"]],
    )
    sessions = _load_rows(run_log_path)
    evaluation = {
        "dataset_path": args.dataset,
        "model": client.model,
        "backend": "anthropic",
        "ablation_name": spec.name,
        "prompt_variant": spec.prompt_variant,
        "visibility_variant": spec.visibility_variant,
        "tool_variant": spec.tool_variant,
        "reasoning_effort": args.effort,
        "agent_max_steps": 8,
        "run_started_at": sessions[0]["session_started"] if sessions else session_started,
        "run_completed_at": datetime.now(timezone.utc).isoformat(),
        "temperature": None,
        "temperature_note": "not sent; claude-opus-5-5 rejects sampling parameters",
        "max_tokens": args.max_output_tokens,
        "timeout": args.timeout,
        "wall_seconds_total": round(sum(float(s.get("wall_seconds", 0.0)) for s in sessions), 1),
        "summary": summarize_ablation_results(rows),
        "results": rows,
    }
    out = write_ablation_outputs(evaluation, output_root)
    summary = evaluation["summary"]
    print(
        json.dumps(
            {
                "output_dir": str(out),
                "records": summary["records_evaluated"],
                "parse_success_rate": summary["parse_success_rate"],
                "final_balance_sheet_matches_rate": summary["final_balance_sheet_matches_rate"],
                "predicted_entries_reconstruct_correct_final_balance_sheet_rate": summary[
                    "predicted_entries_reconstruct_correct_final_balance_sheet_rate"
                ],
                "inconsistency_code_match_rate": summary["inconsistency_code_match_rate"],
                "api_error_rows": sum(1 for row in rows if row.get("api_error")),
                "cost_total_rows": summary["cost_total"],
                "ledger_spent_total": round(ledger.spent, 4),
                "session_wall_seconds": wall_seconds,
            },
            indent=2,
        ),
        flush=True,
    )
    if fatal:
        print("Run stopped early: " + fatal[0], flush=True)
        return 2
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sel = sub.add_parser("select", help="write the stratified sample record-ID file")
    sel.add_argument("--dataset", required=True)
    sel.add_argument("--per-cell", type=int, default=4, help="standard records per (level x period) cell")
    sel.add_argument("--negatives", type=int, default=29)
    sel.add_argument("--ablation-standard", type=int, default=16)
    sel.add_argument("--ablation-negatives", type=int, default=4)
    sel.add_argument("--seed", type=int, default=42)
    sel.add_argument("--output", required=True)

    runp = sub.add_parser("run", help="evaluate one ablation spec over a record-ID file")
    runp.add_argument("--dataset", required=True)
    runp.add_argument("--record-ids-file", required=True)
    runp.add_argument("--record-ids-key", default="record_ids")
    runp.add_argument("--ablation", default="prompt_baseline", choices=["prompt_baseline", "forced_ledger_verifier"])
    runp.add_argument("--output-dir", required=True)
    runp.add_argument("--model", default="claude-opus-5-5")
    runp.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    runp.add_argument("--max-output-tokens", type=int, default=32000)
    runp.add_argument("--timeout", type=int, default=900)
    runp.add_argument("--concurrency", type=int, default=4)
    runp.add_argument("--limit", type=int, default=0)
    runp.add_argument("--sdk-max-retries", type=int, default=4)
    runp.add_argument("--stream-retries", type=int, default=2)
    runp.add_argument("--retry-api-errors", action="store_true", help="re-run rows that failed before any completion")
    runp.add_argument("--budget-cap", type=float, required=True, help="hard cap on cumulative ledger spend (USD)")
    runp.add_argument("--ledger", required=True, help="JSONL spend ledger shared by all runs")
    runp.add_argument("--env-file", help="dotenv file holding ANTHROPIC_API_KEY (used if the env var is unset)")

    args = parser.parse_args()
    if args.command == "select":
        sample = select_sample(
            args.dataset,
            per_cell=args.per_cell,
            negatives=args.negatives,
            ablation_standard=args.ablation_standard,
            ablation_negatives=args.ablation_negatives,
            seed=args.seed,
        )
        Path(args.output).write_text(json.dumps(sample, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(sample["counts"], indent=2))
        return 0
    try:
        return run(args)
    except BudgetExceeded as exc:  # raised outside the harness loop (should not happen)
        print(f"Budget stop: {exc}", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
