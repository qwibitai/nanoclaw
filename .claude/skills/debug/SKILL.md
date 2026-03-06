---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Debug

Use this skill for runtime/auth/container/session failures.

## Rule

1. Use script-first diagnostics via `bash scripts/jarvis-ops.sh <command>`.
2. Treat Apple `container` CLI as the default runtime interface.
3. Keep evidence-based outputs (status/trace/bundle), not ad-hoc guesses.

## Required References

1. `docs/troubleshooting/DEBUG_CHECKLIST.md`
2. `docs/workflow/nanoclaw-container-debugging.md`
3. `docs/workflow/nanoclaw-jarvis-debug-loop.md`

## Core Workflow

### 1) Baseline health

Run in order:

```bash
bash scripts/jarvis-ops.sh preflight
bash scripts/jarvis-ops.sh status
bash scripts/jarvis-ops.sh reliability
```

### 2) Runtime recovery (if unhealthy)

```bash
bash scripts/jarvis-ops.sh recover
bash scripts/jarvis-ops.sh preflight
bash scripts/jarvis-ops.sh status
```

### 3) Worker path diagnosis

```bash
bash scripts/jarvis-ops.sh verify-worker-connectivity
bash scripts/jarvis-ops.sh trace --lane andy-developer
```

For dispatch issues:

```bash
bash scripts/jarvis-ops.sh dispatch-lint --file /tmp/dispatch.json --target-folder jarvis-worker-1
```

### 4) Evidence capture for handoff

```bash
bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer
```

For tracked incidents, include `--incident-id <id>`.

## Output Contract

When using this skill, report:

1. Commands executed and pass/fail result.
2. Root cause (or current best hypothesis) backed by logs/trace.
3. Next concrete action.
4. Incident ID/state if tracking applies.

## Notes

- For incident lifecycle operations, use docs-first workflow (`docs/workflow/nanoclaw-jarvis-debug-loop.md`) and update `.claude/progress/incident.json`.
- Docker commands are legacy fallback only; default runtime debugging stays on `container` + `jarvis-ops`.
