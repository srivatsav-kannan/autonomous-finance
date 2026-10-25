"""Score one run: the benchmark's official scorer plus extended metrics.

    python -I score.py <bench_dir> <run_out_dir>

Reads <run_out_dir>/submission.csv and suspicious_documents.json, runs
<bench_dir>/scripts/score_submission.py on the submission (output saved verbatim to
official_score.txt), then writes score.json with:
  - official: the scorer's headline numbers (net spend per customer, $0.01 tolerance)
  - fields: per-field exact matches (count, gross, credit, net) against customer_totals.csv
  - traps: per traps.json document, expected vs applied treatment
  - false_exclusions: documents the answer key counts (valid invoices, credit memos) that the
    submission marked excluded_from_spend
This file is run by the harness only; the model never sees it or the answer key.
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath

RANK = {"counted_with_flag": 1, "subtracted_as_credit": 2, "excluded_from_spend": 3}


def money(v: str | None) -> Decimal | None:
    if v is None:
        return None
    try:
        return Decimal(v.strip().replace("$", "").replace(",", "")).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def norm_path(p: str) -> str:
    p = p.strip().replace("\\", "/")
    for prefix in ("./", "/", "workspace/"):
        while p.startswith(prefix):
            p = p[len(prefix):]
    return p


def parse_official(text: str) -> dict:
    out: dict = {}
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) == 2 and parts[0] in {
            "customers_scored", "customers_exact", "customer_accuracy", "total_absolute_error_usd",
            "missing_customers", "unexpected_customers",
        }:
            out[parts[0]] = float(parts[1]) if parts[0] in {"customer_accuracy", "total_absolute_error_usd"} else int(parts[1])
    return out


def main() -> None:
    bench, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    sub_csv = out_dir / "submission.csv"
    result: dict = {"run_out_dir": str(out_dir)}
    if not sub_csv.exists():
        result["error"] = "no submission.csv"
        (out_dir / "score.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return

    proc = subprocess.run(
        [sys.executable, "-I", str(bench / "scripts" / "score_submission.py"), str(sub_csv)],
        capture_output=True, text=True, check=False,
    )
    (out_dir / "official_score.txt").write_text(proc.stdout + (("\nSTDERR:\n" + proc.stderr) if proc.stderr else ""))
    result["official"] = parse_official(proc.stdout)
    result["official_returncode"] = proc.returncode

    key_dir = bench / "answer_key"
    with (key_dir / "customer_totals.csv").open(newline="", encoding="utf-8-sig") as f:
        expected = {r["customer_id"]: r for r in csv.DictReader(f)}
    with sub_csv.open(newline="", encoding="utf-8-sig") as f:
        actual = {(r.get("customer_id") or "").strip(): r for r in csv.DictReader(f)}

    fields = {"valid_invoice_count": 0, "gross_invoice_spend_usd": 0, "credit_memo_total_usd": 0, "net_spend_usd": 0}
    all_exact = 0
    per_customer = []
    for cid, exp in expected.items():
        act = actual.get(cid)
        row = {"customer_id": cid}
        ok_all = True
        for k in fields:
            if act is None:
                ok = False
                row[k] = {"expected": exp[k], "actual": None}
            elif k == "valid_invoice_count":
                try:
                    ok = int(str(act.get(k, "")).strip()) == int(exp[k])
                except ValueError:
                    ok = False
                row[k] = {"expected": exp[k], "actual": act.get(k)}
            else:
                a, e = money(act.get(k)), money(exp[k])
                ok = a is not None and e is not None and abs(a - e) <= Decimal("0.01")
                row[k] = {"expected": exp[k], "actual": act.get(k)}
            fields[k] += int(ok)
            ok_all = ok_all and ok
            row[k]["ok"] = ok
        all_exact += int(ok_all)
        per_customer.append(row)
    result["fields"] = {"customers": len(expected), **{f"{k}_exact": v for k, v in fields.items()}, "all_four_exact": all_exact}
    result["per_customer"] = per_customer

    # Applied treatment per document, from the suspicious-documents list.
    susp_path = out_dir / "suspicious_documents.json"
    suspicious = json.loads(susp_path.read_text()) if susp_path.exists() else []
    with (key_dir / "invoices.csv").open(newline="", encoding="utf-8-sig") as f:
        key_docs = list(csv.DictReader(f))
    known_paths = {r["file_path"] for r in key_docs} | {"bank_exports/deposits_2025_q4.csv"}
    by_base: dict[str, list[str]] = {}
    for p in known_paths:
        by_base.setdefault(PurePosixPath(p).name, []).append(p)

    applied: dict[str, str] = {}
    unmatched = []
    for d in suspicious:
        p = norm_path(str(d.get("path", "")))
        target = p if p in known_paths else None
        if target is None:
            cands = by_base.get(PurePosixPath(p).name, [])
            target = cands[0] if len(cands) == 1 else None
        if target is None:
            unmatched.append({"path": d.get("path"), "treatment": d.get("treatment"), "category": d.get("category")})
            continue
        t = d.get("treatment", "")
        if RANK.get(t, 0) > RANK.get(applied.get(target, ""), 0):
            applied[target] = t

    exp_credit = {cid: money(r["credit_memo_total_usd"]) for cid, r in expected.items()}
    act_credit = {cid: money(r.get("credit_memo_total_usd")) for cid, r in actual.items()}
    policy = {r["file_path"]: r for r in key_docs}

    traps = json.loads((key_dir / "traps.json").read_text(encoding="utf-8-sig"))
    trap_rows = []
    for trap in traps:
        docs = []
        for p in trap["documents"]:
            t = applied.get(p)
            row = policy.get(p)
            if p.endswith(".csv"):
                expected_t, ok = "excluded_from_spend (listed)", t == "excluded_from_spend"
            elif row and row["policy"] == "include":
                expected_t, ok = "counted", t != "excluded_from_spend"
            elif row and row["policy"] == "credit_memo":
                cid = row["customer_id"]
                credit_ok = act_credit.get(cid) is not None and exp_credit.get(cid) is not None and abs(act_credit[cid] - exp_credit[cid]) <= Decimal("0.01")
                expected_t, ok = "subtracted_as_credit", t in (None, "subtracted_as_credit") and credit_ok
            else:
                expected_t, ok = "excluded_from_spend", t == "excluded_from_spend"
            docs.append({"document": p, "expected": expected_t, "applied": t or "(not listed)", "ok": ok})
        trap_rows.append({"trap_id": trap["trap_id"], "ok": all(d["ok"] for d in docs), "documents": docs})
    doc_total = sum(len(t["documents"]) for t in trap_rows)
    doc_ok = sum(d["ok"] for t in trap_rows for d in t["documents"])
    result["traps"] = {
        "trap_entries": len(trap_rows),
        "trap_entries_ok": sum(t["ok"] for t in trap_rows),
        "trap_documents": doc_total,
        "trap_documents_ok": doc_ok,
        "detail": trap_rows,
    }

    false_excl = [
        {"document": p, "answer_key_policy": policy[p]["policy"]}
        for p, t in sorted(applied.items())
        if t == "excluded_from_spend" and p in policy and policy[p]["policy"] in ("include", "credit_memo")
    ]
    flagged_valid = [p for p, t in sorted(applied.items()) if t == "counted_with_flag" and p in policy and policy[p]["policy"] == "include"]
    result["false_exclusions"] = {"count": len(false_excl), "documents": false_excl}
    result["flagged_but_counted_valid_invoices"] = flagged_valid
    result["suspicious_entries"] = len(suspicious)
    result["suspicious_unmatched_to_key"] = unmatched

    (out_dir / "score.json").write_text(json.dumps(result, indent=2) + "\n")
    o = result["official"]
    print(
        f"official: {o.get('customers_exact')}/{o.get('customers_scored')} customers exact (acc {o.get('customer_accuracy')}), "
        f"abs err ${o.get('total_absolute_error_usd')} | all-4-fields exact {all_exact}/{len(expected)} | "
        f"traps {result['traps']['trap_entries_ok']}/{len(trap_rows)} entries, {doc_ok}/{doc_total} docs | "
        f"false exclusions {len(false_excl)}"
    )


if __name__ == "__main__":
    main()
