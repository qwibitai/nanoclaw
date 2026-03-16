# Design: add-google-tasks skill

**Date:** 2026-03-16
**Status:** Approved

## Summary

A NanoClaw skill (`add-google-tasks`) that integrates Google Tasks into the main WhatsApp group. Follows the same architecture as `add-gmail`: local MCP server installation, credentials mounted into the agent container, and a daily morning cron task for overdue/due-today reminders.

## Requirements

- Use in the existing **main** WhatsApp group (no new channel)
- Full Google Tasks access: list task lists, create/edit/complete/delete tasks
- Daily morning reminder at **07:00** with all **overdue** and **due today** tasks
- MCP server installed locally at `~/Development/tools/google-tasks-mcp`
- New GCP project + OAuth credentials (user starting from scratch)

## Architecture

```
WhatsApp → main group → container agent
                              ↓
                     MCP server: gtasks-mcp
                     (node /home/node/google-tasks-mcp/dist/index.js)
                              ↓
                     Google Tasks API (OAuth2)

task-scheduler (cron: 0 7 * * *)
       ↓
container agent → gtasks-mcp → "overdue + due today tasks"
       ↓
WhatsApp (morning summary message)
```

## Components

### MCP Server
- **Repo:** `https://github.com/zcaceres/gtasks-mcp`
- **Install path:** `~/Development/tools/google-tasks-mcp`
- **Build:** `npm install && npm run build` in that directory
- **Credentials:**
  - `gcp-oauth.keys.json` — GCP OAuth client credentials (downloaded from GCP console)
  - `credentials.json` — OAuth token (generated via `node dist/index.js auth`)
  - Both files live at the install path root

### Container mount
- Host: `~/Development/tools/google-tasks-mcp`
- Container: `/home/node/google-tasks-mcp` (read-only)
- **Implementation note:** This is a hardcoded `VolumeMount` entry added directly inside the `buildVolumeMounts()` function in `src/container-runner.ts` (same pattern as other system-level mounts like `.claude/` and `ipc/`). It must NOT use `containerConfig.additionalMounts` — that mechanism is for user-configured mounts and forces paths under `/workspace/extra/`, which would produce a wrong container path and break the MCP server invocation.

### Agent-runner registration
In `container/agent-runner/src/index.ts`:
- MCP server key name: **`gtasks`** (this determines the tool prefix — key `gtasks` → tools named `mcp__gtasks__*`)
- MCP server config: `{ command: "node", args: ["/home/node/google-tasks-mcp/dist/index.js"] }`
- Allowed tools pattern: `mcp__gtasks__*`

### Files modified
| File | Change |
|------|--------|
| `src/container-runner.ts` | Add `~/Development/tools/google-tasks-mcp` mount |
| `container/agent-runner/src/index.ts` | Register gtasks MCP server + allow `mcp__gtasks__*` tools |
| `groups/main/CLAUDE.md` | Add Google Tasks behavior instructions (see content below) |

