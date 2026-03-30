---
name: add-model-config
description: Enable per-group model, effort, and thinking configuration for container agents. Reads a model-config.json from each group's folder and passes it to the agent SDK on every invocation.
---

# Add Model Configuration

This skill adds optional `model`, `effort`, and `thinking` fields to `ContainerInput` and wires up the host to read per-group config from `groups/<name>/model-config.json`. Omitting the config file leaves SDK defaults unchanged — existing behaviour is fully preserved.

Use `/configure-group` after this skill to set the model config for individual groups.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "model-config.json" src/index.ts && echo "already applied" || echo "not applied"
```

If already applied, stop here.

## Phase 2: Edit source files

### 1. `src/container-runner.ts` — add ThinkingConfig type and three fields to ContainerInput

Find the `ContainerInput` interface (search for `export interface ContainerInput`). Directly above it, add the `ThinkingConfig` type:

```typescript
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };
```

Inside `ContainerInput`, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

### 2. `container/agent-runner/src/index.ts` — import ThinkingConfig and extend ContainerInput

Add `ThinkingConfig` to the existing SDK import line:

```typescript
import { query, HookCallback, PreCompactHookInput, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
```

Inside the local `ContainerInput` interface, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

In `runQuery()`, find the `query()` call and add the three fields to its options just before the `env:` line:

```typescript
      model: containerInput.model,
      effort: containerInput.effort,
      thinking: containerInput.thinking,
```

### 3. `src/index.ts` — read model config and pass it to runContainerAgent

Add a helper function after the imports, before the first function definition:

```typescript
function readGroupModelConfig(folder: string): { model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; thinking?: import('./container-runner.js').ThinkingConfig } {
  try {
    const configPath = path.join(resolveGroupFolderPath(folder), 'model-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // ignore malformed config
  }
  return {};
}
```

Find the `runContainerAgent` call in the message handler (search for `groupFolder: group.folder,`). Spread the model config into the `ContainerInput`:

```typescript
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...readGroupModelConfig(group.folder),
      },
```

### 4. `src/task-scheduler.ts` — same for scheduled tasks

Add the same helper function after the imports in `task-scheduler.ts`:

```typescript
function readGroupModelConfig(folder: string): { model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; thinking?: import('./container-runner.js').ThinkingConfig } {
  try {
    const configPath = path.join(resolveGroupFolderPath(folder), 'model-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // ignore malformed config
  }
  return {};
}
```

Find the `runContainerAgent` call (search for `isScheduledTask: true,`). Spread the model config into the `ContainerInput`:

```typescript
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        ...readGroupModelConfig(task.group_folder),
      },
```

## Phase 3: Validate and rebuild

```bash
npm run build
```

Build must be clean. Then rebuild the container image (the agent runner inside has changed):

```bash
./container/build.sh
```

Restart the service:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## After Installation

Create `groups/<name>/model-config.json` to set the model for a group, or run `/configure-group` to do it interactively.

Example config file:

```json
{
  "model": "haiku",
  "effort": "low"
}
```

```json
{
  "model": "opus",
  "thinking": { "type": "adaptive" }
}
```

All three fields are optional. An empty or missing config file leaves SDK defaults unchanged.

## Removal

1. Remove `ThinkingConfig` and the three fields from `ContainerInput` in `src/container-runner.ts`
2. Remove `ThinkingConfig` from the import, the three fields from `ContainerInput`, and the three lines from `query()` options in `container/agent-runner/src/index.ts`
3. Remove `readGroupModelConfig` and the `...readGroupModelConfig(...)` spreads from `src/index.ts` and `src/task-scheduler.ts`
4. `npm run build && ./container/build.sh` and restart
