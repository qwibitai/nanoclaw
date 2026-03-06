---
name: farm-integration-handoff
description: Check when parent work is ready for integration and notify the user to trigger integration review workflow.
---

# Farm Integration Handoff

Determine integration readiness and request human approval to start review handoff.

## Use when

1. User asks what is ready for integration.
2. User asks for review readiness notifications.

## Workflow

1. Read parent/child status from Linear (read-only) using `references/linear_read_query.md`.
2. For each parent, determine readiness:
1. Ready when every child is `Done` or `Canceled`.
2. Not ready when any child is `Backlog`, `Approved`, or `Coding`.

3. For ready parents, check for evidence:
1. child results and summaries
2. linked PR(s)
3. verification signal (tests/check output if available)

4. Send one decision prompt:
- "Parent <ID> is integration-ready. Start integration review now?"

5. If user approves, run Farm integration review playbook:
- `/workspace/extra/farm/skills/integration-review/SKILL.md`

## Rules

1. Do not auto-merge.
2. Do not auto-move parent to In Review without review gates.
3. Surface blockers explicitly.