### Daily cron task
- Schedule: `0 7 * * *` (07:00 daily, respects `TIMEZONE` env var)
- Group: main
- Prompt: *"Check Google Tasks. List all overdue tasks and tasks due today across all task lists. Send a formatted morning summary to the user."*
- Created via direct SQLite insert into the `scheduled_tasks` table
- Context mode: `group` (uses the main group's active session)

## Data Flow

**Manual interaction:**
```
user: "@Andy create task 'Call bank' in Personal list"
  → agent calls mcp__gtasks__createTask(list="Personal", title="Call bank")
  → Google Tasks API
  → agent confirms in WhatsApp
```

**Morning notification (07:00 cron):**
```
task-scheduler fires cron task
  → container agent receives prompt
  → agent calls mcp__gtasks__listTaskLists + mcp__gtasks__listTasks (per list)
  → filters overdue + due today
  → formats and sends WhatsApp message
```

## Skill Phases

### Phase 1 — Pre-flight
- Check if mount already exists in `src/container-runner.ts` (idempotency guard)
- Check if `~/Development/tools/google-tasks-mcp` already exists

### Phase 2 — Install MCP server
```bash
git clone https://github.com/zcaceres/gtasks-mcp ~/Development/tools/google-tasks-mcp
cd ~/Development/tools/google-tasks-mcp && npm install && npm run build
```

### Phase 3 — Apply code changes
1. Edit `src/container-runner.ts` — add mount for `~/Development/tools/google-tasks-mcp`
2. Edit `container/agent-runner/src/index.ts` — register MCP server + allow tools
3. Append Google Tasks section to `groups/main/CLAUDE.md`
4. Run `npm run build` (NanoClaw host)
5. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
6. Rebuild container: `cd container && ./build.sh`

### Phase 4 — OAuth setup
1. Guide user through GCP project creation
2. Enable Google Tasks API
3. Create OAuth client ID (Desktop app), download as `gcp-oauth.keys.json`
4. Copy to `~/Development/tools/google-tasks-mcp/gcp-oauth.keys.json`
5. Run auth: `node ~/Development/tools/google-tasks-mcp/dist/index.js auth`
6. Verify `credentials.json` was created

### Phase 5 — Create cron task
The skill must:
1. Open `store/messages.db` (the NanoClaw SQLite database — always at this path relative to the project root)
2. Query `registered_groups WHERE folder = 'main'` to find the main group's `jid`
3. Compute the next occurrence of 07:00 in the host's timezone as an ISO string
4. Insert the task using all required columns:

```sql
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, context_mode, next_run, created_at)
VALUES (
  '<uuid-v4>',
  'main',
  '<main_jid>',
  'Check Google Tasks. List all overdue tasks and tasks due today across all task lists. Send a formatted morning summary to the user.',
  'cron',
  '0 7 * * *',
  'active',
  'group',
  '<next_7am_iso>',
  '<now_iso>'
);
```

Where `<uuid-v4>` is a randomly generated UUID, `<main_jid>` is the value from `SELECT jid FROM registered_groups WHERE folder = 'main'`, `<next_7am_iso>` is the next future 07:00 in the local timezone, and `<now_iso>` is the current time. The skill executes this using the `sqlite3` CLI: `sqlite3 store/messages.db "..."`.

Note: `context_mode = 'group'` is intentional — it fires the cron in the group's live session (not isolated), so the agent can send the morning message to the group's active conversation.

### Phase 6 — Restart and verify
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```
User test: send `"@Andy list my Google Tasks lists"` in main group.

## Removal

1. Remove `~/Development/tools/google-tasks-mcp` mount from `src/container-runner.ts`
2. Remove gtasks MCP server and `mcp__gtasks__*` from `container/agent-runner/src/index.ts`
3. Remove Google Tasks section from `groups/main/CLAUDE.md`
4. Delete cron task from SQLite DB: `sqlite3 store/messages.db "DELETE FROM scheduled_tasks WHERE schedule_value = '0 7 * * *' AND group_folder = 'main'"`
5. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
6. Rebuild and restart

## groups/main/CLAUDE.md — Google Tasks section

Append the following block to `groups/main/CLAUDE.md`:

```markdown
## Google Tasks

You have full access to Google Tasks via the `mcp__gtasks__*` tools. Use them when the user asks to manage tasks, lists, or reminders.

- To create a task: ask which list if not specified, default to the first available list
- To mark complete: find the task by title if no ID is given
- For the daily morning summary (triggered automatically at 07:00): list overdue tasks and tasks due today across ALL lists; format clearly with list name, task title, and due date
- Do NOT proactively check tasks unless the user asks or the scheduled morning prompt fires
```

## Security Notes

- Credentials mounted read-only — container cannot modify OAuth tokens
- **Token refresh caveat:** If `gtasks-mcp` attempts to write refreshed tokens back to `credentials.json` at runtime, the read-only mount will silently prevent the write, breaking auth after token expiry. During Phase 6 verification, confirm that the MCP server either doesn't refresh tokens in-place, or switch the mount to writable if it does.
- Google Tasks scope: `https://www.googleapis.com/auth/tasks` (full read/write)
- No new network ports or channels opened
