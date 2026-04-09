#!/usr/bin/env python3
from __future__ import annotations

import argparse

from factory_gates import evaluate_factory_gates, report_lines
from factory_lib import (
    dump_json,
    load_json,
    now_iso,
    repo_root,
    run_state_path,
)

parser = argparse.ArgumentParser(description="Mark the run as PR-ready when all gates pass.")
parser.add_argument(
    "--check-only",
    action="store_true",
    help="Validate readiness without mutating .factory/run.json.",
)
parser.add_argument(
    "--allow-missing-run",
    action="store_true",
    help="Do not fail when .factory/run.json is missing (template/scaffold mode).",
)
args = parser.parse_args()

root = repo_root()
report = evaluate_factory_gates(root, allow_missing_run=args.allow_missing_run)
if report.get("mode") == "no-active-run":
    print("No active run state found. Nothing to mark PR-ready.")
    raise SystemExit(0)

if not report["ok"]:
    print("PR not ready:")
    for line in report_lines(report):
        print(line)
    raise SystemExit(1)

if args.check_only:
    print("PR_READY_CHECK_PASSED")
    raise SystemExit(0)

run_state = load_json(run_state_path(root), default={}) or {}
run_state["phase"] = "pr-ready"
run_state["review_status"] = "passed"
run_state["tests_status"] = "passed"
run_state["updated_at"] = now_iso()
dump_json(run_state_path(root), run_state)
print("PR_READY")
