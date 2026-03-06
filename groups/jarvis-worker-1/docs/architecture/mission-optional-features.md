# Mission Optional Features (`ops_extended`)

## Purpose

`ops_extended` is an opt-in profile for operational convenience features that add runtime surface area and maintenance burden.

Use it only when those capabilities are required for the active workflow.

## Optional Capabilities

- Scheduler and scheduled-task control plane
- Dynamic group registration and group refresh flows
- Worker steering and progress side-channel
- Event bridge emission
- Control-plane snapshots for task/group/worker state files

## Enabling

Set profile:

```bash
NANOCLAW_RUNTIME_PROFILE=ops_extended
```

Or selectively enable individual features in `mission_core`:

```bash
NANOCLAW_ENABLE_SCHEDULER=true
NANOCLAW_ENABLE_WORKER_STEERING=true
NANOCLAW_ENABLE_DYNAMIC_GROUP_REGISTRATION=true
NANOCLAW_ENABLE_CONTROL_PLANE_SNAPSHOTS=true
EVENT_BRIDGE_ENABLED=true
```

## Guidance

- Prefer keeping `mission_core` as production default.
- Enable optional features temporarily for incident response or specific operations.
- If an optional feature becomes permanent for the workflow, reassess whether the mission baseline should be updated in architecture docs and acceptance criteria.
