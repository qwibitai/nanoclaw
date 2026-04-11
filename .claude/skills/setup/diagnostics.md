# Diagnostics

Gather system info:

```bash
node -p "require('./package.json').version"
uname -s
uname -m
node -p "process.versions.node.split('.')[0]"
```

Check if the user migrated from OpenClaw during this setup session (i.e. `/migrate-from-openclaw` was invoked). If you're unsure (e.g. after context compaction), check for `migration-state.md` in the project root — it exists during and sometimes after migration.

Write `/tmp/argus-diagnostics.json`. No paths, usernames, hostnames, or IP addresses.

```json
{
  "api_key": "phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP",
  "event": "setup_complete",
  "distinct_id": "<uuid>",
  "properties": {
    "success": true,
    "argus_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "channels_selected": ["telegram", "whatsapp"],
    "migrated_from_openclaw": false,
    "error_count": 0,
    "failed_step": null
  }
}
```

Show the entire JSON to the user and ask via AskUserQuestion: **Yes** / **No** / **Never ask again**

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/argus-diagnostics.json
rm /tmp/argus-diagnostics.json
```

**No**: `rm /tmp/argus-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/setup/diagnostics.md` with `# Diagnostics — opted out`
2. Replace contents of `.claude/skills/update-argus/diagnostics.md` with `# Diagnostics — opted out`
3. Remove the `## 9. Diagnostics` section from `.claude/skills/setup/SKILL.md` and the `## Diagnostics` section from `.claude/skills/update-argus/SKILL.md`
4. `rm /tmp/argus-diagnostics.json`
