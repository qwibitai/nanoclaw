---
name: configure-group
description: Configure or reconfigure a group's full agent definition — purpose, persona, channel, trigger, container skills, env vars, and mounts. Use when registering a new group or updating an existing one. Main group only.
disable-model-invocation: true
---

# Configure Group

Interactively define or update a group's complete agent configuration: identity, channel, trigger behaviour, skills, env vars, and mounts. Main group only.

## Phase 1: Pre-flight

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, stop and tell the user this skill is only available in the main channel.

## Phase 2: Select Group

Read the available groups snapshot:

```bash
cat /workspace/ipc/available_groups.json
```

Also read currently registered groups from SQLite:

```bash
sqlite3 /workspace/project/store/messages.db \
  "SELECT jid, name, folder, trigger_pattern, requires_trigger, container_config FROM registered_groups"
```

Ask the user which group to configure. If they name a group that isn't in the snapshot, trigger a refresh:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Wait briefly, then re-read the snapshot.

If the group is already registered, load its existing config as defaults for every subsequent step.

## Phase 3: Agent Identity & Purpose

Use `AskUserQuestion` to collect:

1. **Name**: What should this agent be called? (e.g. "Andy", "Aria")
2. **Purpose**: In a sentence or two, what is this agent for? (e.g. "Family assistant for the immediate family group — handles home automation, shopping lists, and schedules", "Work assistant for the dev team — helps with code reviews and deployment status")

This purpose statement drives the skills selection in Phase 5.

## Phase 4: Channel & Trigger

**Channel** is inferred from the JID format or folder prefix. Confirm with the user:

| JID/folder pattern | Channel |
|---|---|
| `@g.us` / `whatsapp_` | WhatsApp |
| `tg:` / `telegram_` | Telegram |
| `slack_` | Slack |
| `discord_` | Discord |

**Trigger behaviour** — ask:

> Should this agent respond to all messages in the group, or only when triggered with `@Name`?
>
> - **All messages** — good for personal/solo chats or small trusted groups
> - **Trigger only** — good for larger groups where the agent should only respond when called

Set `requiresTrigger: false` for all-messages, `true` (default) for trigger-only.

**Trigger word** — defaults to `@{Name}`. Ask if they want a different trigger word.

## Phase 5: Skills

### Read available skills

```bash
ls /workspace/project/container/skills/
```

For each skill directory found, read its SKILL.md:

```bash
cat /workspace/project/container/skills/<skill-name>/SKILL.md
```

Read the full content of each — you are looking for:
- What the skill does (description + body)
- Environment variables it requires (look for `UPPER_CASE_VARS`, `.env` references, or explicit config sections)
- Filesystem paths or directories it needs access to (look for path references, mount requirements, or data directories)

### Propose a skill list

Based on the group's stated purpose from Phase 3, reason about which skills apply. Present your reasoning:

> Based on the purpose you described, here's what I'd suggest:
>
> **Include:**
> - `homeassistant` — the group handles home automation
> - `weather` — general utility, likely useful
>
> **Exclude:**
> - `movie-timings` — not relevant to this group's purpose
>
> Does this look right? Any skills to add or remove?

If the user is unsure what's available, list all skills with their one-line descriptions.

### Collect skill configuration

For each included skill that requires env vars or paths, ask for values:

> `weather` needs:
> - `WEATHER_LOCATION` — what location should this agent use? (e.g. "London, UK")

For skills that need filesystem paths (additional mounts):

> `homeassistant` needs access to your Home Assistant config directory.
> What is the path on your host? (e.g. `~/homeassistant`)
>
> Note: this path must be listed in `~/.config/nanoclaw/mount-allowlist.json` on your host before it can be mounted. If it isn't there yet, I'll include it in the config and you can add it to the allowlist before restarting.

Collect all values before moving on.

## Phase 6: Build CLAUDE.md

Compose a `CLAUDE.md` for the group. Use the main group's CLAUDE.md as a structural reference — it lives at `/workspace/project/groups/main/CLAUDE.md`.

A good group CLAUDE.md includes:

```markdown
# {Name}

{One paragraph describing the agent's role and the group it serves.}

## What You Can Do

{Bullet list of capabilities — derived from included skills and general tools.}

## Communication

Your output is sent to the group. Use `mcp__nanoclaw__send_message` to acknowledge before starting long tasks.

### Message Formatting

{Channel-specific formatting rules — see below.}

## Memory

The `conversations/` folder contains searchable history. When you learn something important, create files for it in your workspace.
```

**Channel formatting section** — include the relevant block only:

**WhatsApp / Telegram:**
```
- `*bold*` (single asterisks, never double)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks
- No `##` headings, no `[links](url)`, no `**double stars**`
```

**Slack:**
```
Use Slack mrkdwn. Run `/slack-formatting` for the full reference.
- `*bold*` `_italic_` `<url|text>` links
- `•` bullets, `:emoji:` shortcodes
- No `##` headings — use `*Bold text*` instead
```

**Discord:**
```
Standard Markdown: `**bold**`, `*italic*`, `[links](url)`, `# headings`.
```

Show the draft CLAUDE.md to the user and ask for confirmation or edits before writing it.

## Phase 7: Review & Apply

Show a full summary before making any changes:

```
Group: {name} ({jid})
Folder: {folder}
Trigger: {trigger word} / {all messages | trigger only}
Channel: {channel}

Skills: {list or "all"}
Skill config:
  weather: WEATHER_LOCATION=London, UK

Additional mounts:
  ~/homeassistant → /workspace/extra/homeassistant (read-write)

CLAUDE.md: ready to write
```

Ask: **"Apply this configuration?"**

If confirmed:

### 1. Write CLAUDE.md

```bash
cat > /workspace/project/groups/{folder}/CLAUDE.md << 'EOF'
{composed content}
EOF
```

If the folder doesn't exist yet, create it:

```bash
mkdir -p /workspace/project/groups/{folder}
```

### 2. Register the group

Call `mcp__nanoclaw__register_group` with:

```json
{
  "jid": "<jid>",
  "name": "<name>",
  "folder": "<folder>",
  "trigger": "<trigger>",
  "requiresTrigger": <true|false>,
  "containerConfig": {
    "skills": ["skill-a", "skill-b"],
    "skillConfig": {
      "weather": { "WEATHER_LOCATION": "London, UK" }
    },
    "additionalMounts": [
      {
        "hostPath": "~/homeassistant",
        "containerPath": "homeassistant",
        "readonly": true
      }
    ]
  }
}
```

Omit `skills` entirely if all skills should be available. Omit `containerConfig` entirely if there's nothing to configure.

### 3. Confirm

After the MCP call succeeds, tell the user:

> **{Name} is configured.**
>
> The agent will use this config from the next message it receives.
>
> {If mounts were added}: Ensure `{path}` is listed in `~/.config/nanoclaw/mount-allowlist.json` — mounts outside the allowlist are silently blocked.
