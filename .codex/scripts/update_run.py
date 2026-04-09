#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import dump_json, load_json, now_iso, repo_root, run_state_path

parser = argparse.ArgumentParser(description="Update factory run state")
parser.add_argument("--phase")
parser.add_argument("--plan-status")
parser.add_argument("--decomposition-status")
parser.add_argument("--implementation-status")
parser.add_argument("--tests-status")
parser.add_argument("--verify-status")
parser.add_argument("--review-status")
parser.add_argument("--pr-url")
args = parser.parse_args()

root = repo_root()
path = run_state_path(root)
state = load_json(path, default={})
if not state:
    raise SystemExit("Missing .factory/run.json. Run intake first.")
for key, value in {
    "phase": args.phase,
    "plan_status": args.plan_status,
    "decomposition_status": args.decomposition_status,
    "implementation_status": args.implementation_status,
    "tests_status": args.tests_status,
    "verify_status": args.verify_status,
    "review_status": args.review_status,
    "pr_url": args.pr_url,
}.items():
    if value:
        state[key] = value
state["updated_at"] = now_iso()
dump_json(path, state)
print("Updated factory state")
