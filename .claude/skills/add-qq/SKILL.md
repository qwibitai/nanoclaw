---
name: add-qq
description: Add QQ Bot as a channel. Connects to QQ via official QQ Bot API (WebSocket). Can run alongside WhatsApp and Telegram.
---

# Add QQ Bot Channel

This skill adds QQ Bot support to NanoClaw, enabling your assistant to receive and respond to messages from QQ private chats (C2C) and group chats.

## Overview

QQ Bot integration uses:
- **Official QQ Bot API v2** (https://bot.q.qq.com/wiki/)
- **WebSocket connection** for real-time message delivery
- **Supports C2C (private chat) and group @mentions**

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `qqbot` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Prerequisites

Before starting, you need:

1. **QQ Bot Application** - Register at https://q.qq.com/qqbot/openclaw
2. **App ID** - Your bot's application ID (e.g., `1903348826`)
3. **Client Secret** - Your bot's client secret (e.g., `aCj7MZeaSFsLhw3z`)

If you don't have these yet, tell the user:

> To use QQ Bot, you need to register a bot application:
>
> 1. Visit https://q.qq.com/qqbot/openclaw
> 2. Log in with your QQ account
> 3. Click "创建机器人" (Create Bot)
> 4. The system will automatically create a bot and display:
>    - **App ID** (机器人ID)
>    - **Client Secret** (机器人密钥)
> 5. Copy both credentials for configuration

### Ask the user

Use `AskUserQuestion` to collect configuration:

**Question 1**: Do you have a QQ Bot App ID and Client Secret?
- **Yes, I have them** - Collect credentials now
- **No, I need to register** - Guide through registration process

If they have credentials, collect:
- App ID (numeric, e.g., `1903348826`)
- Client Secret (alphanumeric string)

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-qq
```

This deterministically:
- Adds `src/channels/qqbot.ts` (QQBotChannel class implementing Channel interface)
- Three-way merges QQ Bot support into `src/index.ts` (multi-channel support)
- Three-way merges QQ Bot config into `src/config.ts` (QQBOT_APP_ID, QQBOT_CLIENT_SECRET exports)
- Three-way merges ws dependency into `package.json`
- Updates `.env.example` with `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Install dependencies

```bash
npm install
```

This installs:
- `ws` - WebSocket client library
- `@types/ws` - TypeScript definitions

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
QQBOT_APP_ID=<your-app-id>
QQBOT_CLIENT_SECRET=<your-client-secret>
```

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

### Verify connection

Check logs to confirm QQ Bot connected:

```bash
tail -f logs/nanoclaw.log | grep "QQ Bot"
```

You should see:
```
[INFO] QQ Bot channel connecting...
[INFO] QQ Bot access token obtained
[INFO] QQ Bot gateway URL obtained
[INFO] QQ Bot WebSocket connected
[INFO] QQ Bot starting heartbeat
[INFO] QQ Bot ready
```

## Phase 4: Registration

### Get Chat ID

QQ Bot uses different JID formats:

- **Private chat (C2C)**: `qqbot:c2c:<user_openid>`
- **Group chat**: `qqbot:group:<group_openid>`

The `openid` is automatically captured when someone sends a message to your bot.

#### For Private Chat:

1. Tell the user to send a message to the bot in QQ
2. Check the database for the chat JID:

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); const chats = db.prepare('SELECT * FROM chats WHERE jid LIKE ?').all('qqbot:c2c:%'); console.log(JSON.stringify(chats, null, 2));"
```

3. The JID will look like: `qqbot:c2c:25087E0742EAE27B6A7C983092157BED`

#### For Group Chat:

1. Add the bot to a QQ group
2. @mention the bot in the group
3. Check the database:

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); const chats = db.prepare('SELECT * FROM chats WHERE jid LIKE ?').all('qqbot:group:%'); console.log(JSON.stringify(chats, null, 2));"
```

4. The JID will look like: `qqbot:group:A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6`

### Register the chat

Use Node.js to register the chat directly:

For a main chat (responds to all messages, uses the `main` folder):

```javascript
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');

const jid = 'qqbot:c2c:25087E0742EAE27B6A7C983092157BED'; // Replace with actual JID
const name = 'QQ Private Chat';
const folder = 'main';
const trigger = '@Andy'; // Replace with your ASSISTANT_NAME
const addedAt = new Date().toISOString();

db.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(jid, name, folder, trigger, addedAt, 0);

console.log('QQ chat registered successfully!');
```

For additional chats (trigger-only, isolated folder):

```javascript
const jid = 'qqbot:group:A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
const name = 'QQ Group Chat';
const folder = 'qq-group'; // Unique folder name
const trigger = '@Andy';
const addedAt = new Date().toISOString();

db.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(jid, name, folder, trigger, addedAt, 1); // requires_trigger = 1 for groups

