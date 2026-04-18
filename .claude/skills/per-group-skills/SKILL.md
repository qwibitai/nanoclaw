---
name: per-group-skills
description: Configure which container skills each agent group can access, and pass per-skill configuration (e.g. location, API endpoint) per group. Enables skill isolation so a homeassistant skill only reaches the family group, a weather skill uses different locations per group, etc.
---

# Per-Group Container Skills

This skill patches NanoClaw so each group can declare an allowlist of container skills and per-skill env var config, then walks through configuring your groups.

## Phase 1: Pre-flight

### Check if already applied

Check whether `src/types.ts` contains a `skills?: string[]` field on `ContainerConfig`. If it does, the code is already in place — skip to Phase 2 (Configuration).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/per-group-skills
git merge origin/skill/per-group-skills
```

This merges two small changes:

- `src/types.ts` — adds `skills?: string[]` and `skillConfig?` to `ContainerConfig`
- `src/container-runner.ts` — filters the skills sync loop and injects `skillConfig` env vars into each group's `settings.json`

Resolve any conflicts by reading both sides and preserving intent.

### Validate

```bash
npm run build
```

Build must be clean before continuing.

## Phase 3: Configuration

### Understand the semantics

| `containerConfig.skills` value | Effect |
|---|---|
| absent (default) | All container skills synced — existing behaviour, no change |
| `[]` | No skills synced |
| `["foo", "bar"]` | Only those skills synced |

`skillConfig` is a map of skill name → env vars injected into the group's `.claude/settings.json` on every container start.

### Ask the user

Use `AskUserQuestion` to collect:

1. Which groups should have restricted skill sets?
2. For each group: which skills should it receive?
3. Are any skills configured differently per group (e.g. weather location)?

### Apply configuration

For each group the user wants to configure, update its `containerConfig` via the main agent's register IPC command, or directly in SQLite:

```bash
sqlite3 store/messages.db \
  "UPDATE registered_groups SET container_config = '<json>' WHERE folder = '<folder>'"
```

Example — family group with homeassistant + weather (London):
```json
{
  "skills": ["homeassistant", "weather"],
  "skillConfig": {
    "weather": { "WEATHER_LOCATION": "London, UK" }
  }
}
```

Example — work group with weather only (New York), no other skills:
```json
{
  "skills": ["weather"],
  "skillConfig": {
    "weather": { "WEATHER_LOCATION": "New York, US" }
  }
}
```

Example — group that should receive all skills (default, no config needed):
```json
{}
```

### Restart to apply

Configuration is read at container start, so a service restart is not required — changes take effect the next time each group's container runs.

## Troubleshooting

### Skills still appearing after restriction

The skills directory is only written at container start. If a container was already running, it won't see the change until the next invocation. Verify by checking `data/sessions/<folder>/.claude/skills/` after the next message.

### skillConfig env vars not reaching the container

`settings.json` must exist before `skillConfig` is injected. It is created on the first container start. If you configured `skillConfig` before the group ever ran a container, send one message to the group first, then update the config.

### Build fails after merge

Read the compiler errors. The two changed files are `src/types.ts` and `src/container-runner.ts` — conflicts are unlikely but straightforward to resolve manually.

## Removal

To remove this feature:

1. Delete `skillConfig` and `skills` fields from any groups that use them (SQLite update above, set `container_config` back to `null` or `{}`)
2. Revert the two changed files: `git checkout main -- src/types.ts src/container-runner.ts`
3. `npm run build`
