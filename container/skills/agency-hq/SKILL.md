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
