---
name: add-slack
description: Add Slack as a channel (Socket Mode via @slack/bolt). Can replace WhatsApp entirely or run alongside it. Ported from the claudecode-slackbot reference implementation.
---

# Add Slack Channel

This skill adds Slack support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `slack` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `SLACK_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Slack app configured?** If yes, collect tokens now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

This deterministically:
- Adds `src/channels/slack.ts` (SlackChannel class implementing Channel interface)
- Adds `src/channels/slack.test.ts` (unit tests)
- Three-way merges Slack support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Slack config into `src/config.ts` (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ONLY, SLACK_FILTER_BOT_MESSAGES exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with Slack env vars (creates it if it doesn't exist)
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app:

1. Ask the user for their desired app display name (e.g., "Andy Assistant").
2. Generate the App Manifest and one-click creation URL:

```bash
npx tsx .claude/skills/add-slack/scripts/generate-manifest.ts "<app-name>"
```

3. Give the user the one-click creation URL from the output. Tell them:

> 1. Click this link to create your Slack App (all scopes, event subscriptions, and Socket Mode are pre-configured):
>    `<paste the one-click URL>`
> 2. After the app is created, go to **Socket Mode** → create an App-Level Token with `connections:write` scope → save as `SLACK_APP_TOKEN` (starts with `xapp-`)
> 3. Go to **Install App** → Install to Workspace → copy **Bot User OAuth Token** → save as `SLACK_BOT_TOKEN` (starts with `xoxb-`)

Wait for the user to provide the tokens.

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

If they chose to replace WhatsApp:
```bash
SLACK_ONLY=true
```

**Important**: When `SLACK_ONLY=true`, both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` must be set. If either is missing, no channels will start and the bot will be unresponsive.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Channel/DM ID

Tell the user:
> 1. Invite the bot to a Slack channel: `/invite @YourBotName`
> 2. Send `!chatid` in the channel — the bot will reply with the channel ID (this works even before the channel is registered)
> 3. For DMs: message the bot directly and send `!chatid`
>
> Channel IDs look like `slack:C0123456789` (channels) or `slack:D0123456789` (DMs).

