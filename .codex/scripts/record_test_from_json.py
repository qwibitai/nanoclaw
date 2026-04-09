#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from factory_lib import dump_json, load_json, now_iso, repo_root, run_state_path, tests_state_path


def ensure_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(value)]


parser = argparse.ArgumentParser(description="Record a testing artifact from structured JSON")
parser.add_argument("--kind", required=True, choices=["automated", "functional"])
parser.add_argument("--input", help="Path to test-result JSON. If omitted, read from stdin.")
args = parser.parse_args()

if args.input:
    payload = json.loads(Path(args.input).read_text())
else:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("Expected JSON on stdin or via --input")
    payload = json.loads(raw)

root = repo_root()
path = tests_state_path(root)
existing = load_json(path, default={}) or {}
entry = dict(payload)
for key in (
    "blocking_findings",
    "non_blocking_findings",
    "remaining_gaps",
    "residual_risks",
    "commands_run",
    "tests_added_or_updated",
    "manual_validation_steps",
    "reviewed_scope",
):
    entry[key] = ensure_list(payload.get(key))
entry["recorded_at"] = now_iso()
existing[args.kind] = entry
existing["updated_at"] = now_iso()
dump_json(path, existing)
state = load_json(run_state_path(root), default={})
if state:
    state["tests_status"] = "recorded"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)
print(f"Recorded {args.kind} testing artifact")
