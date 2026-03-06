---
name: farm-launch
description: Launch approved Farm child issues into coding with bounded parallelism and clear launch summaries.
---

# Farm Launch

Launch approved coding tasks using Farm CLI.

## Use when

1. User asks to start approved tasks.
2. User asks for "launch now" batch operations.

## Required environment

```bash
export FARM_CONFIG="/workspace/extra/farm/config.cloud.yaml"
export FARM_DEFAULT_AGENT="codex"
export FARM_MAX_LAUNCHES="3"
```

## Workflow

1. Discover Approved child tasks from Linear (read-only): `references/linear_read_query.md`.
2. Select up to `$FARM_MAX_LAUNCHES` tasks (default 3).
3. Launch each task with Farm:

```bash
farm run \
  --config "$FARM_CONFIG" \
  --repo "<repo>" \
  --issue "<issue-id>" \
  --agent "${FARM_DEFAULT_AGENT:-codex}"
```

4. Return a launch summary with:
1. issue id
2. repo
3. session
4. worktree path

## Rules

1. `farm run` is the only path for Approved -> Coding transition.
2. Continue launching remaining tasks if one fails.
3. Report failures explicitly.
