# Slack Setup (MVP)

For full deployment and verification from raw NanoClaw, use:

- `deploy-add-slack-skill.md`

This file is Slack-side quick reference only.

## App + token checklist

1. Create/install app from `slack-app-manifest.yaml`.
2. Ensure Socket Mode is enabled.
3. Create App-Level token with `connections:write` (`SLACK_APP_TOKEN`).
4. Capture:
   - `SLACK_BOT_TOKEN` (`xoxb-...`)
   - `SLACK_APP_TOKEN` (`xapp-...`)
   - `SLACK_SIGNING_SECRET`

## Behavior notes

- Unknown Slack public/private channels auto-register on first mention.
- Unknown Slack DMs auto-register on first inbound message.
- `/abort` cancels active processing in the current Slack chat.
- If slash command is unavailable in a context, `abort` and `/abort` text fallback also works.
