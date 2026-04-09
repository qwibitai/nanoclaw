#!/usr/bin/env python3
from __future__ import annotations

import json

from factory_gates import evaluate_factory_gates, first_issue_reason
from factory_lib import load_json, repo_root, run_state_path

root = repo_root()
run_state = load_json(run_state_path(root), default={})
if not run_state:
    print(json.dumps({"continue": True}))
    raise SystemExit(0)

phase = run_state.get("phase")
if phase in {"planning", "decomposing", "awaiting-approval", "blocked", "pr-ready", "done"}:
    print(json.dumps({"continue": True}))
    raise SystemExit(0)

report = evaluate_factory_gates(root, allow_missing_run=True)
if not report["ok"]:
    print(json.dumps({"decision": "block", "reason": first_issue_reason(report)}))
    raise SystemExit(0)

print(json.dumps({"continue": True}))
