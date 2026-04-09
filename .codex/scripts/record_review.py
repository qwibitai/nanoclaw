#!/usr/bin/env python3
from __future__ import annotations

import argparse
from factory_lib import dump_json, load_json, now_iso, repo_root, review_dir, run_state_path

parser = argparse.ArgumentParser(description="Record a review result")
parser.add_argument("--aspect", required=True, choices=["quality", "performance", "security"])
parser.add_argument("--score", required=True, type=int)
parser.add_argument("--summary", required=True)
parser.add_argument("--blocking-finding", action="append", default=[])
parser.add_argument("--non-blocking-finding", action="append", default=[])
parser.add_argument("--residual-risk", action="append", default=[])
parser.add_argument("--recommendation", default="approve-with-caveats")
parser.add_argument("--reviewed-scope", action="append", default=[])
# Backward-compatible aliases.
parser.add_argument("--blocking", action="append", default=[])
parser.add_argument("--warning", action="append", default=[])
args = parser.parse_args()

root = repo_root()
path = review_dir(root) / f"{args.aspect}.json"
blocking_findings = args.blocking_finding + args.blocking
non_blocking_findings = args.non_blocking_finding + args.warning
review = {
    "aspect": args.aspect,
    "score": args.score,
    "summary": args.summary,
    "blocking_findings": blocking_findings,
    "non_blocking_findings": non_blocking_findings,
    "residual_risks": args.residual_risk,
    "recommendation": args.recommendation,
    "reviewed_scope": args.reviewed_scope,
    # Legacy aliases for older scripts and docs.
    "blocking": blocking_findings,
    "warnings": non_blocking_findings,
    "recorded_at": now_iso(),
}
dump_json(path, review)
state = load_json(run_state_path(root), default={})
if state:
    state["review_status"] = "in-progress"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
print(f"Recorded {args.aspect} review")
