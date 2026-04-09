#!/usr/bin/env python3
from __future__ import annotations

import json
import re

from factory_lib import read_hook_input

payload = read_hook_input()
command = ((payload.get("tool_input") or {}).get("command") or "").strip()
command_lower = command.lower()
blocked = [
    r"\brm\s+-rf\b",
    r"\bgit\s+reset\s+--hard\b",
    r"\bgit\s+push\s+--force\b",
    r"\bterraform\s+destroy\b",
    r"\bkubectl\s+delete\b",
]
for pattern in blocked:
    if re.search(pattern, command):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Blocked by factory policy: {command}",
            }
        }))
        raise SystemExit(0)

check_bypass = [
    "pnpm test",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm check:all",
    "npm test",
    "npm run lint",
    "npm run typecheck",
    "npm run format:check",
    "npm run build",
    "npx vitest run",
    "npx tsc --noemit",
]
if any(token in command_lower for token in check_bypass) and ".codex/scripts/verify.py" not in command:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Use `python3 .codex/scripts/verify.py` so verification artifacts stay deterministic.",
        }
    }))
    raise SystemExit(0)

print(json.dumps({"systemMessage": "Factory policy check passed."}))
