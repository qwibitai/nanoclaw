# Signal Channel Design

Add Signal as a messaging channel for NanoClaw using the `bbernhard/signal-cli-rest-api` Docker container as the Signal protocol bridge. Supports 1:1 and group chats.

## Architecture

```
Docker: bbernhard/signal-cli-rest-api (user-managed, default port 18080)
  |  WebSocket (inbound messages)
  |  REST API (outbound messages, typing indicators)
  v
NanoClaw: src/channels/signal.ts (SignalChannel class)
```

The signal-cli-rest-api container runs independently — NanoClaw does not manage its lifecycle. The user starts it via Docker and links it to their existing Signal account as a secondary device (like Signal Desktop). No separate phone number is needed.

## Environment Variables

```
SIGNAL_API_URL=http://localhost:18080    # signal-cli-rest-api endpoint
SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX         # user's existing Signal phone number
```

Both are required. The channel factory returns `null` if either is missing, matching the pattern of other channels (Telegram needs `TELEGRAM_BOT_TOKEN`, etc.).

## Channel Implementation

### File: `src/channels/signal.ts`

Implements the `Channel` interface and self-registers via `registerChannel('signal', factory)` at module load.

### JID Format

- 1:1 chats: `sig:{phone}` (e.g., `sig:+14155551234`)
- Group chats: `sig:group:{base64GroupId}`

`ownsJid()` returns `true` for any JID starting with `sig:`.

### Receiving Messages (WebSocket)

On `connect()`, opens a WebSocket to `ws://{SIGNAL_API_URL}/v1/receive/{number}`.

Each WebSocket message is a JSON envelope containing:
- `envelope.dataMessage.message` — text content
- `envelope.dataMessage.timestamp` — message timestamp
- `envelope.sourceName` / `envelope.sourceNumber` — sender info
- `envelope.dataMessage.groupInfo.groupId` — base64 group ID (if group message)

The handler:
1. Parses the envelope
2. Derives the JID (`sig:{sourceNumber}` for 1:1, `sig:group:{groupId}` for groups)
3. Calls `onChatMetadata()` with channel name `'signal'`
4. Checks if the JID is a registered group; drops unregistered chats (same as Telegram)
5. Calls `onMessage()` with a `NewMessage` object

Non-text messages (attachments, reactions, etc.) are stored as placeholders: `[Photo]`, `[Voice message]`, `[Document: filename]`, `[Sticker]`, etc.

### Reconnection

WebSocket drops are expected (network blips, container restarts). On close/error:
- Reconnect with exponential backoff: 1s, 2s, 4s, 8s, capped at 30s
- Reset backoff on successful connection
- Log reconnection attempts at debug level, successful reconnect at info level

### Sending Messages (REST)

`sendMessage(jid, text)` sends via `POST {SIGNAL_API_URL}/v2/send`:

For 1:1 (`sig:{phone}`):
```json
{ "number": "{SIGNAL_PHONE_NUMBER}", "recipients": ["{phone}"], "message": "{text}" }
```

For groups (`sig:group:{groupId}`):
```json
{ "number": "{SIGNAL_PHONE_NUMBER}", "recipients": [], "message": "{text}", "base64_group": "{groupId}" }
```

Messages over 4096 characters are split into chunks (consistent with Telegram channel behavior).

### Typing Indicator

`setTyping(jid, isTyping)` calls `PUT {SIGNAL_API_URL}/v1/typing-indicator/{number}` with the recipient. Best-effort, errors are logged at debug level and swallowed.

### Chat ID Discovery

Unlike Telegram (which has a `/chatid` bot command), Signal doesn't support bot commands. Instead, the skill setup phase will:
1. Tell the user to send a test message from Signal
2. Read the logs to find the JID
3. Or query the REST API: `GET /v1/groups/{number}` to list groups with their IDs

## Tests: `src/channels/signal.test.ts`

Unit tests with mocked WebSocket and HTTP:
- Factory returns `null` when env vars missing
- Factory returns `SignalChannel` when env vars present
- `ownsJid` returns true for `sig:` prefixed JIDs
- Inbound 1:1 message parsed correctly
- Inbound group message parsed correctly
- `sendMessage` posts correct JSON for 1:1 vs group
- Long messages are split
- Reconnection on WebSocket close

## Skill: `/add-signal` (SKILL.md)

Follows the same pattern as `/add-telegram`:

### Phase 1: Pre-flight
- Check if `src/channels/signal.ts` exists (skip to setup if so)

### Phase 2: Apply Code Changes
- Add git remote for `nanoclaw-signal` repo
- Merge the skill branch (brings in `signal.ts`, `signal.test.ts`, barrel import, env example)
- `npm install && npm run build`
- Run signal channel tests

### Phase 3: Docker Setup
Guide the user through:
1. Pull the Docker image: `docker pull bbernhard/signal-cli-rest-api`
2. Start the container:
   ```bash
   docker run -d --name signal-api \
     -p 18080:8080 \
     -v $HOME/.config/nanoclaw/signal-cli:/home/.local/share/signal-cli \
     -e MODE=native \
     bbernhard/signal-cli-rest-api
   ```
3. Link as secondary device:
   ```bash
   curl -s "http://localhost:18080/v1/qrcodelink?device_name=NanoClaw" | display
   ```
   Or provide the link URL for the user to generate a QR code and scan with Signal app.

### Phase 4: Configure Environment
- Ask for phone number
- Add `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` to `.env`
- Sync to `data/env/env`
- Build and restart

### Phase 5: Registration
- Guide user to send a test message
- Read JID from logs or query groups API
- Register via `npx tsx setup/index.ts --step register` with `--channel signal`

### Phase 6: Verify
- User sends a message, bot should respond
- Check logs if issues

## Dependencies

**No new npm dependencies.** Node.js 22+ includes native `WebSocket` in `globalThis` (stable). The host runs Node 25. If Node 20 support is needed later, add the `ws` package as a fallback — but for now, native WebSocket is sufficient.

## What's NOT Included

- Media/attachment download or forwarding (placeholder text only)
- Signal reactions (read receipts, emoji reactions)
- signal-cli-rest-api container lifecycle management
- Registration mode (new phone number) — only linked device mode
