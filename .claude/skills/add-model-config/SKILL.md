---
name: add-model-config
description: Enable per-invocation model, effort, and thinking configuration for container agents. Required before roles or groups can specify which Claude model to use.
---

# Add Model Configuration

This skill adds optional `model`, `effort`, and `thinking` fields to `ContainerInput` so each container invocation can specify the Claude model and reasoning mode. Omitting them leaves SDK defaults unchanged — existing behaviour is fully preserved.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "model\?:" src/container-runner.ts && echo "already applied" || echo "not applied"
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

Then, inside `ContainerInput`, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

### 2. `container/agent-runner/src/index.ts` — import ThinkingConfig and extend ContainerInput

At the top of the file, add `ThinkingConfig` to the existing SDK import:

```typescript
import { query, HookCallback, PreCompactHookInput, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
```

Inside the local `ContainerInput` interface, add three optional fields after `script?`:

```typescript
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;
```

In `runQuery()`, find the `query()` call. Add the three fields to its options, just before the `env:` line:

```typescript
      model: containerInput.model,
      effort: containerInput.effort,
      thinking: containerInput.thinking,
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

Container invocations now accept three optional fields on `ContainerInput`:

| Field | Type | Description |
|---|---|---|
| `model` | `string` | Claude model ID (e.g. `claude-haiku-4-5-20251001`) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | Reasoning effort level |
| `thinking` | `ThinkingConfig` | `{ type: 'adaptive' }`, `{ type: 'enabled', budgetTokens?: number }`, or `{ type: 'disabled' }` |

## Removal

1. Remove `ThinkingConfig` and the three fields from `ContainerInput` in `src/container-runner.ts`
2. Remove `ThinkingConfig` from the import, the three fields from `ContainerInput`, and the three lines from `query()` options in `container/agent-runner/src/index.ts`
3. `npm run build && ./container/build.sh` and restart
