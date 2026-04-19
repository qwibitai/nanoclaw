---
name: task-tracker
description: Records and tracks Sagri AI task lifecycle in PostgreSQL. Use to create tasks, update their status, and query current state.
---

## Purpose

Maintain a persistent record of every task processed by the Sagri AI agent, including source, status transitions, and timing. All operations target the `sagri_ai.tasks` table.

## Schema reference

```
sagri_ai.tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source           TEXT NOT NULL CHECK (source IN ('slack', 'github', 'notion', 'manual')),
    source_reference TEXT UNIQUE,
    title            TEXT NOT NULL,
    description      TEXT,
    priority         TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    error_message    TEXT,
    session_id       TEXT,
    last_alerted_at  TIMESTAMPTZ,
    metadata         JSONB DEFAULT '{}'::JSONB
)
```

## Operations

### Create a new task

Insert a row and return the generated `id`. Use `ON CONFLICT (source_reference) DO NOTHING` to handle cases where the poller runs again before the upstream status has been updated — a duplicate `source_reference` means the task was already recorded:

```sql
INSERT INTO sagri_ai.tasks (source, source_reference, title, description, priority, metadata)
VALUES (
    '<source>',
    '<source_reference>',
    '<title>',
    '<description>',
    '<priority>',
    '<metadata_json>'::JSONB
)
ON CONFLICT (source_reference) DO NOTHING
RETURNING id;
```

Execute via:

```bash
psql "${DATABASE_URL}" -t -A -c "<query>"
```

If the query returns no row (conflict was skipped), return nothing to the caller — the task already exists and the caller must skip this item.

### Update task status to "in_progress"

```sql
UPDATE sagri_ai.tasks
SET status = 'in_progress',
    started_at = NOW(),
    session_id = '<session_id>'
WHERE id = '<task_id>';
```

### Update task status to "completed"

```sql
UPDATE sagri_ai.tasks
SET status = 'completed',
    completed_at = NOW(),
    session_id = '<session_id>'
WHERE id = '<task_id>';
```

### Update task status to "failed"

```sql
UPDATE sagri_ai.tasks
SET status = 'failed',
    completed_at = NOW(),
    error_message = '<error_message>',
    session_id = '<session_id>'
WHERE id = '<task_id>';
```

### Update task status to "cancelled"

```sql
UPDATE sagri_ai.tasks
SET status = 'cancelled',
    completed_at = NOW()
WHERE id = '<task_id>';
```

### Query current task status

```sql
SELECT id, title, source, status, created_at, started_at, session_id
FROM sagri_ai.tasks
WHERE id = '<task_id>';
```

### Query tasks in a given status

```sql
SELECT id, title, source, source_reference, priority, created_at, started_at, session_id
FROM sagri_ai.tasks
WHERE status = '<status>'
ORDER BY created_at ASC;
```

## Notes

- All timestamps are stored in UTC (`TIMESTAMPTZ`).
- `metadata` accepts any valid JSON object; use it for source-specific fields (e.g. Notion page ID, GitHub issue number, Slack thread timestamp).
- If `psql` returns a non-zero exit code, throw an error — do not continue.
- Never truncate or delete rows; the table is append-only except for status updates.
