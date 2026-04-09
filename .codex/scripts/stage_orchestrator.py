#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from typing import Any

from factory_lib import load_json, repo_root, run_state_path
from stage_playbook import normalize_phase, render_stage_context, stage_spec_for_phase


def make_payload(run_state: dict[str, Any], phase_override: str | None) -> dict[str, Any]:
    phase = normalize_phase(phase_override or run_state.get("phase"))
    spec = stage_spec_for_phase(phase)
    return {
        "phase": phase,
        "issue_key": run_state.get("issue_key"),
        "title": run_state.get("title"),
        "goal": spec["goal"],
        "agents": spec.get("agents", []),
        "prompt": spec.get("prompt"),
        "commands": spec.get("commands", []),
        "next_transition": spec.get("next_transition"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Emit stage-specific orchestration guidance and subagent assignments.",
    )
    parser.add_argument("--phase", help="Override phase instead of reading .factory/run.json.")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of text.")
    args = parser.parse_args()

    root = repo_root()
    run_state = load_json(run_state_path(root), default={}) or {}
    if not run_state and not args.phase:
        message = (
            "No active factory run. Start with:\n"
            "- `python3 .codex/scripts/intake.py --issue ENG-123 --title \"Feature title\"`\n"
            "- then run planning (`planner-high`) and decomposition (`docs-decomposer`)."
        )
        if args.json:
            print(json.dumps({"ok": False, "message": message}, indent=2))
        else:
            print(message)
        return 1

    payload = make_payload(run_state, args.phase)
    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    rendered = render_stage_context(
        {
            "phase": payload["phase"],
            "issue_key": payload.get("issue_key"),
            "title": payload.get("title"),
        },
    )
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
