---
name: add-cli
description: Add a CLI tool to send messages to the NanoClaw agent. Enables automation, cron jobs, and piping output from other tools into the agent.
---

# Add CLI Send Tool

This skill adds a `bin/send` CLI tool that lets you inject messages into the NanoClaw agent from the command line. The agent processes the message and responds through its configured channel (Slack, WhatsApp, etc.).

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `cli-send` is in `applied_skills`, skip to Phase 3 (Verify). The code is already in place.

### Explain to the user

The CLI tool is an **input-only** mechanism. It inserts a message into the database for a registered group. The agent picks it up via the message loop (2-second polling), processes it in a container, and responds through whatever channel owns that group.

The agent can dynamically route its response — it has access to all registered groups via IPC and can send to any channel (Slack, WhatsApp, etc.) based on the prompt.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-cli
```

This adds:
- `src/cli-send.ts` — The CLI tool (exportable `sendMessage()` function + CLI entry point)
- `src/cli-send.test.ts` — Unit tests
- `bin/send` — Executable wrapper script

No existing files are modified. No new npm dependencies.

### Validate

```bash
chmod +x bin/send
npm test
npm run build
```

## Phase 3: Verify

### Test sending a message

```bash
bin/send "This is a test from the CLI. Reply with 'CLI test successful'."
```

### Check logs

```bash
tail -f logs/nanoclaw.log
```

You should see:
1. `New messages count=1`
2. `Processing messages group=main`
3. `Spawning container agent`
4. Agent output and message sent to the configured channel

## Usage

```bash
# Send to main group (default)
bin/send "What's on my schedule today?"

# Send to a specific group by folder name
bin/send -g work "@Andy summarize recent activity"

# Custom sender name (shows in agent context)
bin/send -s monitor "Disk usage is at 85%"

# Pipe from another tool
sddk check | bin/send -s sddk "Review this progress report and share highlights on Slack"

# Show help
bin/send -h
```

### Notes

- For non-main groups, include the trigger pattern (e.g., `@Andy`) in your message if `requiresTrigger` is enabled.
- The agent decides where to send its response based on the prompt and available channels.
- Messages appear to the agent with sender name set to the `-s` value (default: `cli`).
