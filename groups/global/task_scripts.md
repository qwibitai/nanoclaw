# Task Scripts — strict rules for recurring tasks

For any recurring task, use `schedule_task`. Frequent agent invocations — especially multiple times a day — consume API credits and can risk account restrictions.

## STRICT RULE: Script-gating is the default

Any task that fires more than once a day MUST include a bash `script` field that does the deterministic work and returns `{ "wakeAgent": false }` when there is nothing to do. The agent should only wake when there is genuinely a message to send, a decision that requires reasoning, or a state change worth recording. This is non-negotiable.

Before scheduling any recurring task, ask yourself: "Could a bash script make the wake/no-wake decision deterministically?" The answer is almost always yes — read state files, query the Sheets API directly via the calendar-mcp OAuth tokens at `/home/node/.config/google-calendar-mcp/{gcp-oauth.keys.json,tokens.json}` (see "Sheets API auth in scripts" below), compare against thresholds, decide. The agent is for *reasoning and composing messages*, not for *checking whether anything changed*.

## Sheets API auth in scripts

Gate scripts and in-container scripts that hit the Sheets API mint a short-lived access token from the calendar-mcp OAuth credentials. Do NOT reference `/home/node/.config/gcloud/application_default_credentials.json` — it is no longer mounted.

```js
import { readFileSync } from 'fs';
const KEYS_FILE = '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json';
const TOKENS_FILE = '/home/node/.config/google-calendar-mcp/tokens.json';
const keysRaw = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
const keys = keysRaw.installed || keysRaw.web;
const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    refresh_token: tokens.normal.refresh_token,
    grant_type: 'refresh_token',
  }).toString(),
});
const { access_token } = await tokenRes.json();
```

Both files are mounted into agent containers AND rewritten to host paths by the gate-script runner, so the same code works in both contexts.

If a user asks for a reminder, interval check, or recurring behavior, **default to designing it as a script-gated task** even if they don't ask for that. Don't ask permission to be efficient — just do it. Only fall back to a plain prompt-only task if the work genuinely requires LLM judgment on every run (e.g. a once-a-day briefing where every wake produces a real message).

## How it works

1. You provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — you wake up and receive the script's data + prompt

## Always test your script first

Before scheduling, run the script in your sandbox to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

## When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt.

## Frequent task guidance

If a user wants tasks running more than ~2x daily and a script can't reduce agent wake-ups:

- Explain that each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
