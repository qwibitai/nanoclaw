---
name: paperclip-db
description: Direct SQL access to Paperclip's embedded PostgreSQL database. Use for audit queries, debugging agent sessions, inspecting execution workspaces, or any data not exposed via the REST API. Triggers on "query db", "check db", "sql", "audit log", "activity log", "session history".
---

# Paperclip Database Access

## Connection

```bash
PGPASSWORD=paperclip psql -h 192.168.64.1 -p 54329 -U paperclip -d paperclip -c "YOUR SQL HERE"
```

## Key Tables

| Table | Purpose |
|-------|---------|
| `activity_log` | Audit trail — who did what and when |
| `issues` | All issues with status, project, assignee |
| `agents` | Agent definitions and config |
| `agent_task_sessions` | Session persistence per agent (heartbeat + task sessions) |
| `execution_workspaces` | Which cwd/repo an agent used for each issue |
| `heartbeat_runs` | Individual agent run records |
| `projects` | Projects with workspace config |
| `project_workspaces` | Workspace paths and repo URLs per project |
| `issue_comments` | Comments on issues |
| `company_skills` | Installed skills |

## Common Queries

```bash
# Recent activity for an agent (by name)
PGPASSWORD=paperclip psql -h 192.168.64.1 -p 54329 -U paperclip -d paperclip -c "
SELECT al.created_at, al.action, al.entity_type, al.details
FROM activity_log al
JOIN agents a ON al.agent_id = a.id
WHERE a.name = 'Rune'
ORDER BY al.created_at DESC LIMIT 20;"

# Check which cwd an issue used
PGPASSWORD=paperclip psql -h 192.168.64.1 -p 54329 -U paperclip -d paperclip -c "
SELECT cwd, repo_url, status, created_at
FROM execution_workspaces
WHERE source_issue_id = '<ISSUE_UUID>';"

# Agent session history
PGPASSWORD=paperclip psql -h 192.168.64.1 -p 54329 -U paperclip -d paperclip -c "
SELECT task_key, adapter_type, session_display_id, session_params_json, created_at, updated_at
FROM agent_task_sessions
WHERE agent_id = '<AGENT_UUID>'
ORDER BY updated_at DESC LIMIT 10;"
```

## Rules

- **Read-only** — never INSERT, UPDATE, or DELETE unless explicitly instructed by User
- Use `-x` flag for wide rows (expanded display)
- Always include `ORDER BY` and `LIMIT` to avoid dumping entire tables
