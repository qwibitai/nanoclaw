---
name: agency-hq
description: Interact with the Agency HQ scrum board API. Use for managing tasks, sprints, meetings, decisions, and notifications.
allowed-tools: Bash(curl:*)
---

# Agency HQ API

The Agency HQ API manages the agent organization's scrum board, meetings, decisions, and notifications.

## Base URL

```
http://host.docker.internal:3040/api/v1
```

## Quick Reference

### Dashboard (start here)
```bash
curl -s http://host.docker.internal:3040/api/v1/dashboard | jq .
```

### Tasks (Scrum Board)

```bash
# List all tasks (filterable: ?status=backlog&priority=high&assigned_to=ceo&sprint_id=UUID)
curl -s http://host.docker.internal:3040/api/v1/tasks | jq .

# Get single task
curl -s http://host.docker.internal:3040/api/v1/tasks/TASK_ID | jq .

# Create task
curl -s -X POST http://host.docker.internal:3040/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "description": "...", "priority": "high", "assigned_to": "engineering-lead", "created_by": "ceo"}' | jq .

# Update task (any field: status, priority, assigned_to, sprint_id, branch, pr_url, dev_inbox_run_id)
curl -s -X PUT http://host.docker.internal:3040/api/v1/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "in-progress"}' | jq .

# Get subtasks
curl -s http://host.docker.internal:3040/api/v1/tasks/TASK_ID/subtasks | jq .

# Delete task
curl -s -X DELETE http://host.docker.internal:3040/api/v1/tasks/TASK_ID | jq .
```

Task statuses: `backlog` → `ready` → `in-progress` → `in-review` → `done` (also: `blocked`, `cancelled`)
Task priorities: `critical`, `high`, `medium`, `low`

### Sprints

```bash
# List sprints (?status=active)
curl -s http://host.docker.internal:3040/api/v1/sprints | jq .

# Create sprint
curl -s -X POST http://host.docker.internal:3040/api/v1/sprints \
  -H "Content-Type: application/json" \
  -d '{"name": "Sprint 2", "goal": "Build meeting engine"}' | jq .

# Start sprint
curl -s -X PUT http://host.docker.internal:3040/api/v1/sprints/SPRINT_ID/start | jq .

# Complete sprint
curl -s -X PUT http://host.docker.internal:3040/api/v1/sprints/SPRINT_ID/complete | jq .
```

### Meetings

```bash
# List meetings (?type=standup&status=scheduled&sprint_id=UUID)
curl -s http://host.docker.internal:3040/api/v1/meetings | jq .

# Create meeting
curl -s -X POST http://host.docker.internal:3040/api/v1/meetings \
  -H "Content-Type: application/json" \
  -d '{"type": "sprint-planning", "title": "Sprint 2 Planning", "participants": ["ceo", "engineering-lead", "operations-lead"]}' | jq .

# Append transcript entry
curl -s -X POST http://host.docker.internal:3040/api/v1/meetings/MEETING_ID/transcript \
  -H "Content-Type: application/json" \
  -d '{"agent": "ceo", "message": "..."}' | jq .

# Update meeting (status, summary, etc.)
curl -s -X PUT http://host.docker.internal:3040/api/v1/meetings/MEETING_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "summary": "..."}' | jq .
```

Meeting types: `standup`, `sprint-planning`, `design-review`, `retro`, `ad-hoc`

### Decisions

```bash
# List decisions (?status=proposed&meeting_id=UUID&decided_by=ceo)
curl -s http://host.docker.internal:3040/api/v1/decisions | jq .

# Record decision
curl -s -X POST http://host.docker.internal:3040/api/v1/decisions \
  -H "Content-Type: application/json" \
  -d '{"title": "...", "description": "...", "decided_by": "ceo", "authority_level": "ceo", "rationale": "..."}' | jq .

# Approve/reject decision
curl -s -X PUT http://host.docker.internal:3040/api/v1/decisions/DECISION_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "approved", "approved_by": "human"}' | jq .
```

### Notifications

```bash
# List unread notifications
curl -s "http://host.docker.internal:3040/api/v1/notifications?unread=true" | jq .

# Create notification
curl -s -X POST http://host.docker.internal:3040/api/v1/notifications \
  -H "Content-Type: application/json" \
  -d '{"type": "decision-needed", "title": "...", "target": "human", "channel": "telegram"}' | jq .

# Mark as read
curl -s -X PUT http://host.docker.internal:3040/api/v1/notifications/NOTIF_ID/read | jq .
```

### Agent Sessions

```bash
# Start a session
curl -s -X POST http://host.docker.internal:3040/api/v1/agent-sessions \
  -H "Content-Type: application/json" \
  -d '{"agent_persona": "ceo", "session_type": "planning"}' | jq .

# Close session with summary
curl -s -X PUT http://host.docker.internal:3040/api/v1/agent-sessions/SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"output_summary": "...", "ended_at": "2026-03-16T00:00:00Z"}' | jq .
```

### Agent Memory

