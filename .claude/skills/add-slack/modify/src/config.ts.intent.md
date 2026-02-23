# Intent: config.ts changes for Slack skill

## What changed

Added three Slack-specific exports to `src/config.ts`:

- `SLACK_BOT_TOKEN` — the `xoxb-*` bot token used to call the Slack Web API and authenticate the Bolt app
- `SLACK_APP_TOKEN` — the `xapp-*` app-level token required for Socket Mode connections
- `SLACK_ONLY` — boolean flag; when `true`, WhatsApp is not initialized so Slack becomes the sole channel

All three values are read from `.env` via `readEnvFile` (same pattern as `ASSISTANT_NAME`).

## Invariants

- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` default to `''` (empty string) — the app starts fine without Slack; the channel is simply not created in `index.ts` when the token is absent
- `SLACK_ONLY` defaults to `false` — WhatsApp remains active unless explicitly disabled
- The `readEnvFile` call is extended to include the three new keys alongside the existing ones
