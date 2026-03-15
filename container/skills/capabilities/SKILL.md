---
name: capabilities
description: Show and manage admin capabilities — installed skills, tools, system info. Supports enable/disable/pending subcommands with approval flow for sensitive changes. Use when the user runs /capabilities.
---

# /capabilities — System Capabilities

Show what this NanoClaw instance can do, and manage admin command toggles.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/capabilities` there.

Then stop.

## Subcommands

Parse the user message to determine the subcommand:

- `/capabilities` (no args) → **show report** (section below)
- `/capabilities enable <command>` → **enable** a command
- `/capabilities disable <command>` → **disable** a command
- `/capabilities pending` → **list pending approvals**

---

## Persistent state

All state lives under `/workspace/group/.nanoclaw/admin/`. Create the directory if it doesn't exist:

```bash
mkdir -p /workspace/group/.nanoclaw/admin
```

### Files

| File | Format | Purpose |
|------|--------|---------|
| `capabilities.json` | `{"enabledAdminCommands": [...], "version": 1}` | Which admin commands are enabled |
| `pending-approvals.json` | `[{id, action, commandName, requestedAt, beforeState}, ...]` | Pending sensitive changes |
| `audit.jsonl` | One JSON object per line | Audit trail of all changes |

### Defaults

If `capabilities.json` does not exist, the default state is:

```json
{"enabledAdminCommands": ["capabilities", "status", "approve", "reject"], "version": 1}
```

### Reading state

```bash
cat /workspace/group/.nanoclaw/admin/capabilities.json 2>/dev/null || echo '{"enabledAdminCommands":["capabilities","status","approve","reject"],"version":1}'
```

---

## Constants

- **Sensitive commands** (require approval to toggle): `capabilities`, `approve`, `reject`
- **Undisableable commands** (cannot be disabled at all): `capabilities`, `approve`
- **Admin commands** (the full set): `capabilities`, `status`, `approve`, `reject`

---

## Subcommand: show report (no args)

Generate a structured report of what this instance can do.

### 1. Installed skills

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

### 2. Available tools

You always have access to:
- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp__nanoclaw__* (messaging, tasks, group management)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):
- `send_message` — send a message to the user/group
- `schedule_task` — schedule a recurring or one-time task
- `list_tasks` — list scheduled tasks
- `pause_task` — pause a scheduled task
- `resume_task` — resume a paused task
- `cancel_task` — cancel and delete a task
- `update_task` — update an existing task
- `register_group` — register a new chat/group (main only)

### 4. Container skills (Bash tools)

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

### 6. Admin command status

Read `capabilities.json` (or use defaults) and show which admin commands are enabled/disabled.

### Report format

```
📋 *NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group

*Container Tools:*
• agent-browser: ✓

*System:*
• Group memory: yes/no
• Extra mounts: N directories
• Main channel: yes

*Admin Commands:*
• /capabilities: ✓ enabled (undisableable)
• /status: ✓ enabled
• /approve: ✓ enabled (undisableable)
• /reject: ✓ enabled
```

Adapt the output based on what you actually find.

---

## Subcommand: enable

`/capabilities enable <command>`

1. Strip leading `/` from the command name.
2. Check the command is a known admin command (`capabilities`, `status`, `approve`, `reject`). If not, respond: `❌ Unknown admin command: /<name>. Known commands: capabilities, status, approve, reject.`
3. Read current config. If already enabled, respond: `/<name> is already enabled.`
4. **If the command is sensitive** (`capabilities`, `approve`, `reject`): create a pending approval:
   - Generate a random 8-character hex ID: `$(head -c 4 /dev/urandom | xxd -p)`
   - Add to `pending-approvals.json`
   - Append audit line: `{"timestamp":"...","action":"request","change":"enable /<name>","approvalId":"<id>"}`
   - Respond:
     ```
     ⏳ *Approval required*
     Enabling `/<name>` is a sensitive change.
     *Before:* disabled
     *After:* enabled
     To approve: `/approve <id>`
     To reject: `/reject <id>`
     ```
5. **If not sensitive** (e.g., `status`): apply immediately.
   - Update `capabilities.json` to add the command to `enabledAdminCommands`.
   - Append audit line: `{"timestamp":"...","action":"apply","change":"enable /<name>"}`
   - Respond: `✅ /<name> is now enabled.`

---

## Subcommand: disable

`/capabilities disable <command>`

1. Strip leading `/` from the command name.
2. Check the command is a known admin command. If not, respond with error.
3. **If undisableable** (`capabilities`, `approve`): respond: `🔒 /<name> cannot be disabled — it is required for admin recovery.` Then stop.
4. Read current config. If already disabled, respond: `/<name> is already disabled.`
5. **If sensitive** (`reject`): create pending approval (same flow as enable, but action is "disable").
6. **If not sensitive** (`status`): apply immediately.
   - Update `capabilities.json` to remove the command from `enabledAdminCommands`.
   - Append audit line: `{"timestamp":"...","action":"apply","change":"disable /<name>"}`
   - Respond: `✅ /<name> is now disabled.`

---

## Subcommand: pending

`/capabilities pending`

1. Read `pending-approvals.json`. If file doesn't exist or is empty array, respond: `No pending approvals.`
2. Otherwise list each pending item:

```
📋 *Pending Approvals*

• ID: `<id>` — <action> /<commandName>
  Requested: <requestedAt>
  `/approve <id>` · `/reject <id>`
```

---

## Writing state files

When updating `capabilities.json`, write the full file (read-modify-write via bash):

```bash
# Example: add "status" to enabled list
CONFIG=$(cat /workspace/group/.nanoclaw/admin/capabilities.json 2>/dev/null || echo '{"enabledAdminCommands":["capabilities","status","approve","reject"],"version":1}')
# Modify with jq or string manipulation, then write back
echo "$UPDATED_CONFIG" > /workspace/group/.nanoclaw/admin/capabilities.json
```

When appending audit entries:

```bash
echo '{"timestamp":"2026-03-14T10:00:00Z","action":"apply","change":"disable /status"}' >> /workspace/group/.nanoclaw/admin/audit.jsonl
```

When updating pending approvals, read the full array, add/remove the item, write back the full file.

**See also:** `/status` for a quick health check. `/approve` and `/reject` to resolve pending changes.
