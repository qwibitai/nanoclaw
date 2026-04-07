---
name: add-matrix
description: Add Matrix as a channel. Supports E2E-encrypted rooms on any homeserver (default matrix.org). Uses an access token for headless auth — no QR code needed. Run this skill to merge the code, configure credentials, and register your first Matrix room.
---

# Add Matrix Channel

## Phase 1: Pre-flight

### Check if already applied
Look for `src/channels/matrix.ts`. If it exists, skip to Phase 3.

```bash
ls src/channels/matrix.ts 2>/dev/null && echo "Already applied" || echo "Not yet applied"
```

### Ensure you are on the right base branch
```bash
git status
```

---

## Phase 2: Apply Code Changes

### Merge the skill branch
```bash
git remote add matrix-skill https://github.com/scharmen/nanoclaw.git 2>/dev/null || true
git fetch matrix-skill claude/matrix-messenger-skill-buVHI
git merge --no-edit matrix-skill/claude/matrix-messenger-skill-buVHI
```

If there are conflicts, resolve them and run `git merge --continue`.

### Install the new dependency
```bash
npm install
```

`matrix-js-sdk` bundles a pre-built Rust crypto binary for your platform — no manual compilation is needed.

### Validate
```bash
npm run build
npx vitest run src/channels/matrix.test.ts
```

All tests must pass before continuing.

---

## Phase 3: Create a Matrix Bot Account

Skip this phase if you already have a Matrix account you want to use as the bot.

1. Open <https://app.element.io> (or any Matrix client).
2. Register a new account on **matrix.org** (or your own homeserver).
3. Note down the full user ID: `@yourbotname:matrix.org`.

---

## Phase 4: Obtain an Access Token

The bot authenticates with a long-lived access token (not a password).

### Option A — Element Web / Desktop
1. Log in as the bot account.
2. Go to **Settings → Help & About → Advanced**.
3. Copy the **Access Token** field.

### Option B — curl (any homeserver)
```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "m.login.password",
    "user": "@yourbotname:matrix.org",
    "password": "YOUR_PASSWORD"
  }'
```
Copy the `access_token` value from the response.

### Option C — OneCLI (recommended for production)
Store the token in the vault so it is never written to disk in plain text:
```bash
onecli secret set MATRIX_ACCESS_TOKEN
```

---

## Phase 5: Configure Environment Variables

Add the following to `.env` (or inject via OneCLI / systemd `Environment=`):

```
MATRIX_HOMESERVER=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_…
MATRIX_USER_ID=@yourbotname:matrix.org
# Optional — reuse a registered device ID across restarts:
# MATRIX_DEVICE_ID=ABCDEF1234
```

Sync credentials into the container environment:
```bash
mkdir -p data/env && cp .env data/env/env
```

---

## Phase 6: Build and Restart

```bash
npm run build
```

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux (systemd):**
```bash
systemctl --user restart nanoclaw
```

Watch the logs to confirm the channel connects:

```bash
# macOS
tail -f ~/Library/Logs/nanoclaw/nanoclaw.log

# Linux
journalctl --user -u nanoclaw -f
```

You should see: `[matrix] Connected as @yourbotname:matrix.org`

---

## Phase 7: Register a Matrix Room

Invite your bot to a room, then register it as a NanoClaw group.

1. In your Matrix client, create a room (or open an existing one).
2. Invite the bot: `/invite @yourbotname:matrix.org`
3. The bot auto-accepts the invitation.
4. Copy the **Room ID** from room settings (format: `!abc123:matrix.org`).

Register the room:
```bash
npx tsx setup/index.ts --step register -- \
  --jid "matrix:!YOUR_ROOM_ID:matrix.org" \
  --name "My Matrix Room" \
  --trigger "@nanoclaw"
```

Add `--main` to make it the primary control room (no trigger required, elevated privileges).

---

## Phase 8: Verify E2E Encryption

Matrix rooms can require encryption. To confirm E2EE is active:

1. Open the room in Element (or another Matrix client).
2. Click the shield icon — it should show the bot's device.
3. If verification is requested, the bot prints a notice in its logs and sends a **native desktop notification** — accept the SAS (emoji) verification from your client.

To cross-sign the bot's device from Element:
- Go to **Settings → Security → Other sessions**.
- Click the bot's session → **Verify**.

Once verified, the shield turns green and all messages are E2E encrypted end-to-end.

---

## Troubleshooting

**Bot does not appear online after restart**
- Check that `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, and `MATRIX_USER_ID` are all set.
- Confirm `data/env/env` was updated after editing `.env`.

**Messages arrive but are not processed**
- Confirm the room is registered (`npx tsx setup/index.ts --step list`).
- Check the trigger pattern matches what you send.

**E2EE decryption errors in logs**
- Delete `data/matrix/` to reset the crypto store, then restart. Re-verification will be required.
- Ensure `MATRIX_DEVICE_ID` is consistent across restarts.

**`initRustCrypto` not found**
- You need `matrix-js-sdk >= 34`. Run `npm install matrix-js-sdk@latest` to upgrade.
