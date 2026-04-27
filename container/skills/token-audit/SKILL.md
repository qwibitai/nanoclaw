# Token Audit Skill

Use this skill when Gabe asks about token usage, API costs, or "why is Nano expensive."

## Current token budget per container spawn

| Component | Size | Tokens (~4 chars) |
|---|---|---|
| global CLAUDE.md | 10 KB | ~2,500 |
| nanoclawrules.md | 25 KB | ~6,300 |
| telegram_main CLAUDE.md + MEMORY.md | ~5 KB | ~1,200 |
| **Total system prompt** | **~40 KB** | **~10,000** |

This cost is paid on EVERY spawn — each email batch, each Telegram message, each scheduled task.

## What drives spawn frequency

1. Email batches: up to 20 emails per spawn (MAX_MESSAGES_PER_PROMPT=20 in .env)
2. Scheduled tasks: 7 active tasks, each spawns its own container
3. Telegram messages from Gabe: each triggers a spawn

## Settings that control cost (.env)

- `IDLE_TIMEOUT=900000` — sessions expire after 15 min idle; shorter = less accumulated history replayed on resume
- `MAX_MESSAGES_PER_PROMPT=20` — emails batched together; higher = fewer spawns
- `OUTLOOK_AUTO_CATEGORIZE=false` — Serif owns categorization; never enable this

## How to reduce cost

1. Trim nanoclawrules.md — target under 20 KB. Remove verbose examples, consolidate duplicate sections.
2. Add script gates to scheduled tasks that can check a condition before waking the agent.
3. Keep workspace clean — run `du -sh ~/projects/nanoclaw/groups/telegram_main/` to check size. Target under 200 MB.

## Workspace cleanup (run monthly or when workspace > 500 MB)

```bash
# Purge conversation transcripts older than 7 days
find ~/projects/nanoclaw/groups/telegram_main/conversations -name "*.md" -mtime +7 -delete

# Keep only last 3 days of coo-prefetch data
PREFETCH=/Users/gabrielratner/projects/nanoclaw/groups/telegram_main/coo-prefetch
DIRS=($(ls -d "${PREFETCH}"/2*/ 2>/dev/null | sort))
COUNT=${#DIRS[@]}
if [ $COUNT -gt 3 ]; then
  for i in $(seq 0 $((COUNT-4))); do rm -rf "${DIRS[$i]}"; done
fi
```

The weekly-restart.sh runs this automatically every Sunday at 3am.
