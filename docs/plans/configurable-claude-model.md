# Configurable Claude Model for NanoClaw

## Context

NanoClaw's agent-runner calls the Claude Agent SDK's `query()` without a `model` parameter, so all groups use the SDK's default (currently Sonnet). There's no way to choose a different model — e.g. Opus for the main group or Haiku for low-stakes groups. This change adds a global default via env var with per-group overrides, following the existing pattern used by `CONTAINER_TIMEOUT` / `containerConfig.timeout`.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Scope | Global default + per-group override |
| Env var name | `CLAUDE_MODEL` |
| Per-group field | `containerConfig.model` |
| Default when unset | SDK default (don't pass `model` to `query()`) |
| Validation | None — accept any string, let the API reject bad values |
| Runtime config | Registration scripts only, no MCP tool |

## Implementation

### 1. Add `CLAUDE_MODEL` to host config (`src/config.ts`)

Read `CLAUDE_MODEL` from env/`.env`. Export it alongside existing config values. No default — `undefined` means "use SDK default".

### 2. Add `model` to `ContainerConfig` (`src/types.ts`)

Add optional `model?: string` field to the `ContainerConfig` interface.

### 3. Pass resolved model through `ContainerInput` (`src/types.ts`)

Add optional `model?: string` to `ContainerInput`. The host resolves precedence: `containerConfig.model ?? CLAUDE_MODEL ?? undefined`.

### 4. Set model in container-runner (`src/container-runner.ts`)

When building `ContainerInput`, resolve the model from per-group config falling back to global config, and include it in the stdin payload.

### 5. Use model in agent-runner (`container/agent-runner/src/index.ts`)

Read `containerInput.model` and pass it to `query()` options. Only include the `model` key if it's defined (so SDK default is preserved when unset).

### 6. Update `.env.example` (if it exists) or add a comment in `src/config.ts`

Document `CLAUDE_MODEL` alongside other env vars.

## Files to Modify

| File | Change |
|------|--------|
| `src/config.ts` | Add `CLAUDE_MODEL` env var reading |
| `src/types.ts` | Add `model?: string` to `ContainerConfig` and `ContainerInput` |
| `src/container-runner.ts` | Resolve model precedence, include in `ContainerInput` |
| `container/agent-runner/src/index.ts` | Pass `model` to `query()` options |

## Verification

1. **No model set**: Remove/unset `CLAUDE_MODEL`, ensure no `containerConfig.model` on any group. Trigger agent — should work exactly as before (SDK default).
2. **Global model**: Set `CLAUDE_MODEL=claude-haiku-4-5-20251001` in `.env`. Trigger agent — confirm via agent-runner logs that the model is passed to `query()`.
3. **Per-group override**: Set `CLAUDE_MODEL=claude-sonnet-4-6` globally, but set `containerConfig.model = 'claude-opus-4-6'` on main group. Trigger main group — should use Opus. Trigger another group — should use Sonnet.
4. **Build check**: `npm run build` passes with no type errors.
