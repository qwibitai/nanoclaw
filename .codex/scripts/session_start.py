#!/usr/bin/env python3
from __future__ import annotations

import json
from factory_lib import load_json, read_hook_input, repo_root, run_state_path
from stage_playbook import render_stage_context

payload = read_hook_input()
root = repo_root()
run_state = load_json(run_state_path(root), default={})
context = [
    "Factory mode: planning -> decomposition -> approval -> implementation -> testing -> verify -> review -> functional check -> PR-ready.",
    "Use WORKFLOW.md, docs/FACTORY.md, and docs/QUALITY.md as the operating contract.",
    "The repo must work with plain Codex and with OpenClaw ACP/ACPX; do not assume ACP is always present.",
    "Treat docs/product/BRIEF.md, docs/architecture, and docs/decisions as the source of truth for product and architecture context.",
]
if run_state:
    context.append(f"Active issue: {run_state.get('issue_key')} — {run_state.get('title')}")
    context.append(f"Current phase: {run_state.get('phase')}")
    context.append(f"Plan status: {run_state.get('plan_status')}")
    context.append(f"Decomposition status: {run_state.get('decomposition_status')}")
context.append(render_stage_context(run_state))
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n".join(context)
    }
}))
