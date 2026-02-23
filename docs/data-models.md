# NanoClaw — Data Models

## Overview

NanoClaw uses a single SQLite database (`store/messages.db`) for all persistent state. The database is initialized at startup via `src/db.ts` and uses `better-sqlite3` for a synchronous API.

---

## Tables

### `chats`

Stores metadata for every WhatsApp chat that has sent a message. Used for group discovery — **no message content is stored here**.

| Column | Type | Description |
|--------|------|-------------|
| `jid` | TEXT (PK) | WhatsApp JID (e.g. `120363...@g.us` for groups, `84564...@s.whatsapp.net` for DMs) |
| `name` | TEXT | Display name of the chat |
| `last_message_time` | TEXT | ISO timestamp of most recent message (used for sorting) |
| `channel` | TEXT | Channel source: `whatsapp`, `telegram`, `discord` |
| `is_group` | INTEGER | 1 = group chat, 0 = DM/self-chat |

**Special entry:** `jid = '__group_sync__'` stores the timestamp of the last WhatsApp group metadata sync.

---

### `messages`

Stores full message content, but **only for registered groups**. Non-registered groups have their chat metadata stored (in `chats`) but no message content.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | WhatsApp message ID |
| `chat_jid` | TEXT (FK → chats.jid) | The chat this message belongs to |
| `sender` | TEXT | Sender's JID |
| `sender_name` | TEXT | Sender's display name |
| `content` | TEXT | Full message text content |
| `timestamp` | TEXT | ISO timestamp |
| `is_from_me` | INTEGER | 1 = sent by this device, 0 = received |
| `is_bot_message` | INTEGER | 1 = sent by the assistant (filtered out of agent context) |

**Primary key:** `(id, chat_jid)` composite

**Indexes:** `idx_timestamp` on `(timestamp)` — used for polling new messages

---

### `scheduled_tasks`

Stores all scheduled tasks created via the `schedule_task` MCP tool.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Unique task ID (`task-{timestamp}-{random}`) |
| `group_folder` | TEXT | Folder name of the owning group (e.g. `main`, `family-chat`) |
| `chat_jid` | TEXT | WhatsApp JID where task results are sent |
| `prompt` | TEXT | The prompt the agent runs when the task fires |
| `schedule_type` | TEXT | `cron`, `interval`, or `once` |
| `schedule_value` | TEXT | Cron expression, milliseconds interval, or ISO timestamp |
| `context_mode` | TEXT | `group` (uses conversation history) or `isolated` (fresh session) |
| `next_run` | TEXT | ISO timestamp of next scheduled run (NULL for completed/once tasks) |
| `last_run` | TEXT | ISO timestamp of last run |
| `last_result` | TEXT | Truncated result/error from last run |
| `status` | TEXT | `active`, `paused`, or `completed` |
| `created_at` | TEXT | ISO timestamp of task creation |

**Indexes:** `idx_next_run` on `(next_run)`, `idx_status` on `(status)` — used by the scheduler's due-task query

---

### `task_run_logs`

Append-only run history for scheduled tasks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, AUTOINCREMENT) | |
| `task_id` | TEXT (FK → scheduled_tasks.id) | |
| `run_at` | TEXT | ISO timestamp of this run |
| `duration_ms` | INTEGER | How long the agent ran (milliseconds) |
| `status` | TEXT | `success` or `error` |
| `result` | TEXT | Truncated agent output (on success) |
| `error` | TEXT | Error message (on failure) |

**Index:** `idx_task_run_logs` on `(task_id, run_at)`

---

### `router_state`

Simple key-value store for orchestrator bookkeeping.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT (PK) | |
| `value` | TEXT | |

**Known keys:**
- `last_timestamp` — ISO timestamp of the last message read from WhatsApp (polling cursor)
- `last_agent_timestamp` — JSON map `{ [chatJid]: lastTimestamp }` — per-group cursor tracking which messages have been sent to an agent

---

### `sessions`

Maps group folders to Claude Agent SDK session IDs. Sessions persist conversation context across container invocations.

| Column | Type | Description |
|--------|------|-------------|
| `group_folder` | TEXT (PK) | Group folder name (e.g. `main`) |
| `session_id` | TEXT | Claude Agent SDK session ID |

---

### `registered_groups`

Groups that NanoClaw actively monitors and responds to.

| Column | Type | Description |
|--------|------|-------------|
| `jid` | TEXT (PK) | WhatsApp group JID |
| `name` | TEXT | Display name |
| `folder` | TEXT (UNIQUE) | Directory name under `groups/` |
| `trigger_pattern` | TEXT | Trigger word (e.g. `@Andy`) |
| `added_at` | TEXT | ISO timestamp of registration |
| `container_config` | TEXT | JSON-encoded `ContainerConfig` (additional mounts, timeout) |
| `requires_trigger` | INTEGER | 1 = only respond to `@Andy` messages, 0 = respond to all messages |

---

## Schema Migrations

The schema is created with `CREATE TABLE IF NOT EXISTS` on every startup. Additive columns are added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` try/catch blocks in `db.ts`. Existing columns are never dropped.

**Backfill logic:**
- `messages.is_bot_message` — backfilled from content prefix pattern (`{ASSISTANT_NAME}:`)
- `chats.channel` and `chats.is_group` — backfilled from JID patterns (`@g.us` → WhatsApp group, `dc:` → Discord, `tg:` → Telegram)

---

## JSON State Migration

On first startup after upgrading from an older version that used JSON files, the following files are automatically migrated to SQLite and renamed to `.migrated`:

- `data/router_state.json` → `router_state` table
- `data/sessions.json` → `sessions` table
- `data/registered_groups.json` → `registered_groups` table
