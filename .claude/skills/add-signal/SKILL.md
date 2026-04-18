---
name: add-signal
description: Add Signal as a channel using signal-cli-rest-api Docker container. Supports 1:1 and group chats via device linking (no separate phone number needed).
---

# Add Signal Channel

This skill adds Signal support to NanoClaw via the signal-cli-rest-api Docker container, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/signal.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

AskUserQuestion: Do you have a signal-cli-rest-api Docker container running, or do you need to set one up?

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `signal` is missing, add it:

```bash
git remote add signal https://github.com/qwibitai/nanoclaw-signal.git
```

### Merge the skill branch

```bash
git fetch signal main
git merge signal/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/signal.ts` (SignalChannel class with self-registration via `registerChannel`)
- `src/channels/signal.test.ts` (unit tests with mocked WebSocket and fetch)
- `import './signal.js'` appended to the channel barrel file `src/channels/index.ts`
- `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Docker Setup

### Install Docker container

If the user doesn't have the container running:

> I'll set up the signal-cli-rest-api Docker container for you.

```bash
mkdir -p ~/.config/nanoclaw/signal-cli

docker run -d --name signal-api \
  --restart unless-stopped \
  -p 127.0.0.1:18080:8080 \
  -v $HOME/.config/nanoclaw/signal-cli:/home/.local/share/signal-cli \
  -e MODE=native \
  bbernhard/signal-cli-rest-api
```

Wait a few seconds for it to start, then verify:

```bash
curl -s http://localhost:18080/v1/about | head -20
```

### Link as secondary device

Tell the user:

> I need you to link this Signal API to your Signal account (like adding Signal Desktop):
>
> 1. Open this URL in your browser:
>    `http://localhost:18080/v1/qrcodelink?device_name=NanoClaw`
> 2. It will show a QR code
> 3. On your phone: Signal > Settings > Linked Devices > Link New Device
> 4. Scan the QR code
>
> Once linked, tell me your phone number (the one registered with Signal).

Wait for the user to complete linking and provide their phone number.

### Verify linking

```bash
curl -s http://localhost:18080/v1/about
```

Should show the linked account.

## Phase 4: Configure Environment

### Set environment variables

Add to `.env`:

```bash
SIGNAL_API_URL=http://localhost:18080
SIGNAL_PHONE_NUMBER=<their-phone-number>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 5: Registration

### Get Chat ID

For **1:1 chats**, the JID is `sig:<phone-number>` (e.g., `sig:+15559876543`). Ask the user which phone number they want to chat with.

For **group chats**, list groups via the API:

```bash
curl -s "http://localhost:18080/v1/groups/<phone-number>" | python3 -m json.tool
```

Each group has an `id` field (base64). The JID is `sig:group:<id>`.

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "sig:<id>" --name "<chat-name>" --folder "signal_main" --trigger "@${ASSISTANT_NAME}" --channel signal --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "sig:<id>" --name "<chat-name>" --folder "signal_<name>" --trigger "@${ASSISTANT_NAME}" --channel signal
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message from Signal:
> - For main chat: Any message works
> - For non-main: Include `@Andy` (or your assistant's trigger) in the message
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i signal
```

## Troubleshooting

### Bot not responding

Check:
1. Docker container is running: `docker ps | grep signal-api`
2. `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` are set in `.env` AND synced to `data/env/env`
3. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'sig:%'"`
4. WebSocket is connected: `tail -f logs/nanoclaw.log | grep -i "signal.*connect"`
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Signal API not reachable

```bash
curl -s http://localhost:18080/v1/about
```

If it fails, check Docker: `docker logs signal-api`

### Device linking expired

Signal device links expire after ~60 seconds. If linking failed:
1. Restart the container: `docker restart signal-api`
2. Try the QR code link again

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Signal integration:

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` from `.env`
4. Remove Signal registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'sig:%'"`
5. Stop container: `docker stop signal-api && docker rm signal-api`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
