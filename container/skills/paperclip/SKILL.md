---
name: paperclip
description: Manage Paperclip issues and agents via API. Use when creating tasks, checking task status, polling for completed issues, adding comments, or listing agents. Triggers on "create issue", "task for Hawk/Rune/Loki", "check Paperclip", "Paperclip status", "поставь задачу в клип".
---

# Paperclip Task Management

## Setup

`PCP_KEY` is injected by the host (from `.env`) — do not hardcode it.

```bash
BASE="http://192.168.64.1:3100/api"
COMPANY="7d1f8ff0-64ef-4660-93b8-57424168ceb1"
```

For project IDs, agent IDs, and team roster — check memory files, or query the API.

**Always set `projectId`** when creating issues.

## API Quick Reference

```bash
# List active issues
curl -s -H "Authorization: Bearer $PCP_KEY" \
  "$BASE/companies/$COMPANY/issues?status=todo,in_progress" | jq .

# Get specific issue
curl -s -H "Authorization: Bearer $PCP_KEY" \
  "$BASE/issues/<ISSUE_ID>" | jq .

# List agents
curl -s -H "Authorization: Bearer $PCP_KEY" \
  "$BASE/companies/$COMPANY/agents" | jq .

# Create issue (always in backlog, always with projectId)
  curl -s -X POST -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  "$BASE/companies/$COMPANY/issues" \
  -d '{"title":"...","description":"...","projectId":"<PROJECT_ID>","status":"backlog"}' | jq .

# Assign and move to todo (separate step)
curl -s -X PATCH -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  "$BASE/issues/<ISSUE_ID>" \
  -d '{"assigneeAgentId":"<AGENT_ID>","status":"todo"}' | jq .

# Update issue status
curl -s -X PATCH -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  -d '{"status":"done","comment":"Summary."}' \
  "$BASE/issues/<ISSUE_ID>" | jq .

# Add comment
curl -s -X POST -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  "$BASE/issues/<ISSUE_ID>/comments" \
  -d '{"body":"Comment text"}' | jq .

# Checkout (required before working)
curl -s -X POST -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  -d '{"agentId":"<YOUR_AGENT_ID>","expectedStatuses":["todo","backlog","blocked"]}' \
  "$BASE/issues/<ISSUE_ID>/checkout" | jq .

# Attach document
curl -s -X PUT -H "Authorization: Bearer $PCP_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Plan","format":"markdown","body":"# Plan\n..."}' \
  "$BASE/issues/<ISSUE_ID>/documents/plan" | jq .

# Search issues
curl -s -H "Authorization: Bearer $PCP_KEY" \
  "$BASE/companies/$COMPANY/issues?q=search+term" | jq .
```

## Issue Lifecycle

```
backlog → todo → in_progress → in_review → done
                     ↑              |
                  blocked       in_progress (rework)
```

## Conventions

- **Create issues in `backlog` status** — move to `todo` only when ready to assign
- **Always set `projectId`** — no orphan issues
- **Assign (`assigneeAgentId`) via PATCH when moving to `todo`** — not at creation time
- `parentId` links child to parent — use for task decomposition
- Review gate: executor → `in_review`, reviewer → `done`
- Max 3 rework iterations per issue, then escalate
- Task brief: scope + full paths + "Write results to `<path>`. Comment with summary + path."