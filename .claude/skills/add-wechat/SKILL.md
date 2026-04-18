---
name: add-wechat
description: Add WeChat as a channel. Connects via Tencent iLink Bot API with QR code authentication. Can run alongside WhatsApp, Telegram, and other channels.
---

# Add WeChat Channel

This skill adds WeChat support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `wechat` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to confirm:

AskUserQuestion: Do you want to add WeChat as a channel? WeChat will run alongside your existing channels (WhatsApp, Telegram, etc.). You'll need to scan a QR code with your WeChat account to authenticate.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-wechat
```

This deterministically:
- Adds `src/channels/weixin.ts` (WeixinChannel class implementing Channel interface)
- Adds `src/channels/weixin.test.ts` (basic unit tests)
- Three-way merges WeChat support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges WeChat config into `src/config.ts` (WEIXIN_ENABLED export)
- Installs the `qrcode-terminal` npm dependency (for QR code display in terminal)
- Updates `.env.example` with `WEIXIN_ENABLED`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new weixin tests) and build must be clean before proceeding.

## Phase 3: Setup

### Enable WeChat in .env

Add to `.env`:
```bash
WEIXIN_ENABLED=true
```

### Start NanoClaw

Restart the service to trigger QR code authentication:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux:
systemctl --user restart nanoclaw
```

Or if running in dev mode:
```bash
npm run dev
```

### Scan QR Code

When NanoClaw starts, it will:
1. Display a QR code in the terminal
2. Print a URL you can open in a browser (if terminal QR doesn't work)
3. Wait for you to scan with WeChat

**Steps:**
1. Open WeChat on your phone
2. Tap the "+" icon → "Scan QR Code"
3. Scan the QR code displayed in the terminal
4. Confirm the login on your phone

Once confirmed, NanoClaw will save your credentials to `data/weixin/account.json` and start receiving messages.

### Register a WeChat chat

WeChat uses JID format: `wx:<user_id>`

To find your user ID, send a message to the bot from WeChat, then check the logs:

```bash
tail -f logs/nanoclaw.log | grep "WeChat message"
```

You'll see something like:
```
WeChat message stored: chatJid=wx:user123@im.wechat fromUserId=user123@im.wechat
```

Register the chat:

```bash
# Using the main group folder:
npx tsx scripts/register-group.ts wx:user123@im.wechat main

# Or create a dedicated folder:
npx tsx scripts/register-group.ts wx:user123@im.wechat my-wechat-chat
```

### Test the connection

Send a message to your WeChat bot:
```
@Andy hello
```

(Replace `@Andy` with your `ASSISTANT_NAME` from `.env`)

The agent should respond. Check logs if it doesn't:
```bash
tail -f logs/nanoclaw.log
```

## Architecture

### How it works

- **Authentication**: QR code scan via Tencent iLink Bot API
- **Message receiving**: Long-polling (`/ilink/bot/getupdates`) with sync buffer persistence
- **Message sending**: POST to `/ilink/bot/sendmessage` with automatic chunking for long messages
- **Session management**: Automatic pause on session expiry, retry with exponential backoff
- **Credentials**: Stored in `data/weixin/account.json` (token, baseUrl, accountId)
- **Sync state**: Stored in `data/weixin/sync.json` (get_updates_buf for resuming)

### JID format

WeChat JIDs use the `wx:` prefix:
- Format: `wx:<user_id>`
- Example: `wx:user123@im.wechat`

### Message types supported

- **Text messages**: Full support with quote/reference detection
- **Voice messages**: Transcribed text is extracted if available
- **Images/Videos/Files**: Shown as `[图片]`, `[视频]`, `[文件: filename]`

### Limitations

- **No group chat support**: WeChat iLink Bot API only supports 1-on-1 conversations
- **No typing indicators**: Requires additional API calls with typing_ticket (not implemented)
- **Session expiry**: If session expires, the bot pauses for 1 hour before retrying
- **Message length**: Long messages are automatically split at 4000 characters

## Troubleshooting

### QR code doesn't appear

If the terminal doesn't show the QR code:
1. Check the logs for the QR code URL: `tail -f logs/nanoclaw.log | grep "扫码链接"`
2. Open the URL in a browser and scan from there

### "Session expired" errors

The WeChat session can expire if:
- The bot is inactive for too long
- WeChat servers reset the session
- Network connectivity issues

When this happens, NanoClaw automatically pauses for 1 hour, then retries. To force a new login:

```bash
rm data/weixin/account.json
# Restart NanoClaw to trigger new QR code
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
systemctl --user restart nanoclaw  # Linux
```

### Messages not being received

Check:
1. Is the chat registered? `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'wx:%'"`
2. Is WeChat connected? `tail -f logs/nanoclaw.log | grep "WeChat"`
3. Is the poll loop running? Look for "WeChat poll loop started" in logs

### Cannot send messages

Check:
1. Is the account connected? `cat data/weixin/account.json`
2. Check for API errors in logs: `tail -f logs/nanoclaw.log | grep "Failed to send WeChat"`
3. Verify the JID format is correct: must start with `wx:`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
systemctl --user stop nanoclaw
npm run dev
systemctl --user start nanoclaw
```

## Removal

To remove WeChat integration:

1. Set `WEIXIN_ENABLED=false` in `.env` or remove the line entirely
2. Restart NanoClaw
3. (Optional) Remove WeChat registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'wx:%'"`
4. (Optional) Remove credentials: `rm -rf data/weixin/`
5. (Optional) Uninstall dependency: `npm uninstall qrcode-terminal` (only if not used elsewhere)

To fully remove the code (not recommended unless you're sure):
1. Delete `src/channels/weixin.ts`
2. Remove `WeixinChannel` import and creation from `src/index.ts`
3. Remove WeChat config (`WEIXIN_ENABLED`) from `src/config.ts`
4. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
