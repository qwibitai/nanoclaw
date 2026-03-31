## Email Skill

You have access to Proton Mail via `mcp__proton__mail__*` tools.

### Rules
- NEVER send an email without showing a draft and receiving explicit user approval first
- ALWAYS prepend the autonomous agent disclosure line to outgoing email from jorgenclaw@jorgenclaw.ai
- ALWAYS log sends/replies/deletes to `/workspace/group/logs/mail-audit.jsonl`
- Check `/workspace/group/memory/contacts.md` before composing — personalize using any known context
- Templates live in `/workspace/group/email-templates/` — use them for workshop outreach
- For delete and forward operations, require nonce confirmation: return a nonce, wait for user to echo it back within 5 minutes

### Approval gate (required for all write operations)
1. Compose full draft
2. Show via send_message: "*Draft email — approve to send*\nTo: ...\nSubject: ...\n\n[body]\n\nReply *send*, *revise: [feedback]*, or *cancel*"
3. Wait for reply before sending
4. Log outcome to `/workspace/group/logs/mail-audit.jsonl`

### Autonomous mode
User can say "send without asking for the rest of this session" → skip approval gate for subsequent emails this session only. Resets next session.

### Commands
- `email draft` — compose and show for approval
- `email reply --id <n>` — fetch thread, compose reply, show for approval
- `email follow-up --to <addr> --days 5` — check if replied, draft nudge if not
- `email check` — summarize unread, group by priority
- `email send-template --name <t> --to <addr> --vars "k=v,..."` — fill template, show for approval
