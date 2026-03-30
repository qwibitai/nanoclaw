---
name: configure-group
description: Set the Claude model, effort level, and thinking mode for a group. Writes groups/<name>/model-config.json. Requires /add-model-config to be installed first.
---

# Configure Group Model

Set which Claude model a group uses. Writes `groups/<name>/model-config.json`, which the host reads on every invocation.

Requires `/add-model-config` to be installed. If it isn't, run that first.

## Step 1: List available groups

```bash
ls groups/
```

Show the user the list of group folders.

## Step 2: Ask which group to configure

Use `AskUserQuestion` to ask which group they want to configure. If the user has already told you, skip this.

## Step 3: Read the group's current config and CLAUDE.md

Check for an existing config:

```bash
cat groups/<name>/model-config.json 2>/dev/null || echo "(no config — using SDK defaults)"
```

Read the group's CLAUDE.md to understand its purpose:

```bash
cat groups/<name>/CLAUDE.md
```

## Step 4: Recommend a model

Based on what the group does, recommend the right model and explain your reasoning. Use this as a guide:

| Use case | Recommended | Reasoning |
|---|---|---|
| General chat, reminders, simple tasks | `haiku` | Fast and cheap; haiku handles most day-to-day assistant work well |
| Structured tasks, coding, analysis | `sonnet` | Better reasoning without the cost of opus |
| Deep research, complex planning | `opus` with `thinking: { "type": "adaptive" }` | Opus with adaptive thinking for tasks that benefit from extended reasoning |

For `effort`:
- Omit it for most cases (let the model decide)
- `"low"` for high-frequency lightweight tasks where speed matters
- `"max"` only for opus on tasks that need maximum reasoning depth

## Step 5: Confirm with the user

Present your recommendation with a short explanation. Ask if they want to use it or adjust.

## Step 6: Write the config

Write `groups/<name>/model-config.json`:

```json
{
  "model": "<model-id>",
  "effort": "<level>",
  "thinking": { "type": "adaptive" }
}
```

Only include fields the user wants to set. Omit `effort` and `thinking` unless explicitly needed — the SDK defaults are sensible.

Examples:

Haiku, no thinking config (most groups):
```json
{
  "model": "claude-haiku-4-5-20251001"
}
```

Opus with adaptive thinking (research/planning groups):
```json
{
  "model": "claude-opus-4-6",
  "thinking": { "type": "adaptive" }
}
```

## Step 7: Confirm

Show the user the written config and confirm the group will use it on the next invocation. No restart is needed — the config is read fresh on each message.
