# Mission Core Runtime Profile

## Purpose

`mission_core` is the default NanoClaw runtime profile.

It optimizes for one delivery path:

`WhatsApp -> andy-developer -> jarvis-worker-1/2 -> review-ready output`

The goal is to keep strict quality gates while reducing always-on control-plane load.

## Scope

### In Scope (Always On)

- WhatsApp ingest/send and trigger-based routing
- Fixed lane set: `main`, `andy-developer`, `jarvis-worker-1`, `jarvis-worker-2`
- Container isolation and mount security boundaries
- Strict worker dispatch validation
- Strict worker completion validation

### Out of Scope by Default

- Scheduler lifecycle (`schedule_task`, `pause/resume/cancel`, host scheduler loop)
- Dynamic group registration (`register_group`, refresh-groups flow)
- Worker steering/progress side-channel
- Event bridge forwarding
- Per-run control-plane snapshot generation (`current_tasks.json`, `available_groups.json`, `worker_runs.json`)

These can be enabled via the `ops_extended` profile or explicit feature flags.

## Runtime Flags

### Profile

- `NANOCLAW_RUNTIME_PROFILE=mission_core` (default)
- `NANOCLAW_RUNTIME_PROFILE=ops_extended`

### Feature Gates

If a gate is unset, it inherits the profile default.

- `NANOCLAW_ENABLE_SCHEDULER`
- `NANOCLAW_ENABLE_WORKER_STEERING`
- `NANOCLAW_ENABLE_DYNAMIC_GROUP_REGISTRATION`
- `NANOCLAW_ENABLE_CONTROL_PLANE_SNAPSHOTS`
- `EVENT_BRIDGE_ENABLED`

## Behavioral Notes

- In `mission_core`, the in-container NanoClaw MCP server exposes only `send_message`.
- Scheduler tools and `register_group` are not registered when disabled.
- Host IPC task processing is disabled when scheduler control is off.
- Worker progress poller is disabled when steering is off.

## Rationale

This profile preserves delivery quality (strict contracts) while removing high-churn orchestration features that are not required for the mission-critical “ship code via WhatsApp” path.