console.log('QQ group registered successfully!');
```

### Create group folder

```bash
mkdir -p groups/<folder-name>/logs
```

Replace `<folder-name>` with the folder name you used in registration (e.g., `main`, `qq-group`).

### Restart to load registration

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 5: Testing

### Send a test message

1. Send a message to your bot in QQ (private chat or @mention in group)
2. The bot should respond within a few seconds

### Check logs

If no response, check logs:

```bash
tail -100 logs/nanoclaw.log | grep -E "QQ|qqbot"
```

Look for:
- `QQ C2C message stored` or `QQ group message stored` - Message received
- `Processing messages` - Container started
- `Agent output:` - AI generated response
- `QQ message sent` - Response sent successfully

### Common issues

**Issue**: Message received but no response

**Solution**: Check if chat is registered:
```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); const groups = db.prepare('SELECT * FROM registered_groups WHERE jid LIKE ?').all('qqbot:%'); console.log(JSON.stringify(groups, null, 2));"
```

**Issue**: `C2C send failed: 请求参数msg_id无效或越权`

**Solution**: This was fixed in the code. Make sure you're using the latest version without `msg_id` parameter in send requests.

**Issue**: WebSocket disconnects frequently

**Solution**: This is normal. The code automatically reconnects. Check logs for `QQ Bot WebSocket closed` followed by `Attempting to reconnect QQ Bot`.

**Issue**: No messages received

**Solution**:
1. Verify bot is online: Check logs for `QQ Bot ready`
2. For groups: Make sure bot has proper permissions and is @mentioned
3. Check if message was stored: Query `messages` table in database

## Architecture Notes

### Message Flow

1. **Inbound**: QQ → WebSocket → `handleC2CMessage`/`handleGroupMessage` → `onMessage` callback → Database → Container Agent → AI Response
2. **Outbound**: AI Response → `sendMessage` → `sendC2CMessage`/`sendGroupMessage` → QQ Bot API → User

### JID Format

- **C2C**: `qqbot:c2c:<user_openid>` - Private chat with a user
- **Group**: `qqbot:group:<group_openid>` - Group chat (bot must be @mentioned)

The `openid` is provided by QQ Bot API and is stable for each user/group.

### API Endpoints

- **Token**: `https://bots.qq.com/app/getAppAccessToken` (POST)
- **Gateway**: `https://api.sgroup.qq.com/gateway` (GET)
- **WebSocket**: `wss://api.sgroup.qq.com/websocket`
- **Send C2C**: `https://api.sgroup.qq.com/v2/users/{openid}/messages` (POST)
- **Send Group**: `https://api.sgroup.qq.com/v2/groups/{openid}/messages` (POST)

### WebSocket Connection

- **Heartbeat interval**: 41.25 seconds (provided by server)
- **Reconnection**: Automatic with 5-second delay
- **Session management**: Session ID tracked for resume capability
- **Intents**: GUILDS, GUILD_MEMBERS, PUBLIC_GUILD_MESSAGES, GROUP_AND_C2C_EVENT, DIRECT_MESSAGE

## Troubleshooting

### Debug mode

Enable debug logging by checking container logs:

```bash
# Check container logs
docker logs nanoclaw-<folder>-<timestamp>

# Or check main logs
tail -f logs/nanoclaw.log
```

### Verify bot credentials

Test your credentials:

```bash
curl -X POST https://bots.qq.com/app/getAppAccessToken \
  -H "Content-Type: application/json" \
  -d '{"appId":"<your-app-id>","clientSecret":"<your-client-secret>"}'
```

Should return:
```json
{"access_token":"...", "expires_in":7200}
```

### Check WebSocket connection

Look for these log entries:
```
[INFO] QQ Bot WebSocket connected
[INFO] QQ Bot starting heartbeat
[INFO] QQ Bot ready
```

If you see frequent disconnects:
```
[WARN] QQ Bot WebSocket closed
[INFO] Attempting to reconnect QQ Bot
```

This is normal behavior. The code handles reconnection automatically.

## Removal

To remove QQ Bot integration:

1. Delete `src/channels/qqbot.ts`
2. Remove `QQBotChannel` import and creation from `src/index.ts`
3. Remove QQ Bot config (`QQBOT_APP_ID`, `QQBOT_CLIENT_SECRET`) from `src/config.ts`
4. Remove QQ Bot registrations from SQLite:
   ```bash
   node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); db.prepare('DELETE FROM registered_groups WHERE jid LIKE ?').run('qqbot:%'); console.log('QQ Bot registrations removed');"
   ```
5. Uninstall dependencies: `npm uninstall ws @types/ws`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)

## References

- **QQ Bot Official Documentation**: https://bot.q.qq.com/wiki/
- **QQ Bot Developer Portal**: https://q.qq.com/qqbot/openclaw
- **OpenClaw QQ Bot Source**: https://github.com/tencent-connect/openclaw-qqbot
- **WebSocket Protocol**: https://bot.q.qq.com/wiki/develop/api/gateway/reference.html
