#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import dump_json, ensure_issue_key, now_iso, repo_root, run_state_path, slugify

parser = argparse.ArgumentParser(description="Initialize factory run state")
parser.add_argument("--issue", help="Linear issue key, e.g. ENG-123")
parser.add_argument("--title", required=True, help="Issue or feature title")
parser.add_argument("--tracker", default="linear")
parser.add_argument("--branch")
args = parser.parse_args()

root = repo_root()
issue_key = ensure_issue_key(args.issue, root)
branch = args.branch or f"feat/{issue_key}-{slugify(args.title)}"
state = {
    "issue_key": issue_key,
    "title": args.title,
    "tracker": args.tracker,
    "branch": branch,
    "phase": "planning",
    "plan_status": "needs-plan",
    "decomposition_status": "pending",
    "implementation_status": "pending",
    "tests_status": "pending",
    "verify_status": "pending",
    "review_status": "pending",
    "created_at": now_iso(),
    "updated_at": now_iso(),
}
dump_json(run_state_path(root), state)
print(f"Initialized factory state for {issue_key} -> {branch}")
