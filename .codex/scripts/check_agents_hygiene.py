#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
agents = root / "AGENTS.md"
text = agents.read_text()
lines = text.splitlines()
required_markers = [
    "## What This Repo Is",
    "## Mandatory Read Order",
    "## Runtime Modes",
    "## Hard Gates",
]
missing = [marker for marker in required_markers if marker not in text]
if len(lines) > 110:
    print(f"AGENTS.md is too long: {len(lines)} lines (max 110)")
    sys.exit(1)
if len(text.encode()) > 7000:
    print(f"AGENTS.md is too large: {len(text.encode())} bytes (max 7000)")
    sys.exit(1)
if missing:
    print("AGENTS.md is missing required sections:")
    for marker in missing:
        print(f"- {marker}")
    sys.exit(1)
for linked in ["WORKFLOW.md", "docs/FACTORY.md", "docs/QUALITY.md"]:
    if linked not in text:
        print(f"AGENTS.md must reference {linked}")
        sys.exit(1)
print("AGENTS hygiene OK")
