# QQ Bot Channel Skill

This skill adds QQ Bot support to NanoClaw, enabling your assistant to receive and respond to messages from QQ private chats and group chats.

## Quick Start

```bash
# Apply the skill
npx tsx scripts/apply-skill.ts .claude/skills/add-qq

# Install dependencies
npm install

# Configure credentials in .env
echo "QQBOT_APP_ID=your-app-id" >> .env
echo "QQBOT_CLIENT_SECRET=your-client-secret" >> .env

# Build and restart
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## What This Skill Does

### Adds
- `src/channels/qqbot.ts` - Complete QQ Bot channel implementation

### Modifies
- `src/index.ts` - Adds QQ Bot to channel initialization
- `src/config.ts` - Adds QQBOT_APP_ID and QQBOT_CLIENT_SECRET exports
- `package.json` - Adds ws and @types/ws dependencies

### Features
- ✅ Private chat (C2C) support
- ✅ Group chat support (with @mention)
- ✅ WebSocket real-time connection
- ✅ Automatic reconnection on disconnect
- ✅ Heartbeat mechanism
- ✅ Message chunking for long responses
- ✅ Multi-channel support (runs alongside Telegram/WhatsApp)

## Prerequisites

1. **QQ Bot Application**
   - Register at https://q.qq.com/qqbot/openclaw
   - Get App ID and Client Secret instantly after creation

2. **Node.js 18+**
   - Required for WebSocket support

## Architecture

### Message Flow

```
QQ User → QQ Bot API → WebSocket → NanoClaw → Container Agent → AI → Response → QQ Bot API → QQ User
```

### JID Format

- **Private chat**: `qqbot:c2c:<user_openid>`
- **Group chat**: `qqbot:group:<group_openid>`

### API Endpoints

- Token: `https://bots.qq.com/app/getAppAccessToken`
- Gateway: `https://api.sgroup.qq.com/gateway`
- WebSocket: `wss://api.sgroup.qq.com/websocket`
- Send C2C: `https://api.sgroup.qq.com/v2/users/{openid}/messages`
- Send Group: `https://api.sgroup.qq.com/v2/groups/{openid}/messages`

## Configuration

### Environment Variables

```bash
# Required
QQBOT_APP_ID=1903348826
QQBOT_CLIENT_SECRET=aCj7MZeaSFsLhw3z

# Optional (for other channels)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ONLY=false
```

## Registration

### Get Chat JID

After someone sends a message to your bot:

```bash
# For private chat
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); const chats = db.prepare('SELECT * FROM chats WHERE jid LIKE ?').all('qqbot:c2c:%'); console.log(JSON.stringify(chats, null, 2));"

# For group chat
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); const chats = db.prepare('SELECT * FROM chats WHERE jid LIKE ?').all('qqbot:group:%'); console.log(JSON.stringify(chats, null, 2));"
```

### Register Chat

```javascript
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');

const jid = 'qqbot:c2c:25087E0742EAE27B6A7C983092157BED';
const name = 'QQ Private Chat';
const folder = 'main';
const trigger = '@Andy';
const addedAt = new Date().toISOString();

db.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(jid, name, folder, trigger, addedAt, 0);

console.log('Registered!');
```

### Create Folder

```bash
mkdir -p groups/main/logs
```

### Restart

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
systemctl --user restart nanoclaw  # Linux
```

## Troubleshooting

### Check Connection

```bash
tail -f logs/nanoclaw.log | grep "QQ Bot"
```

Expected output:
```
[INFO] QQ Bot channel connecting...
[INFO] QQ Bot access token obtained
[INFO] QQ Bot gateway URL obtained
[INFO] QQ Bot WebSocket connected
[INFO] QQ Bot starting heartbeat
[INFO] QQ Bot ready
```

### Common Issues

**No response to messages**
- Check if chat is registered: Query `registered_groups` table
- Check logs for `QQ C2C message stored` or `QQ group message stored`

**WebSocket disconnects**
- This is normal, automatic reconnection is handled
- Look for `Attempting to reconnect QQ Bot` in logs

**Token errors**
- Verify credentials: `curl -X POST https://bots.qq.com/app/getAppAccessToken -H "Content-Type: application/json" -d '{"appId":"...","clientSecret":"..."}'`

## Testing

Run tests:
```bash
npm test .claude/skills/add-qq/tests/qqbot.test.ts
```

## Removal

```bash
# Remove code
rm src/channels/qqbot.ts

# Remove from index.ts (manual)
# Remove from config.ts (manual)

# Remove registrations
node -e "const Database = require('better-sqlite3'); const db = new Database('store/messages.db'); db.prepare('DELETE FROM registered_groups WHERE jid LIKE ?').run('qqbot:%');"

# Uninstall dependencies
npm uninstall ws @types/ws

# Rebuild
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## References

- [QQ Bot Official Docs](https://bot.q.qq.com/wiki/)
- [QQ Bot Developer Portal](https://q.qq.com/qqbot/openclaw)
- [OpenClaw QQ Bot Source](https://github.com/tencent-connect/openclaw-qqbot)
- [WebSocket Protocol](https://bot.q.qq.com/wiki/develop/api/gateway/reference.html)

## License

Same as NanoClaw (MIT)
