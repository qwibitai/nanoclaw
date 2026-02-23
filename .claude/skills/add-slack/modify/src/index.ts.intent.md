# Intent: index.ts changes for Slack skill

## What changed

1. **New imports** — `SlackChannel` from `./channels/slack.js` and `SLACK_BOT_TOKEN`, `SLACK_ONLY` from `./config.js`

2. **Conditional WhatsApp init** — wrapped in `if (!SLACK_ONLY)` so Slack-only deployments don't start the WhatsApp connection

3. **Slack channel init** — if `SLACK_BOT_TOKEN` is set, a `SlackChannel` instance is created with the shared `channelOpts` and added to the `channels` array

## Invariants

- `channels` array and `findChannel` routing are unchanged — Slack integrates naturally via `ownsJid('slack:...')`
- If neither `SLACK_BOT_TOKEN` nor WhatsApp creds exist the app will fail at connection time (expected behaviour)
- `whatsapp` module-level variable is still declared; it may be `undefined` at runtime when `SLACK_ONLY=true` — callers that use `whatsapp?.syncGroupMetadata` already handle this via optional chaining
