"""Extract text from every PDF in a run workspace with pypdf.

Writes <out_dir>/<relative path>.txt (one file per PDF, pages separated by
"=== Page N of M ===" markers) plus <out_dir>/_manifest.json. The workspace
itself is never modified. Usage:

    python -I extract_text.py <workspace_dir> <out_dir>
    python -I extract_text.py --compare <dir_a> <dir_b>   # text-level diff of two PDF trees
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from pypdf import PdfReader


def pdf_text(path: Path) -> tuple[str, int]:
    reader = PdfReader(str(path))
    pages = []
    total = len(reader.pages)
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").replace("\r\n", "\n").rstrip()
        pages.append(f"=== Page {i} of {total} ===\n{text}")
    return "\n\n".join(pages) + "\n", total


def extract(workspace: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for pdf in sorted(workspace.rglob("*.pdf")):
        rel = pdf.relative_to(workspace).as_posix()
        text, pages = pdf_text(pdf)
        target = out_dir / f"{rel}.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        manifest[rel] = {"pages": pages, "chars": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()}
    (out_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    chars = sum(v["chars"] for v in manifest.values())
    print(f"extracted {len(manifest)} PDFs, {chars} chars total -> {out_dir}")


def compare(a: Path, b: Path) -> None:
    names_a = sorted(p.relative_to(a).as_posix() for p in a.rglob("*.pdf"))
    names_b = sorted(p.relative_to(b).as_posix() for p in b.rglob("*.pdf"))
    if names_a != names_b:
        print("PDF file sets differ")
        sys.exit(1)
    differing = [n for n in names_a if pdf_text(a / n)[0] != pdf_text(b / n)[0]]
    print(f"compared {len(names_a)} PDFs; text differs in {len(differing)}")
    for n in differing[:20]:
        print("  DIFF", n)
    sys.exit(1 if differing else 0)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--compare":
        compare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif len(sys.argv) == 3:
        extract(Path(sys.argv[1]), Path(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
