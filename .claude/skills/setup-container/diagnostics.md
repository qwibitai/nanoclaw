# Diagnostics

Gather system info using only shell commands (no Node.js on host):

```bash
uname -s
uname -m
podman --version
podman image ls nanoclaw-agent nanoclaw-host nanoclaw-setup --format "{{.Repository}}:{{.Tag}} {{.Size}}"
podman ps --filter name=nanoclaw-host --format "{{.Names}} {{.Status}}"
node --version 2>/dev/null || echo "node: not on host (expected)"
```

Check NanoClaw version:
```bash
grep '"version"' package.json | head -1
```

Write `/tmp/nanoclaw-diagnostics.json`. No paths, usernames, hostnames, or IP addresses.

```json
{
  "api_key": "phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP",
  "event": "setup_complete",
  "distinct_id": "<uuid>",
  "properties": {
    "success": true,
    "nanoclaw_version": "1.2.49",
    "os_platform": "linux",
    "arch": "x86_64",
    "node_major_version": null,
    "setup_mode": "container-first",
    "container_runtime": "podman",
    "channels_selected": ["telegram"],
    "migrated_from_openclaw": false,
    "error_count": 0,
    "failed_step": null
  }
}
```

Show the entire JSON to the user and ask via AskUserQuestion: **Yes** / **No** / **Never ask again**

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/nanoclaw-diagnostics.json
rm /tmp/nanoclaw-diagnostics.json
```

**No**: `rm /tmp/nanoclaw-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/setup-container/diagnostics.md` with `# Diagnostics — opted out`
2. Remove the `## 9. Diagnostics` section from `.claude/skills/setup-container/SKILL.md`
3. `rm /tmp/nanoclaw-diagnostics.json`
