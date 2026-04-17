# Cross-group memory ↔ Claude Code compatibility

NanoClaw's shared memory store at `groups/global/memory/` uses the same
file format as Claude Code's auto-memory feature. This means you can mount
NanoClaw's memory into your laptop CC sessions (or vice versa) for "one
shared brain."

## Current state

- NanoClaw containers see `groups/global/memory/` mounted at
  `/workspace/global/memory/`. The agent reads `MEMORY.md` automatically
  via `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
- All writes to the store happen host-side via the extractor, the
  verifier, and the `remember` IPC tool. Containers never write the store
  directly — the `remember` tool drops a JSON file into the per-group IPC
  directory and the host's `ipc.ts` consumes it.

## File format

Each fact is a markdown file with YAML frontmatter:

```markdown
---
name: <short title>
description: <one-line summary>
type: user | feedback | project | reference
scopes: [optional, scope, tags]
count: <int>
first_seen: <ISO date>
last_seen: <ISO date>
last_value: <optional>
sources: { <groupName>: <count>, ... }
history: [<prior bodies, newest first, capped at 5>]
---

<body — 1-3 paragraphs>
```

This matches CC's auto-memory expectations. CC ignores fields it does not
recognize (`count`, `sources`, etc.) and uses `name`, `description`,
`type`, and the body.

## Mounting NanoClaw memory into CC

When you're ready to make NanoClaw and CC share one store, add the path
to your CC settings. In `~/.claude/settings.json`:

```json
{
  "additionalDirectories": [
    "/path/to/nanoclaw/groups/global/memory"
  ]
}
```

CC will load `MEMORY.md` from that directory in addition to its own
auto-memory.

## Mounting CC memory into NanoClaw containers

To go the other direction (NanoClaw containers see CC's auto-memory),
change the mount source in `src/container-runner.ts`. Find the block that
mounts `groups/global/`:

```typescript
const globalDir = path.join(GROUPS_DIR, 'global');
```

Add a second mount for the host CC memory dir:

```typescript
const ccMemDir = path.join(
  os.homedir(),
  '.claude/projects/-Users-<you>-dev-nanoclaw/memory',
);
if (fs.existsSync(ccMemDir)) {
  mounts.push({
    hostPath: ccMemDir,
    containerPath: '/workspace/cc-memory',
    readonly: true,
  });
}
```

Then enable CC inside the container to read it via the same
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` mechanism.

## Reconciliation

Both stores can drift independently. To reconcile (e.g. before enabling
the cross-mount), copy or symlink one into the other and let the verifier
dedupe by name collision on its next sweep.

## Per-group extraction allowlist

Set `NANOCLAW_MEMORY_EXTRACT_GROUPS=group1,group2` to restrict auto-extraction to specific
group folders during rollout or smoke testing. Unset or empty = extract from all groups.
The verifier (and the explicit `remember` tool) ignore this — they always run for all
candidates that reach disk.
