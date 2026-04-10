# New Bot Creation

This documents the exact steps used on April 10, 2026 to switch this NanoClaw checkout from the old Telegram bot to the new one.

## Goal

NanoClaw was still connected to the old Telegram bot account:

- Old bot user ID: `8424520896`
- New bot user ID: `8657377100`

The objective was to move the running NanoClaw agent to the new bot and register the main Telegram chat against that bot.

## What Was Changed

### 1. Verified the bot token in `.env`

Checked that the local `.env` already pointed to the new Telegram bot:

```bash
TELEGRAM_BOT_TOKEN=8657377100:AAGmvZaEuL9UvDYzEH8hOPkYEk92X_ISNxg
```

No repo-safe `.env` commit was made because this file contains secrets and is local machine state.

### 2. Registered the Telegram chat for the new bot

Ran:

```bash
npx tsx setup/index.ts --step register \
  --jid "tg:7810829778" \
  --name "Brian" \
  --trigger "@Andy" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "Andy" \
  --is-main \
  --no-trigger-required
```

This succeeded and:

- Wrote the registration to the SQLite database
- Created `groups/telegram_main/CLAUDE.md` from the main template

### 3. Started the NanoClaw service for this checkout

Ran:

```bash
npx tsx setup/index.ts --step service
```

This:

- Built the TypeScript project
- Wrote the launchd plist to:
  `/Users/tht0021/Library/LaunchAgents/com.nanoclaw.plist`
- Loaded the `com.nanoclaw` launchd service

### 4. Verified that NanoClaw connected to the new bot

Confirmed in the service logs:

```text
Telegram channel connected
botUserId: 8657377100
```

That proves the running NanoClaw service was switched to the new Telegram bot account.

## Important Follow-Up

The Telegram bot switchover succeeded, but agent replies may still fail until provider access is restored.

Current warning observed:

```text
OneCLI gateway not reachable — container will have no credentials
```

That means:

- Telegram is connected correctly
- The agent containers may not have model credentials until the local OneCLI gateway is running or `ONECLI_URL` is corrected

## Repo vs Local Machine State

Most of the bot switchover was local runtime state, not a normal source-code change:

- `.env` token
- SQLite registration
- generated group folder
- launchd service configuration
- runtime logs

Those should not generally be committed to the repository. This markdown file exists so the procedure itself is captured in Git.
