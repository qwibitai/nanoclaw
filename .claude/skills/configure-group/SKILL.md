---
name: configure-group
description: Set the Claude model, effort level, and thinking mode for a group. Updates the group's containerConfig in the database. Requires /add-model-config to be installed first.
---

# Configure Group Model

Set which Claude model a group uses. Updates the group's `containerConfig` in the database, which the host reads on every invocation.

Requires `/add-model-config` to be installed. If it isn't, run that first.

## Step 1: List available groups

```bash
sqlite3 store/messages.db "SELECT folder, name, container_config FROM registered_groups ORDER BY added_at"
```

Show the user the list of groups with their current model config (parsed from `container_config` JSON).

## Step 2: Ask which group to configure

Use `AskUserQuestion` to ask which group they want to configure. If the user has already told you, skip this.

## Step 3: Read the group's current config and CLAUDE.md

Read the current `containerConfig` for the group:

```bash
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder='<name>'"
```

Read the group's CLAUDE.md to understand its purpose:

```bash
cat groups/<name>/CLAUDE.md
```

## Step 4: Recommend a model

Based on what the group does, recommend the right model and explain your reasoning:

| Use case | Recommended | Reasoning |
|---|---|---|
| General chat, reminders, simple tasks | `haiku` | Fast and cheap; handles most day-to-day work well |
| Structured tasks, coding, analysis | `sonnet` | Better reasoning without the cost of opus |
| Deep research, complex planning | `opus` + `thinking: adaptive` | Extended reasoning for tasks that benefit from it |

For `effort`:
- Omit for most cases (let the model decide)
- `"low"` for high-frequency lightweight tasks where speed matters
- `"max"` only for opus on tasks that need maximum reasoning depth

## Step 5: Confirm with the user

Present your recommendation with a short explanation. Ask if they want to use it or adjust.

## Step 6: Update the database

Read the group's full record, merge the model config into `containerConfig`, and write it back using `npx tsx`:

```bash
npx tsx -e "
import { getAllRegisteredGroups, setRegisteredGroup } from './src/db.js';
const groups = getAllRegisteredGroups();
const entry = Object.entries(groups).find(([, g]) => g.folder === '<name>');
if (!entry) { console.error('Group not found'); process.exit(1); }
const [jid, group] = entry;
group.containerConfig = {
  ...group.containerConfig,
  model: '<model>',
  effort: '<effort>',        // omit if not needed
  thinking: { type: 'adaptive' },  // omit if not needed
};
setRegisteredGroup(jid, group);
console.log('Updated');
"
```

Only include the fields the user wants to set. To clear a field, set it to `undefined` (omit it from the object spread).

Examples:

Haiku with no extra config (most groups):
```typescript
group.containerConfig = { ...group.containerConfig, model: 'haiku' };
```

Opus with adaptive thinking:
```typescript
group.containerConfig = { ...group.containerConfig, model: 'opus', thinking: { type: 'adaptive' } };
```

To clear model config entirely:
```typescript
const { model, effort, thinking, ...rest } = group.containerConfig ?? {};
group.containerConfig = rest;
```

## Step 7: Confirm

Show the user the updated config and confirm the group will use it on the next invocation. No restart is needed — the config is read from the database on each message.
