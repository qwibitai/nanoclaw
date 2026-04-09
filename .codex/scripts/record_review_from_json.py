#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root, review_dir, run_state_path


def ensure_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(value)]


parser = argparse.ArgumentParser(description="Record a review artifact from structured JSON")
parser.add_argument("--aspect", required=True, choices=["quality", "performance", "security"])
parser.add_argument("--input", help="Path to a JSON file. If omitted, read JSON from stdin.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text())
else:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
path = review_dir(root) / f"{args.aspect}.json"
blocking_findings = ensure_list(payload.get("blocking_findings", payload.get("blocking")))
non_blocking_findings = ensure_list(payload.get("non_blocking_findings", payload.get("warnings")))
residual_risks = ensure_list(payload.get("residual_risks"))
reviewed_scope = ensure_list(payload.get("reviewed_scope"))
review = {
    "aspect": args.aspect,
    "score": int(payload["score"]),
    "summary": str(payload["summary"]),
    "blocking_findings": blocking_findings,
    "non_blocking_findings": non_blocking_findings,
    "residual_risks": residual_risks,
    "recommendation": str(payload.get("recommendation", "approve-with-caveats")),
    "reviewed_scope": reviewed_scope,
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
print(f"Recorded {args.aspect} review from structured JSON")
