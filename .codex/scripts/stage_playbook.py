#!/usr/bin/env python3
from __future__ import annotations

from typing import Any


StageSpec = dict[str, Any]


STAGE_PLAYBOOK: dict[str, StageSpec] = {
    "planning": {
        "goal": "Turn in-repo docs into an approved, decision-complete plan.",
        "agents": ["planner-high"],
        "prompt": ".codex/prompts/planner.md",
        "commands": [],
        "next_transition": "After human approval, update run state to `decomposing` and `plan_status=approved`.",
    },
    "decomposing": {
        "goal": "Produce capability-driven, bounded task graph from approved plan and docs.",
        "agents": ["docs-decomposer"],
        "prompt": ".codex/prompts/decomposer.md",
        "commands": [
            "python3 .codex/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json",
        ],
        "next_transition": "When decomposition is recorded and approved, set phase to `implementing`.",
    },
    "awaiting-approval": {
        "goal": "Pause for explicit human approval before any implementation.",
        "agents": [],
        "prompt": None,
        "commands": [],
        "next_transition": "Do not code. Wait for approval, then set phase appropriately.",
    },
    "implementing": {
        "goal": "Implement one bounded leaf task with tight diff scope.",
        "agents": [],
        "prompt": ".codex/prompts/implementer.md",
        "commands": [
            "python3 .codex/scripts/update_run.py --phase testing",
        ],
        "next_transition": "Once implementation for the leaf task is complete, move to `testing`.",
    },
    "testing": {
        "goal": "Run automated testing subagent and deterministic verify.",
        "agents": ["automated-tester"],
        "prompt": ".codex/prompts/tester-automated.md",
        "commands": [
            "python3 .codex/scripts/record_test_from_json.py --kind automated --input /tmp/automated-test.json",
            "python3 .codex/scripts/verify.py",
            "python3 .codex/scripts/update_run.py --phase reviewing",
        ],
        "next_transition": "Move to `reviewing` only after automated tests are recorded and verify passes.",
    },
    "reviewing": {
        "goal": "Run isolated parallel quality/performance/security review subagents.",
        "agents": ["quality-reviewer", "performance-reviewer", "security-reviewer"],
        "prompt": ".codex/prompts/review-orchestrator.md",
        "commands": [
            "python3 .codex/scripts/record_review_from_json.py --aspect quality --input /tmp/quality-review.json",
            "python3 .codex/scripts/record_review_from_json.py --aspect performance --input /tmp/performance-review.json",
            "python3 .codex/scripts/record_review_from_json.py --aspect security --input /tmp/security-review.json",
            "python3 .codex/scripts/update_run.py --phase functional-check",
        ],
        "next_transition": "Move to `functional-check` after all three reviews are recorded with no blockers.",
    },
    "functional-check": {
        "goal": "Validate user-visible behavior with functional-checker.",
        "agents": ["functional-checker"],
        "prompt": ".codex/prompts/tester-functional.md",
        "commands": [
            "python3 .codex/scripts/record_test_from_json.py --kind functional --input /tmp/functional-test.json",
            "python3 .codex/scripts/update_run.py --phase pr-ready",
        ],
        "next_transition": "Move to `pr-ready` after functional checks are recorded and pass threshold.",
    },
    "pr-ready": {
        "goal": "Enforce all gates and mark PR-ready only when all artifacts pass.",
        "agents": [],
        "prompt": ".codex/prompts/pr-ready.md",
        "commands": [
            "python3 .codex/scripts/validate_work.py",
        ],
        "next_transition": "Transition to `done` once PR is opened/merged per your delivery policy.",
    },
    "done": {
        "goal": "Run complete. No further orchestration required.",
        "agents": [],
        "prompt": None,
        "commands": [],
        "next_transition": "None.",
    },
    "blocked": {
        "goal": "Resolve blockers before progressing.",
        "agents": [],
        "prompt": None,
        "commands": [],
        "next_transition": "Set phase back to active stage after blocker resolution.",
    },
}


def normalize_phase(value: str | None) -> str:
    if not value:
        return "planning"
    return str(value).strip().lower()


def stage_spec_for_phase(phase: str | None) -> StageSpec:
    normalized = normalize_phase(phase)
    return STAGE_PLAYBOOK.get(normalized, STAGE_PLAYBOOK["planning"])


def render_stage_context(run_state: dict[str, Any] | None) -> str:
    if not run_state:
        return (
            "No active run state. Start with intake, then use `planner-high` and "
            "`docs-decomposer` before implementation."
        )

    phase = normalize_phase(run_state.get("phase"))
    spec = stage_spec_for_phase(phase)
    issue = run_state.get("issue_key") or "unknown-issue"
    lines = [
        f"Stage orchestration: phase=`{phase}` issue=`{issue}`",
        f"Goal: {spec['goal']}",
    ]

    agents = spec.get("agents", [])
    if agents:
        lines.append(f"Required subagents: {', '.join(f'`{name}`' for name in agents)}")
    else:
        lines.append("Required subagents: none")

    prompt = spec.get("prompt")
    if prompt:
        lines.append(f"Prompt contract: `{prompt}`")

    commands = spec.get("commands", [])
    if commands:
        lines.append("Next deterministic commands:")
        for command in commands:
            lines.append(f"- `{command}`")

    lines.append(f"Transition rule: {spec['next_transition']}")
    return "\n".join(lines)

