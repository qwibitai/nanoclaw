---
name: set-group-model
description: Configure the Claude model used by a specific group. Allows setting a different model per group (e.g. Haiku for lightweight groups, Sonnet for power users). Covers initial setup of the feature and changing the model of any group at any time.
---

# Set Group Model

Configure which Claude model a group's container agent uses. By default all groups
use whatever model the Claude Code SDK selects. This skill lets you override that
per group — useful for running cheaper models on lightweight groups or expensive
models on high-priority ones.

## Phase 1 — Pre-flight

Check if the feature is already applied:

```bash
grep -n "AGENT_MODEL" src/container-runner.ts 2>/dev/null && echo "Already applied" || echo "Not applied"
grep -n "model\?" src/types.ts 2>/dev/null && echo "types: OK" || echo "types: needs update"
```

Skip to Phase 3 if already applied.

## Phase 2 — Apply code changes

Three files need to be edited. Make all changes before building.

### Change 1 — `src/types.ts`

Add the `model` field to `ContainerConfig`:

```ts
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  model?: string;   // Override default model (e.g. 'claude-haiku-4-5-20251001')
}
```

### Change 2 — `src/container-runner.ts`

After the line `const containerArgs = buildContainerArgs(mounts, containerName);`
and before the `logger.debug(...)` call, insert:

```ts
// Per-group model override
if (group.containerConfig?.model) {
  containerArgs.push('-e', `AGENT_MODEL=${group.containerConfig.model}`);
}
```

### Change 3 — `container/agent-runner/src/index.ts`

**In `runQuery`:** after the variable declarations at the top of the function
(`let messageCount`, `let resultCount`, etc.), add:

```ts
const agentModel = process.env.AGENT_MODEL || undefined;
```

Then in the `query(...)` options object (inside `for await (const message of query({...})`),
spread the model after `resumeSessionAt`:

```ts
...(agentModel ? { model: agentModel } : {}),
```

**In `main`:** after the pending messages are appended to `prompt` and before
the slash-command handling block, add:

```ts
const agentModel = process.env.AGENT_MODEL || undefined;
```

Then in the `query(...)` options inside the `/compact` slash-command handler
(the one with `resume: sessionId`), spread the model:

```ts
...(agentModel ? { model: agentModel } : {}),
```

## Phase 3 — Build and deploy

```bash
npm run build
docker build -t nanoclaw-agent:latest -f ~/nanoclaw/container/Dockerfile ~/nanoclaw/container/
systemctl --user restart nanoclaw
```

## Phase 4 — Set the model for a group

### Ask the user

AskUserQuestion: Which group should use a custom model, and what model ID should it use?

Common model IDs:
- `claude-haiku-4-5-20251001` — fastest and cheapest
- `claude-sonnet-4-6` — balanced (default)
- `claude-opus-4-6` — most capable

### Look up the group folder

```bash
sqlite3 ~/nanoclaw/store/messages.db "SELECT folder, name, container_config FROM registered_groups;"
```

### Apply the model override

Read the current `container_config` for the group first (it may already have mounts
or a timeout). Then run a script that merges the model into the existing config:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/nanoclaw/store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('<folder>');
const cfg = row?.container_config ? JSON.parse(row.container_config) : {};
cfg.model = '<model-id>';
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(cfg), '<folder>');
db.close();
console.log('Done:', JSON.stringify(cfg));
"
```

Confirm the output shows the correct config.

### Clear the session cache for the group

```bash
rm -rf ~/nanoclaw/data/sessions/<folder>/agent-runner-src
```

This forces the next container run to use the updated configuration.

### Verify

Send a test message to the group and check the logs:

```bash
tail -n 50 ~/nanoclaw/logs/nanoclaw.log | grep -E "AGENT_MODEL|model|<folder>"
```

## Removing a model override

To revert a group to the default model, remove the `model` key from its config:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/nanoclaw/store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('<folder>');
const cfg = row?.container_config ? JSON.parse(row.container_config) : {};
delete cfg.model;
const val = Object.keys(cfg).length ? JSON.stringify(cfg) : null;
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(val, '<folder>');
db.close();
console.log('Done:', val);
"
```

Then clear the session cache and restart:

```bash
rm -rf ~/nanoclaw/data/sessions/<folder>/agent-runner-src
systemctl --user restart nanoclaw
```

## Phase 5 — Enable `/model` command from Telegram

This phase adds a `/model` slash command so the group owner can change the model
directly from Telegram without CLI access.

### Pre-flight

```bash
grep -n "OWNER_TELEGRAM_ID" src/config.ts 2>/dev/null && echo "Already applied" || echo "Not applied"
```

Skip to **Configure** if already applied.

