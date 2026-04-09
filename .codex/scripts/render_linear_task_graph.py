#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from factory_lib import decomposition_state_path, repo_root

parser = argparse.ArgumentParser(description="Render a Linear-ready markdown task graph from decomposition.json")
parser.add_argument("--input", help="Path to decomposition JSON. Defaults to .factory/decomposition.json")
args = parser.parse_args()

root = repo_root()
path = Path(args.input) if args.input else decomposition_state_path(root)
if not path.exists():
    raise SystemExit(f"Missing decomposition file: {path}")

data = json.loads(path.read_text())
project = data.get("project", "unknown-project")
print(f"# Linear Task Graph — {project}\n")
for wave in data.get("build_waves", []):
    print(f"## {wave.get('id', 'wave')} — {wave.get('title', '')}".rstrip())
    for task_id in wave.get("task_ids", []):
        task = next((item for item in data.get("tasks", []) if item.get("id") == task_id), None)
        if not task:
            continue
        print(f"- [{task.get('id')}] {task.get('title')}")
        if task.get("linear_parent"):
            print(f"  - parent: {task['linear_parent']}")
        if task.get("dependencies"):
            deps = ", ".join(task["dependencies"])
            print(f"  - depends on: {deps}")
        if task.get("write_scope"):
            scope = ", ".join(task["write_scope"])
            print(f"  - write scope: {scope}")
    print()
