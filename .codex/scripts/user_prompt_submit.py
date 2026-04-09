#!/usr/bin/env python3
from __future__ import annotations

import json
from factory_lib import load_json, read_hook_input, repo_root, run_state_path
from stage_playbook import render_stage_context

payload = read_hook_input()
prompt = (payload.get("prompt") or "").lower()
run_state = load_json(run_state_path(repo_root()), default={})
needs_build = any(word in prompt for word in ["implement", "build", "code", "fix", "ship"])
if needs_build and not run_state:
    print(json.dumps({"decision": "block", "reason": "No factory state found. Run intake, planning, and decomposition before implementation."}))
    raise SystemExit(0)
if needs_build and run_state.get("plan_status") in {"needs-plan", "awaiting-approval"}:
    print(json.dumps({"decision": "block", "reason": "Implementation is blocked until the plan is approved."}))
    raise SystemExit(0)
if needs_build and run_state.get("decomposition_status") != "recorded":
    print(json.dumps({"decision": "block", "reason": "Implementation is blocked until decomposition is recorded."}))
    raise SystemExit(0)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": (
            "If the request is vague, convert it into acceptance criteria and capability-driven task decomposition before coding. "
            "Use the planner and decomposer prompts rather than improvising the task graph inline.\n"
            + render_stage_context(run_state)
        ),
    }
}))
