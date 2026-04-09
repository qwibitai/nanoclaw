#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import dump_json, load_json, now_iso, repo_root, run_state_path, tests_state_path

parser = argparse.ArgumentParser(description="Record a testing artifact")
parser.add_argument("--kind", required=True, choices=["automated", "functional"])
parser.add_argument("--status", required=True, choices=["passed", "failed", "partial"])
parser.add_argument("--summary", required=True)
parser.add_argument("--score", type=int)
parser.add_argument("--command", action="append", default=[])
parser.add_argument("--test-change", action="append", default=[])
parser.add_argument("--manual-step", action="append", default=[])
parser.add_argument("--blocking-finding", action="append", default=[])
parser.add_argument("--non-blocking-finding", action="append", default=[])
parser.add_argument("--remaining-gap", action="append", default=[])
parser.add_argument("--residual-risk", action="append", default=[])
parser.add_argument("--reviewed-scope", action="append", default=[])
parser.add_argument("--pass-fail-summary")
parser.add_argument("--recommendation")
args = parser.parse_args()

root = repo_root()
path = tests_state_path(root)
existing = load_json(path, default={}) or {}
entry = {
    "status": args.status,
    "summary": args.summary,
    "score": args.score,
    "commands_run": args.command,
    "tests_added_or_updated": args.test_change,
    "manual_validation_steps": args.manual_step,
    "blocking_findings": args.blocking_finding,
    "non_blocking_findings": args.non_blocking_finding,
    "remaining_gaps": args.remaining_gap,
    "residual_risks": args.residual_risk,
    "reviewed_scope": args.reviewed_scope,
    "pass_fail_summary": args.pass_fail_summary,
    "recommendation": args.recommendation,
    "recorded_at": now_iso(),
}
existing[args.kind] = entry
existing["updated_at"] = now_iso()
dump_json(path, existing)
state = load_json(run_state_path(root), default={})
if state:
    state["tests_status"] = "recorded"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
print(f"Recorded {args.kind} test result")
