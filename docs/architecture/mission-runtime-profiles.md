# Mission Runtime Profiles

## Purpose

Defines the supported NanoClaw runtime profiles, their default behavior, and the boundary between mission-critical baseline behavior and optional operational extensions.

## Profiles

### `mission_core` (default)

`mission_core` is the default NanoClaw runtime profile.

It optimizes for one delivery path:

`WhatsApp -> andy-developer -> jarvis-worker-1/2 -> review-ready output`

The goal is to keep strict quality gates while reducing always-on control-plane load.

Always on:

- WhatsApp ingest/send and trigger-based routing
- Fixed lane set: `main`, `andy-developer`, `jarvis-worker-1`, `jarvis-worker-2`
- Container isolation and mount security boundaries
- Strict worker dispatch validation
- Strict worker completion validation

Disabled by default:

- Scheduler lifecycle (`schedule_task`, `pause/resume/cancel`, host scheduler loop)
- Dynamic group registration (`register_group`, refresh-groups flow)
- Worker steering/progress side-channel
- Event bridge forwarding
- Per-run control-plane snapshot generation (`current_tasks.json`, `available_groups.json`, `worker_runs.json`)

Behavior notes:

- In `mission_core`, the in-container NanoClaw MCP server exposes only `send_message`.
- Scheduler tools and `register_group` are not registered when disabled.
- Host IPC task processing is disabled when scheduler control is off.
- Worker progress poller is disabled when steering is off.

### `ops_extended` (opt-in)

`ops_extended` is an opt-in profile for operational convenience features that add runtime surface area and maintenance burden.

Use it only when those capabilities are required for the active workflow.

Optional capabilities:

- Scheduler and scheduled-task control plane
- Dynamic group registration and group refresh flows
- Worker steering and progress side-channel
- Event bridge emission
- Control-plane snapshots for task/group/worker state files

## Runtime Flags

Profile flags:

- `NANOCLAW_RUNTIME_PROFILE=mission_core` (default)
- `NANOCLAW_RUNTIME_PROFILE=ops_extended`

Feature gates:

- `NANOCLAW_ENABLE_SCHEDULER`
- `NANOCLAW_ENABLE_WORKER_STEERING`
- `NANOCLAW_ENABLE_DYNAMIC_GROUP_REGISTRATION`
- `NANOCLAW_ENABLE_CONTROL_PLANE_SNAPSHOTS`
- `EVENT_BRIDGE_ENABLED`

If a feature gate is unset, it inherits the active profile default.

## Recommended Default

- Prefer keeping `mission_core` as the production default.
- Enable optional features temporarily for incident response or specific operations.
- Use `ops_extended` only when the operational value is worth the added runtime and maintenance surface.

## Promotion Rule

If an optional feature becomes permanently required for the active workflow:

1. reassess whether it belongs in the mission baseline
2. update architecture docs and acceptance criteria in the same change set
3. treat the promotion as an architecture decision, not an ad hoc runtime toggle

## Rationale

This profile split preserves delivery quality while keeping high-churn orchestration features out of the baseline runtime unless they are explicitly needed.
