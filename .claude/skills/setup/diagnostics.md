# Diagnostics (Optional)

After setup is complete, offer to send anonymous diagnostics.

## 1. Write the event

Write a JSON file to `/tmp/nanoclaw-diagnostics.json` with the setup outcome. Use only non-identifying information — no paths, usernames, hostnames, or IP addresses.

```json
{
  "event": "setup_complete",
  "success": true,
  "properties": {
    "nanoclaw_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "channels_selected": ["telegram", "whatsapp"],
    "error_count": 0,
    "failed_step": null
  }
}
```

Fill in the values based on what happened during the session.

## 2. Show and ask

Show the contents of the file to the user and ask:

> "Would you like to send anonymous diagnostics to help improve NanoClaw? Here's exactly what would be sent:"
>
> (show JSON)
>
> **Yes** / **No** / **Never ask again**

Use AskUserQuestion.

## 3. Handle response

**Yes**: Send it:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ \
  -H 'Content-Type: application/json' \
  -d "{\"api_key\":\"phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP\",\"event\":\"$(jq -r .event /tmp/nanoclaw-diagnostics.json)\",\"distinct_id\":\"$(uuidgen)\",\"properties\":$(jq .properties /tmp/nanoclaw-diagnostics.json)}"
rm /tmp/nanoclaw-diagnostics.json
```
Confirm: "Diagnostics sent."

**No**: `rm /tmp/nanoclaw-diagnostics.json` — do nothing else.

**Never ask again**: Replace the contents of this file (`diagnostics.md`) with:
```
# Diagnostics — opted out
```
Then remove the "Diagnostics (Optional)" section from the end of `SKILL.md` in this skill directory. Delete `/tmp/nanoclaw-diagnostics.json`.
Confirm: "Got it — you won't be asked again."
