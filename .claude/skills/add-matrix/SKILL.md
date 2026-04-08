---
name: add-matrix
description: Add Matrix as a channel. Supports E2E-encrypted rooms on any homeserver (default matrix.org). Uses an access token for headless auth — no QR code needed. Run this skill to merge the code, configure credentials, and register your first Matrix room.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/matrix.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a Matrix account you want to use as the bot (e.g. on matrix.org), or do you need to create one?

If they have one, collect the homeserver URL and user ID now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `matrix` is missing, add it:

```bash
git remote add matrix https://github.com/scharmen/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch matrix claude/matrix-messenger-skill-buVHI
git merge matrix/claude/matrix-messenger-skill-buVHI || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/matrix.ts` (MatrixChannel class with self-registration via `registerChannel`, Rust-based E2EE, auto-join, typing indicators, and native notifications)
- `src/channels/matrix.test.ts` (17 unit tests with matrix-js-sdk mock)
- `import './matrix.js'` appended to the channel barrel file `src/channels/index.ts`
- `matrix-js-sdk` npm dependency in `package.json`
- `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/matrix.test.ts
```

All tests must pass (including the new Matrix tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create a Matrix bot account (if needed)

If the user doesn't have a Matrix account yet, tell them:

> I need you to create a Matrix account for the bot:
>
> 1. Go to [app.element.io](https://app.element.io) and click **Create account**
> 2. Choose **matrix.org** as the homeserver (or your own homeserver)
> 3. Pick a username (e.g. `andybot`) — the full user ID will be `@andybot:matrix.org`
> 4. Complete registration

Wait for the user to confirm the account is created and provide the full user ID (`@username:homeserver`).

### Get an access token

Tell the user to pick one of these methods:

**Option A — Element Web (easiest)**
> 1. Log in as the bot account at [app.element.io](https://app.element.io)
> 2. Go to **Settings** (gear icon) → **Help & About** → scroll to **Advanced**
> 3. Click **Access Token** to reveal it, then copy the full `syt_…` string

**Option B — curl**
> Run this (replace values with your bot credentials):
> ```bash
> curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
>   -H 'Content-Type: application/json' \
>   -d '{"type":"m.login.password","user":"@yourbot:matrix.org","password":"YOUR_PASSWORD"}'
> ```
> Copy the `access_token` value from the JSON response.

Wait for the user to provide the access token.

### Configure environment

Add to `.env`:

```bash
MATRIX_HOMESERVER=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_…
MATRIX_USER_ID=@yourbot:matrix.org
# Optional — pin device ID to avoid re-verification after restart:
# MATRIX_DEVICE_ID=ABCDEF1234
```

Channels auto-enable when their credentials are present — no extra configuration needed.

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

Watch the logs to confirm the channel connected:

```bash
tail -f logs/nanoclaw.log
```

You should see: `[matrix] Connected as @yourbot:matrix.org`

## Phase 4: Registration

### Get Room ID

Tell the user:

> 1. Open [app.element.io](https://app.element.io) and go to the room you want NanoClaw to use
> 2. Click the room name at the top → **Settings** → **Advanced**
> 3. Copy the **Internal room ID** — it looks like `!abc123xyz:matrix.org`
> 4. The bot auto-accepts room invitations. If needed, invite it: type `/invite @yourbot:matrix.org` in the room

Wait for the user to provide the room ID (format: `matrix:!roomid:homeserver.com`).

### Register the room

The room ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main room (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "matrix:!<room-id>:<homeserver>" --name "<room-name>" --folder "matrix_main" --trigger "@${ASSISTANT_NAME}" --channel matrix --no-trigger-required --is-main
```

For additional rooms (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "matrix:!<room-id>:<homeserver>" --name "<room-name>" --folder "matrix_<room-name>" --trigger "@${ASSISTANT_NAME}" --channel matrix
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Matrix room:
> - For main room: Any message works
> - For non-main: `@Andy hello` (using the configured trigger)
>
> The bot should respond within a few seconds.

If a **native desktop notification** appears ("Matrix — verification request"), that means another device is requesting E2EE cross-signing. Accept it from your Matrix client (Element → Settings → Security → Other sessions → Verify). Once verified the shield turns green and all messages are end-to-end encrypted.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, and `MATRIX_USER_ID` are all set in `.env` AND synced to `data/env/env`
2. Room is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'matrix:%'"`
3. For non-main rooms: message must include the trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### E2EE decryption errors in logs

The crypto store lives in `data/matrix/`. If it gets corrupted or keys are lost:

```bash
rm -rf data/matrix/
systemctl --user restart nanoclaw  # or launchctl kickstart
```

The bot will register a new device — you'll need to re-verify it in Element. Set `MATRIX_DEVICE_ID` in `.env` to a consistent value to reduce how often this happens.

### Access token rejected (401)

Access tokens expire if you log out of that session in Element. Re-generate one using the curl method in Phase 3 and update `.env` + `data/env/env`.

### `initRustCrypto` not found at runtime

You need `matrix-js-sdk >= 34`. Run:

```bash
npm install matrix-js-sdk@latest
npm run build
```

### Bot joins rooms but does not reply

Confirm the room JID was registered with the leading `matrix:` prefix and the full room ID including the homeserver part (e.g. `matrix:!abc123:matrix.org`).

## After Setup

The Matrix channel supports:
- **E2E encryption** — Rust-based crypto via `matrix-js-sdk`, keys persisted in `data/matrix/`
- **Auto-join** — bot accepts room invitations automatically
- **SAS / emoji verification** — requests are surfaced in logs and via native desktop notification (macOS `osascript`, Linux `notify-send`)
- **Typing indicators** — shown while the agent processes
- **Reply context** — `m.in_reply_to` is forwarded to the agent
- **Message splitting** — long responses chunked at 4 000 characters
- **Multi-channel** — runs alongside WhatsApp, Telegram, Slack, or Discord (auto-enabled by credentials)

## Removal

To remove the Matrix integration:

1. Delete `src/channels/matrix.ts` and `src/channels/matrix.test.ts`
2. Remove `import './matrix.js'` from `src/channels/index.ts`
3. Remove `MATRIX_*` variables from `.env` and sync: `mkdir -p data/env && cp .env data/env/env`
4. Remove Matrix registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'matrix:%'"`
5. Remove crypto store: `rm -rf data/matrix/`
6. Uninstall: `npm uninstall matrix-js-sdk`
7. Rebuild and restart:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```