```bash
# Get all memory for an agent
curl -s http://host.docker.internal:3040/api/v1/memory/engineering-lead | jq .

# Get memory for a specific project
curl -s "http://host.docker.internal:3040/api/v1/memory/engineering-lead?project=agency-hq" | jq .

# Update memory (upsert)
curl -s -X PUT http://host.docker.internal:3040/api/v1/memory/ceo \
  -H "Content-Type: application/json" \
  -d '{"content": "...", "project": "_global"}' | jq .

# Append to memory
curl -s -X POST http://host.docker.internal:3040/api/v1/memory/ceo/append \
  -H "Content-Type: application/json" \
  -d '{"content": "New note from today...", "project": "agency-hq"}' | jq .
```

### Autonomy Rules

```bash
# List all autonomy rules (what needs human approval vs autonomous)
curl -s http://host.docker.internal:3040/api/v1/autonomy/rules | jq .

# Check if a decision type needs approval
curl -s http://host.docker.internal:3040/api/v1/autonomy/check/architecture | jq .

# Submit human feedback on a decision
curl -s -X POST http://host.docker.internal:3040/api/v1/autonomy/feedback \
  -H "Content-Type: application/json" \
  -d '{"decision_id": "UUID", "feedback_type": "approve", "reasoning": "Looks good"}' | jq .

# View feedback stats (approval rate over time)
curl -s http://host.docker.internal:3040/api/v1/autonomy/feedback/stats | jq .
```

Trust levels: `propose` (human decides), `act-report` (agent acts, human notified), `act-exception` (agent acts, human notified on error), `autonomous` (agent acts, weekly summary)

### Trigger a Meeting

```bash
# Trigger a standup meeting (creates + runs automatically)
curl -s -X POST http://host.docker.internal:3040/api/v1/meetings/trigger \
  -H "Content-Type: application/json" \
  -d '{"type": "standup"}' | jq .

# Trigger sprint planning
curl -s -X POST http://host.docker.internal:3040/api/v1/meetings/trigger \
  -H "Content-Type: application/json" \
  -d '{"type": "sprint-planning"}' | jq .

# Run a specific scheduled meeting
curl -s -X POST http://host.docker.internal:3040/api/v1/meetings/MEETING_ID/run | jq .
```

## Dev-Inbox Integration

To execute implementation tasks, invoke dev-inbox from the host:

```bash
# Write an IPC task to trigger dev-inbox execution
cat > /workspace/ipc/tasks/dev-inbox-$(date +%s).json << 'TASKEOF'
{
  "type": "schedule_task",
  "prompt": "[Agency HQ] Execute task: <description>\n\nAcceptance criteria:\n- <criteria>",
  "schedule_type": "once",
  "schedule_value": "now",
  "targetJid": "tg:8340382755",
  "context_mode": "group"
}
TASKEOF
```

For more complex multi-repo tasks, the human can invoke `/orchestrate` from dev-inbox directly.

## Parallel Dispatch Architecture

NanoClaw dispatches Agency HQ `ready` tasks in parallel across **4 concurrent worker slots**.

### How it works

Tasks in `ready` status are picked up by the dispatch loop every 60 seconds. When parallel dispatch is active, each task is assigned to an available worker slot:

| Slot JID | Description |
|---|---|
| `internal:dev-inbox:0` | Worker slot 0 |
| `internal:dev-inbox:1` | Worker slot 1 |
| `internal:dev-inbox:2` | Worker slot 2 |
| `internal:dev-inbox:3` | Worker slot 3 |

Each slot runs as an isolated container in `context_mode: isolated`. A sprint with 6 tasks will dispatch up to 4 simultaneously on the first tick, then the remaining 2 on the next available tick.

### Slot state machine

```
free → acquiring → executing → releasing → free
```

- **acquiring**: task claimed, worktree created, local task registered
- **executing**: container process running
- **releasing**: container exited, results being written back to Agency HQ
- **free**: slot available for next task

Slot state is stored via Agency HQ API (`DISPATCH_SLOTS_PG=true`) at:
- `GET /api/v1/dispatch-slots` — view all slot states
- `POST /api/v1/dispatch-slots/claim` — claim a slot (atomic)
- `PUT /api/v1/dispatch-slots/:id/executing` — mark executing
- `PUT /api/v1/dispatch-slots/:id/releasing` — mark releasing
- `PUT /api/v1/dispatch-slots/:id/free` — release slot

### Branch isolation

Tasks with the same `assigned_to` branch cannot occupy slots simultaneously — prevents concurrent modifications to the same branch.

### Configuration (NanoClaw .env)

```bash
DISPATCH_PARALLEL=true   # Force-enable parallel (bypasses organic metrics gate)
DISPATCH_PARALLEL=false  # Kill switch — force sequential single-worker mode
# (unset)               # Automatic — notification metrics gate decides
DISPATCH_SLOTS_PG=true   # Use Agency HQ API for slot state (recommended)
```

### Activation

Parallel dispatch is activated at startup via `DISPATCH_PARALLEL=true`. Without this, the automatic metrics gate requires ≥3 organic notification agents over ≥7 days. The force-enable bypasses this gate for environments with limited notification history.

### Recovery

On startup, any slots stuck in `acquiring`/`executing`/`releasing` from a previous crash are recovered: the corresponding Agency HQ tasks are reverted to `ready` and slots are freed.
