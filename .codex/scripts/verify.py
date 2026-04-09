#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from factory_lib import dump_json, now_iso, repo_root, run_cmd, run_state_path, verify_state_path, load_json

parser = argparse.ArgumentParser(description="Run deterministic validation sequence")
parser.add_argument("--print-only", action="store_true", help="Only print the commands that would run")
args = parser.parse_args()

root = repo_root()
commands = [
    (
        "structural",
        os.environ.get("FACTORY_STRUCTURAL_CMD")
        or "npm run format:check",
    ),
    ("typecheck", os.environ.get("FACTORY_TYPECHECK_CMD") or "npm run typecheck"),
    ("tests", os.environ.get("FACTORY_TEST_CMD") or "npm test"),
]

results = []
all_ok = True
for phase, command in commands:
    if args.print_only:
        print(f"{phase}: {command}")
        continue
    result = run_cmd(command, root)
    result["phase"] = phase
    results.append(result)
    if result["exit_code"] != 0:
        all_ok = False
        break

if args.print_only:
    raise SystemExit(0)

state = load_json(run_state_path(root), default={})
verify = {
    "ok": all_ok,
    "completed_at": now_iso(),
    "results": results,
}
dump_json(verify_state_path(root), verify)
if state:
    state["verify_status"] = "passed" if all_ok else "failed"
    state["updated_at"] = now_iso()
    dump_json(run_state_path(root), state)

if not all_ok:
    failed = next((item for item in results if item["exit_code"] != 0), None)
    print(f"Verification failed at {failed['phase']}: {failed['command']}")
    raise SystemExit(1)

print("Verification passed")
