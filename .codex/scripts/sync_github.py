#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description="Sync factory status to GitHub via gh")
parser.add_argument("--repo", required=True)
parser.add_argument("--issue")
parser.add_argument("--pr")
parser.add_argument("--body-file", required=True)
args = parser.parse_args()

body_file = Path(args.body_file)
if not body_file.exists():
    raise SystemExit(f"Missing body file: {body_file}")
if args.pr:
    cmd = ["gh", "pr", "comment", args.pr, "--repo", args.repo, "--body-file", str(body_file)]
elif args.issue:
    cmd = ["gh", "issue", "comment", args.issue, "--repo", args.repo, "--body-file", str(body_file)]
else:
    raise SystemExit("Provide --issue or --pr")
subprocess.run(cmd, check=True)
print("GitHub sync complete")