Wait for the user to provide the channel ID.
Use the IPC register flow or register directly.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("slack:<channel-id>", {
  name: "<channel-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("slack:<channel-id>", {
  name: "<channel-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Slack channel:
> - For main channel: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Post-Hardening

The `SlackChannel` implementation includes several hardening layers applied after initial setup. These are active by default and require no configuration.

### Inbound filtering

 All events with a `subtype` field are dropped. Only plain user messages pass through.
 Self-loop prevention: the bot's own `user_id` is fetched via `auth.test()` on connect and filtered from all inbound events.
 Bot message filtering: events with a `bot_id` field are dropped by default. Set `SLACK_FILTER_BOT_MESSAGES=false` to allow other bots through (not recommended).
 TTL deduplication: each event is keyed as `channel:ts` and tracked in an in-memory Map with a 5-minute TTL. Duplicate deliveries from Slack's at-least-once guarantee are silently dropped.

### Outbound retry

 Bolt's `WebClient` is configured with 3 retries, factor-2 exponential backoff, and jitter.
 `rejectRateLimitedCalls: false` means 429 responses are handled automatically: the client waits for the `Retry-After` duration and retries.
 After all retries are exhausted, the failure is logged with structured fields: `event: slack_send_failed`, `jid`, `status_code`, `length`.
 Rate limit events are also logged separately: `event: slack_rate_limited`, `retry_after_s`, `url`.

### Token lifecycle

 `tokens_revoked` event: logs `event: token_revoked` and calls `disconnect()` gracefully.
 `app_uninstalled` event: logs `event: app_uninstalled` and calls `disconnect()` gracefully.
 If `auth.test()` fails on connect, the channel enters safe mode: self-loop filtering is disabled (no `botUserId` to compare against) and bot message filtering is forced on.

### Socket watchdog

 A 60-second interval timer checks whether any event has been received in the last 3 minutes.
 If the socket is stale, it logs `event: socket_stale` with `last_event_ts`, `reconnect_attempt`, and `stale_duration_ms`, then calls `app.stop()` followed by `app.start()`.
 Successful reconnect logs `event: socket_reconnect` with `reconnect_attempt` and `duration_ms`.
 Failed reconnect logs the same fields plus the error.

## Troubleshooting

### Bot not responding
Check:
1. `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Socket Mode is enabled in the Slack app settings
3. Channel is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
4. For non-main channels: message includes trigger pattern
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
6. Check for token issues in logs: `grep token_revoked logs/nanoclaw.log`
7. Check socket watchdog: `grep socket_stale logs/nanoclaw.log` -- if present, the socket is cycling; check app token scope (`connections:write`)

### Duplicate messages

The TTL Map deduplicates on `channel:ts` key with a 5-minute window. If you're seeing duplicate Agent invocations:

 Check whether the same `ts` value appears twice in logs -- this would indicate the Map isn't persisting across restarts (expected; it's in-memory).
 SQLite also enforces a unique constraint on message IDs. Check for constraint errors in logs.
 If duplicates happen within a single process lifetime, the TTL Map should catch them. File a bug with the `channel:ts` values.

### Rate limited

 Search logs for `slack_rate_limited` events: `grep slack_rate_limited logs/nanoclaw.log`
 The `retry_after_s` field shows how long the client waited before retrying.
 If you see repeated rate limit events, reduce message frequency or split large responses across fewer `postMessage` calls.
 Persistent exhaustion (3 consecutive final failures) logs `slack_send_failed` with no further retries. See `docs/slack/T10-canary-ops-rollback.md` for rollback criteria.

### Socket disconnects

 Search for `socket_stale` and `socket_reconnect` in logs.
 The watchdog uses a 12-minute stale threshold with exponential backoff (base 5s, factor 2, max 5 attempts) and a circuit breaker that calls `process.exit(1)` after max retries.
 `socket_stale` means no socket event was received for 12+ minutes. A single stale event followed by a successful `socket_reconnect` is normal recovery.
 `socket_reconnect` with an error means the reconnect failed. Check that `SLACK_APP_TOKEN` is valid and has `connections:write` scope.
 If `reconnect_attempt` keeps climbing without a successful reconnect, the app token may be revoked. Rotate it in the Slack app settings and update `.env`.
 If `breaker_open` appears in logs, the circuit breaker fired after 5 failed reconnect attempts. The process will exit and systemd/launchd will restart it.

### Bot only responds to @mentions

This is expected for non-main channels. For the main channel, set `requiresTrigger: false`.

### Token errors

 `SLACK_BOT_TOKEN` must start with `xoxb-`
 `SLACK_APP_TOKEN` must start with `xapp-`
 If tokens were rotated, update `.env` and sync to `data/env/env`

## Monitoring Scripts

This skill includes two operational scripts deployed to `scripts/slack/`:

### Canary Checkpoint (`scripts/slack/canary-checkpoint.sh`)

Runs a health check against 5 criteria (C1-C5): token validity, socket reconnect health, rate limit recovery, message pipeline, and stable runtime. Outputs structured JSON.

```bash
bash scripts/slack/canary-checkpoint.sh          # live check
bash scripts/slack/canary-checkpoint.sh --dry-run # offline test
```

### Soak Monitor (`scripts/slack/soak-monitor.sh`)

Runs periodic health checks over a time window. Useful for validating stability after deployments.

```bash
bash scripts/slack/soak-monitor.sh 15 120  # check every 15min for 120min
```

## Reference

The `claudecode-slackbot/` directory contains a standalone Slack bot reference implementation. Useful for debugging or understanding the underlying Bolt patterns, but not required for normal operation.

## Removal
Automated:

```bash
npx tsx scripts/uninstall-skill.ts slack
```

Or manually:
1. Delete `src/channels/slack.ts` and `src/channels/slack.test.ts`
2. Remove `SlackChannel` import and creation from `src/index.ts`
3. Remove `channels` array and revert to using `whatsapp` directly (if no other channels)
4. Remove Slack-specific test cases from `src/routing.test.ts`
5. Remove Slack config (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY`, `SLACK_FILTER_BOT_MESSAGES`) from `src/config.ts`
6. Remove Slack registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'slack:%'"`
7. Uninstall: `npm uninstall @slack/bolt`
8. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)