---
name: add-model-config
description: Enable per-group model, effort, and thinking configuration for container agents. Stores config in the group's containerConfig in the database and passes it to the agent SDK on every invocation.
---

# Add Model Configuration

This skill adds optional `model`, `effort`, and `thinking` fields to `ContainerInput` and wires up the host to read them from the group's `containerConfig` in the database. Omitting config leaves SDK defaults unchanged — existing behaviour is fully preserved.

Use `/configure-group` after this skill to set the model config for individual groups.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "ThinkingConfig" src/types.ts && echo "already applied" || echo "not applied"
```

If already applied, stop here.

## Phase 2: Edit source files

### 1. `src/types.ts` — add ThinkingConfig and three fields to ContainerConfig

Add the `ThinkingConfig` exported type directly above the `ContainerConfig` interface:

```typescript
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };
```

Inside `ContainerConfig`, add three optional fields after `timeout?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

### 2. `src/container-runner.ts` — add three fields to ContainerInput

Inside the `ContainerInput` interface, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: import('./types.js').ThinkingConfig;
```

### 3. `container/agent-runner/src/index.ts` — import ThinkingConfig and extend ContainerInput

Add `ThinkingConfig` to the existing SDK import:

```typescript
import {
  query,
  HookCallback,
  PreCompactHookInput,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
```

Inside the local `ContainerInput` interface, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

In `runQuery()`, find the `query()` call and add the three fields just before the `env:` line:

```typescript
      model: containerInput.model,
      effort: containerInput.effort,
      thinking: containerInput.thinking,
```

### 4. `src/index.ts` — pass model config from group.containerConfig

Find the `runContainerAgent` call in the message handler (search for `groupFolder: group.folder,`). Pass the model fields from `containerConfig`:

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
        model: group.containerConfig?.model,
        effort: group.containerConfig?.effort,
        thinking: group.containerConfig?.thinking,
      },
```

### 5. `src/task-scheduler.ts` — same for scheduled tasks

The task scheduler already looks up the full group object. Find the `runContainerAgent` call (search for `isScheduledTask: true,`) and pass the model fields from `group.containerConfig`:

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
        model: group.containerConfig?.model,
        effort: group.containerConfig?.effort,
        thinking: group.containerConfig?.thinking,
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

Use `/configure-group` to set the model config for individual groups interactively. Config is stored in the database alongside other group settings — no restart needed after changes.

Model shorthands supported by the SDK:

| Shorthand | Model |
|-----------|-------|
| `haiku`   | claude-haiku-4-5 |
| `sonnet`  | claude-sonnet-4-6 |
| `opus`    | claude-opus-4-6 |

All three fields are optional. Groups without config use SDK defaults.

## Removal

1. Remove `ThinkingConfig` type and the three fields from `ContainerConfig` in `src/types.ts`
2. Remove the three fields from `ContainerInput` in `src/container-runner.ts`
3. Remove `ThinkingConfig` from the import, the three fields from local `ContainerInput`, and the three lines from `query()` options in `container/agent-runner/src/index.ts`
4. Remove the `model/effort/thinking` lines from the `runContainerAgent` calls in `src/index.ts` and `src/task-scheduler.ts`
5. `npm run build && ./container/build.sh` and restart
