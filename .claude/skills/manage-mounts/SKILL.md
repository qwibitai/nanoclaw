---
name: manage-mounts
description: Configure which host directories agent containers can access. View, add, or remove mount allowlist entries. Triggers on "mounts", "mount allowlist", "agent access to directories", "container mounts".
---

# Manage Mounts

Configure which host directories NanoClaw agent containers can access. The mount allowlist lives at `~/.config/nanoclaw/mount-allowlist.json`.

## Show Current Config

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "No mount allowlist configured"
```

Show the current config to the user in a readable format: which directories are allowed, whether non-main agents are read-only.

## Add Directories

Ask which directories the user wants agents to access. For each path:
- Validate the path exists
- Ask whether non-main agents should be allowed to **write** (default: no — i.e. read-only)

Build the JSON config and write it. Each `allowedRoots` entry **must** be an object with `path` (string) and `allowReadWrite` (boolean). Bare strings (e.g. `["/foo"]`) or `readOnly` keys are rejected by the validator with a clear error.

```bash
npx tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[{"path":"/path/to/dir","allowReadWrite":false,"description":"why this is mounted"}],"blockedPatterns":[],"nonMainReadOnly":true}'
```

Use `--force` to overwrite the existing config.

## Wire a mount into an agent group

The allowlist only declares what *can* be mounted. To actually mount a path into a specific agent group, add an entry to that group's `groups/<folder>/container.json` `additionalMounts` array. Each entry must use these keys (Docker shorthand `source`/`target`/`mode` is **not** accepted):

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/notes",
      "containerPath": "notes",
      "readonly": true
    }
  ]
}
```

- `hostPath` (required, string) — must resolve under one of the allowlist's `allowedRoots`.
- `containerPath` (optional, string) — **relative**; the mount lands at `/workspace/extra/<containerPath>`. Defaults to `basename(hostPath)`.
- `readonly` (optional, boolean) — host-side request. The mount is forced read-only if the agent group is non-main and the allowlist has `nonMainReadOnly: true`, or if the matching allowed root has `allowReadWrite: false`.

After editing `container.json`, kill any running container for that agent group so the next message spawns a fresh one with the new mount: `docker rm -f nanoclaw-v2-<folder>-*`.

## Remove Directories

Read the current config, show it, ask which entry to remove, write the updated config.

## Reset to Empty

```bash
npx tsx setup/index.ts --step mounts --force -- --empty
```

## After Changes

Restart the service so containers pick up the new config:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`
