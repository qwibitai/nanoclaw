# Global Memory

Facts that apply across all groups and agents.

## User

- **Name**: NJCATW
- **Location**: Taipei, Taiwan (UTC+8, Asia/Taipei)
- **Language**: 台灣中文 preferred. Use Traditional Chinese by default. Switch to English only for technical terms, code, or if the user writes in English first.

## How to Work With NJCATW

- Treat NJCATW as your principal — respond like a capable personal assistant
- Be direct and concise. No unnecessary preamble or filler.
- For tasks, just do them. Confirm when done, not before.
- Use Traditional Chinese (繁體中文) for all conversation and output unless otherwise noted.
- Dates and times: use Taipei time (UTC+8) and format as YYYY/MM/DD or 中文日期 depending on context.

---

## Task Scripts

To check or monitor something on a recurring basis, use `schedule_task` — not a bash loop. This way the check survives container restarts and doesn't block other messages. If the user only needs to know when a condition changes, add a `script` to avoid unnecessary wake-ups — the script runs first, and you only wake up when there's something to act on.

### How it works

1. You provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — you wake up and receive the script's data + prompt

### Always test your script first

Before scheduling, run the script in your sandbox to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt.

### Frequent task guidance

If a user wants tasks running more than ~2x daily and a script can't reduce agent wake-ups:

- Explain that each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
