---
name: add-slack
description: Add Slack as an input channel without removing WhatsApp. Supports gateway modes (whatsapp/slack/both), auto-registration for Slack channels/DMs, ephemeral status updates, and /abort to cancel long-running processing.
---

# Add Slack Channel

This skill applies deterministic code changes using the skills engine package in this folder.

## What this skill adds

- Slack Socket Mode channel (`src/channels/slack.ts`)
- Auto-register new Slack chats:
  - Public/private channels on first bot mention
  - DMs on first inbound message
- Ephemeral status updates while processing
- `/abort` slash command and text fallback (`/abort` or `abort`) to cancel active processing in the current Slack chat
- Multi-channel support via `GATEWAY_CHANNEL`:
  - `whatsapp` (default)
  - `slack`
  - `both`

## Apply

1. Initialize skills state if needed:

```bash
npx tsx scripts/apply-skill.ts --init
```

2. Apply the skill:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

## Slack App Setup

Use the manifest at:

- `.claude/skills/add-slack/references/slack-app-manifest.yaml`

Import it in Slack App settings and install the app to your workspace.

Then set:

```bash
GATEWAY_CHANNEL=both
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

## Verify

Run:

```bash
npx vitest run src/channels/slack.test.ts src/routing.test.ts src/channels/whatsapp.test.ts
npm run typecheck
```

Then in Slack:

1. Mention the bot in a new channel: it should auto-register and respond.
2. Send `/abort` during a long run: active processing in that chat should stop.

