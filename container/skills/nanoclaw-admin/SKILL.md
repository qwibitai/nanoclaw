---
name: nanoclaw-admin
description: NanoClaw admin reference — what the admin agent can directly control and modify. Covers group management, CLAUDE.md editing, config changes, skills, and scheduled tasks. Use when the user wants to configure or change NanoClaw behavior.
---

# NanoClaw Admin Reference

The admin agent (this channel) has **write access** to the NanoClaw project at `/workspace/project`.
`.env` is not accessible — credential changes require the user to act on the host.

---

## What You Can Directly Control

- Register/remove groups (channels that NanoClaw responds to)
- Edit per-group `CLAUDE.md` — changes agent persona, capabilities, constraints
- Edit `groups/global/CLAUDE.md` — applies to all agents
- Edit `src/config.ts` — trigger pattern, timeouts, intervals
- Add/edit container skills in `container/skills/`
- Manage scheduled tasks via MCP tools

---

## Group Management

### List registered groups

```bash
sqlite3 /workspace/project/store/messages.db \
  "SELECT jid, name, folder, is_main, agent_type FROM registered_groups;"
```

### See unregistered channels with recent activity

```bash
cat /workspace/ipc/available_groups.json 2>/dev/null
```

### Register a group

```
mcp__nanoclaw__register_group(
  jid: "dc:<channel_id>",   # dc: Discord, tg: Telegram, slack: Slack
  name: "channel name",
  folder: "discord_claude", # creates groups/discord_claude/
  is_main: false,
  trigger: "@nanoclaw_admin"
)
```

### Remove a group

```bash
sqlite3 /workspace/project/store/messages.db \
  "DELETE FROM registered_groups WHERE jid = 'dc:<channel_id>';"
```

Group folder and files are preserved.

### Clear a corrupted session

```bash
sqlite3 /workspace/project/store/messages.db \
  "DELETE FROM sessions WHERE group_folder = '<folder>';"
```

A fresh session starts on the next message.

---

## Editing Agent Behavior (CLAUDE.md)

### Per-group persona / instructions

```bash
# View
cat /workspace/project/groups/<folder>/CLAUDE.md

# Edit directly
# File: /workspace/project/groups/<folder>/CLAUDE.md
```

Changes take effect on the next message to that group (no restart needed).

### Global memory (applies to all groups)

```bash
cat /workspace/project/groups/global/CLAUDE.md
# Edit: /workspace/project/groups/global/CLAUDE.md
```

---

## Config Changes

Key settings in `/workspace/project/src/config.ts`:

- **Trigger pattern** — regex that activates the agent (e.g., `^@nanoclaw_admin\b`)
- **`CONTAINER_TIMEOUT`** — max time a container can run
- **`IDLE_TIMEOUT`** — how long a container stays alive between messages
- **`CONTAINER_MAX_OUTPUT_SIZE`** — output truncation limit

After editing `src/config.ts`, the user must restart NanoClaw for changes to take effect.

---

## Container Skills

Skills synced into every agent container at startup. Located at `/workspace/project/container/skills/<name>/SKILL.md`.

### List installed skills

```bash
ls /workspace/project/container/skills/
```

### Add or edit a skill

Create or edit `/workspace/project/container/skills/<name>/SKILL.md`.
Format:

```markdown
---
name: skill-name
description: When Claude should invoke this skill.
---

Instructions...
```

Changes apply to new containers — existing running containers are unaffected.

---

## Scheduled Tasks

```
# List all tasks
mcp__nanoclaw__list_tasks()

# Schedule a task for another group
mcp__nanoclaw__schedule_task(
  prompt: "...",
  schedule_type: "cron",
  schedule_value: "0 9 * * 1",
  target_group_jid: "dc:<channel_id>"
)

# Pause / resume / cancel
mcp__nanoclaw__pause_task(task_id: "...")
mcp__nanoclaw__resume_task(task_id: "...")
mcp__nanoclaw__cancel_task(task_id: "...")
```

---

## What Requires User Action on the Host

These cannot be done from inside the container:

| Task | Command |
|------|---------|
| Restart NanoClaw | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` |
| Update OAuth token | Edit `.env` → replace `CLAUDE_CODE_OAUTH_TOKEN` |
| Install a new channel | Run `/add-telegram` (or equivalent skill) in Claude Code CLI |
| Rebuild container image | `./container/build.sh` |

When the user needs to do one of these, tell them the exact command.
