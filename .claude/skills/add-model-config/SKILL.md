---
name: add-model-config
description: Enable per-invocation model, effort, and thinking configuration for container agents. Required before roles or groups can specify which Claude model to use.
---

# Add Model Configuration

This skill adds optional `model`, `effort`, and `thinking` fields to `ContainerInput` so each container invocation can specify the Claude model and reasoning mode to use. Omitting them leaves SDK defaults unchanged.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "model\?:" src/container-runner.ts && echo "already applied" || echo "not applied"
```

If already applied, stop here.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream
git merge upstream/skill/model-mode-passthrough
```

If the merge reports conflicts in `package-lock.json`, resolve by taking theirs:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

For other conflicts, read both sides and resolve by intent.

This merges:
- `src/container-runner.ts` — adds `ThinkingConfig` type export and `model?`, `effort?`, `thinking?` fields to `ContainerInput`
- `container/agent-runner/src/index.ts` — imports `ThinkingConfig` from the SDK, adds the three fields to its local `ContainerInput`, and forwards them to `query()`

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Rebuild Container

The agent runner inside the container has changed, so the container image must be rebuilt:

```bash
./container/build.sh
```

Then restart the service:

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

All three are optional. Omitting them leaves the SDK defaults unchanged (existing behaviour is preserved).

## Removal

To remove:

1. Remove `ThinkingConfig` export and the three fields from `ContainerInput` in `src/container-runner.ts`
2. Remove the three fields from `ContainerInput` and the `query()` options in `container/agent-runner/src/index.ts`
3. Remove the `ThinkingConfig` import in `container/agent-runner/src/index.ts`
4. Rebuild: `npm run build && ./container/build.sh`
5. Restart the service
