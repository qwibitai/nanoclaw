# Diagnostics (Optional)

After the update is complete, offer to send anonymous diagnostics.

## 1. Gather system info

```bash
node -p "require('./package.json').version"
uname -s
uname -m
node -p "process.versions.node.split('.')[0]"
git log -1 --format=%ci HEAD@{1} 2>/dev/null || echo "unknown"
```

The last command gets the date of the previous HEAD (before the update) to estimate version age.

## 2. Write the event

Write a JSON file to `/tmp/nanoclaw-diagnostics.json`. Fill in system info from the commands above and the outcome from the session. Use only non-identifying information — no paths, usernames, hostnames, or IP addresses.

```json
{
  "api_key": "phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP",
  "event": "update_complete",
  "distinct_id": "<generate a uuid>",
  "properties": {
    "success": true,
    "nanoclaw_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "version_age_days": 45,
    "update_method": "merge",
    "conflict_count": 0,
    "breaking_changes_found": false,
    "error_count": 0
  }
}
```

## 3. Show and ask

Show the contents of the file to the user and ask:

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show the entire JSON file)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 4. Handle response

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/nanoclaw-diagnostics.json
rm /tmp/nanoclaw-diagnostics.json
```
Confirm: "Diagnostics sent."

**No**: `rm /tmp/nanoclaw-diagnostics.json` — do nothing else.

**Never ask again**: Opt out of diagnostics in both setup and update-nanoclaw:
1. Replace the contents of `.claude/skills/setup/diagnostics.md` with just `# Diagnostics — opted out`
2. Replace the contents of `.claude/skills/update-nanoclaw/diagnostics.md` with just `# Diagnostics — opted out`
3. Remove the "Diagnostics (Optional)" section from the end of both `.claude/skills/setup/SKILL.md` and `.claude/skills/update-nanoclaw/SKILL.md`
4. `rm /tmp/nanoclaw-diagnostics.json`

Confirm: "Got it — you won't be asked again."
