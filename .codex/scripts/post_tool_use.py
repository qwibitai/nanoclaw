#!/usr/bin/env python3
from __future__ import annotations

import json

from factory_lib import now_iso, read_hook_input, repo_root

payload = read_hook_input()
root = repo_root()
history_path = root / ".factory" / "tool-history.jsonl"
command = ((payload.get("tool_input") or {}).get("command") or "").strip()
response = payload.get("tool_response")
parsed = response
if isinstance(response, str):
    try:
        parsed = json.loads(response)
    except json.JSONDecodeError:
        parsed = {"raw": response}
record = {
    "recorded_at": now_iso(),
    "command": command,
    "response": parsed,
}
history_path.parent.mkdir(parents=True, exist_ok=True)
with history_path.open("a") as fh:
    fh.write(json.dumps(record) + "\n")

exit_code = None
if isinstance(parsed, dict):
    exit_code = parsed.get("exitCode")
    if exit_code is None:
        exit_code = parsed.get("exit_code")

if exit_code not in (None, 0):
    print(json.dumps({
        "decision": "block",
        "reason": f"Command failed ({exit_code}). Fix the failure before continuing.",
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "Keep the fix scoped. Re-run deterministic verification after correcting the failing command.",
        }
    }))
else:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "Update factory artifacts if this command materially changed verification state or review status.",
        }
    }))