### Change 1 — `src/config.ts`

Update the `readEnvFile` call to include `'OWNER_TELEGRAM_ID'`, then add the export
at the end of the file:

```ts
// In the readEnvFile call at the top:
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'OWNER_TELEGRAM_ID']);

// At the end of the file:
// Optional: Telegram user ID that can run session commands (/model, /compact) in any group.
export const OWNER_TELEGRAM_ID: string | undefined =
  process.env.OWNER_TELEGRAM_ID || envConfig.OWNER_TELEGRAM_ID || undefined;
```

### Change 2 — `src/session-commands.ts`

Four changes to this file:

**a) Add model aliases and `parseModelCommand`** before `extractSessionCommand`:

```ts
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export type ModelCommandAction =
  | { type: 'set'; model: string }
  | { type: 'clear' }
  | { type: 'show' }
  | { type: 'invalid'; arg: string };

export function parseModelCommand(text: string): ModelCommandAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/model')) return null;
  const rest = trimmed.slice('/model'.length).trim();
  if (rest === '') return { type: 'show' };
  if (rest === 'default') return { type: 'clear' };
  const alias = MODEL_ALIASES[rest.toLowerCase()];
  if (alias) return { type: 'set', model: alias };
  return { type: 'invalid', arg: rest };
}
```

**b) Extend `extractSessionCommand`** — after the `/compact` check, add:

```ts
if (/^\/model(\s+\S+)?$/.test(text)) return text;
```

**c) Extend `isSessionCommandAllowed`** to accept sender and ownerTelegramId:

```ts
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
  sender?: string,
  ownerTelegramId?: string,
): boolean {
  if (isMainGroup || isFromMe) return true;
  if (ownerTelegramId && sender && sender === ownerTelegramId) return true;
  return false;
}
```

**d) Add 3 fields to `SessionCommandDeps`** interface and a `handleModelCommand` function.
See `src/session-commands.ts` in the repo for the full implementation — the new deps are
`updateGroupModel`, `clearSessionCache`, and `currentModel`.

**e) Add `/model` short-circuit in `handleSessionCommand`** — after the auth check passes,
before the pre-compact block:

```ts
if (command.startsWith('/model')) {
  const action = parseModelCommand(command);
  if (action) await handleModelCommand(action, deps);
  deps.advanceCursor(cmdMsg.timestamp);
  return { handled: true, success: true };
}
```

### Change 3 — `src/index.ts`

**a) Add `OWNER_TELEGRAM_ID` to the config import.**

**b) Pass it to `handleSessionCommand`:**

```ts
await handleSessionCommand({
  // ... existing fields ...
  ownerTelegramId: OWNER_TELEGRAM_ID,
  deps: {
    // ... existing deps ...
    updateGroupModel: async (model) => { /* update registeredGroups + setRegisteredGroup */ },
    clearSessionCache: () => { /* fs.rmSync data/sessions/{folder}/agent-runner-src */ },
    currentModel: () => group.containerConfig?.model,
  },
});
```

**c) Update the second `isSessionCommandAllowed` call** in `startMessageLoop`:

```ts
isSessionCommandAllowed(isMainGroup, loopCmdMsg.is_from_me === true, loopCmdMsg.sender, OWNER_TELEGRAM_ID)
```

### Build

```bash
npm run build
systemctl --user restart nanoclaw
```

No Docker rebuild needed — this feature runs entirely in the host process.

### Configure

Add your Telegram user ID to `.env`:

```
OWNER_TELEGRAM_ID=123456789
```

To find your ID: send `/chatid` to the bot in any Telegram group.
Then restart the service: `systemctl --user restart nanoclaw`

### Usage

| Command | Effect |
|---------|--------|
| `/model` | Show current model |
| `/model sonnet` | Switch to `claude-sonnet-4-6` |
| `/model haiku` | Switch to `claude-haiku-4-5-20251001` |
| `/model opus` | Switch to `claude-opus-4-6` |
| `/model default` | Remove override (revert to SDK default) |

Works in any Telegram group where you are the `OWNER_TELEGRAM_ID`, and in the main
group for any sender (existing behavior). Also enables `/compact` from non-main groups
for the owner.

---

## How it works

- `containerConfig.model` is stored as JSON in the `container_config` SQLite column.
- When the container starts, `container-runner.ts` injects `AGENT_MODEL` as an
  environment variable if the field is set.
- Inside the container, `agent-runner/src/index.ts` reads `AGENT_MODEL` and passes
  it as the `model` option to the Claude Code SDK `query()` call.
- Groups without a `model` override use the SDK's default model selection.
- The override applies to both normal queries and slash commands (e.g. `/compact`).
