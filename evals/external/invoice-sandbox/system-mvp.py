#!/usr/bin/env python3
"""Invoice MVP adapter. Historical systems A/B/C remain unchanged.

Use the same options as evals/invoice-mvp/run.py. All finance work goes through
B's product HTTP service and reads A's persisted Convex-derived snapshots.
"""
import runpy
from pathlib import Path
import sys
entry=Path(__file__).resolve().parents[2]/'invoice-mvp'/'run.py'
sys.path.insert(0,str(entry.parent))
runpy.run_path(str(entry),run_name='__main__')
