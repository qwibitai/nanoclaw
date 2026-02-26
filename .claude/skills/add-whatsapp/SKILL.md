---
name: add-whatsapp
description: Add WhatsApp as a channel. Can replace other channels entirely or run alongside them. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

This skill adds WhatsApp support to NanoClaw. It installs the WhatsApp channel code, dependencies, and guides through authentication, registration, and configuration.

## Phase 1: Pre-flight

### Check current state

Read `.env` and check `ENABLED_CHANNELS`. If `whatsapp` is already in the list and `store/auth/` exists with credential files, skip to Phase 4 (Registration) or Phase 5 (Verify).

```bash
ls store/auth/creds.json 2>/dev/null && echo "WhatsApp auth exists" || echo "No WhatsApp auth"
grep ENABLED_CHANNELS .env 2>/dev/null || echo "ENABLED_CHANNELS not set (defaults to whatsapp)"
```

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should WhatsApp replace your current channels or run alongside them?
- **Replace all** - WhatsApp will be the only channel
- **Alongside** - WhatsApp runs alongside existing channels

AskUserQuestion: How do you want to authenticate WhatsApp?
- **QR code in terminal** (Recommended) - Scan a QR code displayed in the terminal
- **Pairing code** - Enter a numeric code on your phone (requires your phone number)

If they chose pairing code:

AskUserQuestion: What is your phone number? (Include country code, e.g., +1234567890)

## Phase 2: Verify Code

Apply the skill to install the WhatsApp channel code and dependencies:

```bash
npx tsx skills-engine/apply.ts .claude/skills/add-whatsapp
```

Verify the code was placed correctly:

```bash
test -f src/channels/whatsapp.ts && echo "WhatsApp channel code present" || echo "ERROR: WhatsApp channel code missing — re-run skill apply"
```

### Verify dependencies

```bash
node -e "require('@whiskeysockets/baileys')" 2>/dev/null && echo "Baileys installed" || echo "Installing Baileys..."
```

If not installed:

```bash
npm install @whiskeysockets/baileys qrcode qrcode-terminal
```

### Validate build

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Authentication

### Clean previous auth state (if re-authenticating)

```bash
rm -rf store/auth/
```

### Run WhatsApp authentication

For QR code in terminal:

```bash
npx tsx src/whatsapp-auth.ts
```

Tell the user:

> Open WhatsApp on your phone:
>
> 1. Go to **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code displayed in the terminal
> 3. Wait for the "authenticated" confirmation

For pairing code:

```bash
npx tsx src/whatsapp-auth.ts --pairing-code --phone <their-phone-number>
```

Tell the user:

> A pairing code will appear in the terminal. Enter it on your phone:
>
> 1. Go to **Settings** > **Linked Devices** > **Link a Device**
> 2. Choose **Link with phone number instead**
> 3. Enter the pairing code shown in the terminal

### Verify authentication succeeded

```bash
test -f store/auth/creds.json && echo "Authentication successful" || echo "Authentication failed"
```

### Configure environment

Ensure `whatsapp` is in `ENABLED_CHANNELS` in `.env`:

If they chose to replace other channels, set `ENABLED_CHANNELS=whatsapp` (removing other channels).

If alongside, append `whatsapp` to the existing value (e.g., `ENABLED_CHANNELS=telegram,whatsapp`).

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Registration

### Determine chat type

Use `AskUserQuestion`:

AskUserQuestion: Is this a shared phone number (personal WhatsApp) or a dedicated number (separate device)?
- **Shared number** - Your personal WhatsApp number (recommended: use self-chat or a solo group)
- **Dedicated number** - A separate phone/SIM for the assistant

AskUserQuestion: Where do you want to chat with the assistant?
- **Self-chat** (Recommended) - Chat in your own "Message Yourself" conversation
- **Solo group** - A group with just you and the linked device
- **Existing group** - An existing WhatsApp group

### Get the JID

For self-chat: The JID is your phone number with `@s.whatsapp.net` (e.g., `1234567890@s.whatsapp.net`). Extract from auth credentials:

```bash
node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0]+'@s.whatsapp.net')"
```

For groups: Run group sync and list available groups:

```bash
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step groups --list
```

The output shows `JID|GroupName` pairs. Have the user identify their group.

### Ask registration details

AskUserQuestion: What trigger word should activate the assistant?
- **@Andy** - Default trigger
- **@Claw** - Short and easy
- **@Claude** - Match the AI name

AskUserQuestion: What should the assistant call itself?
- **Andy** - Default name
- **Claw** - Short and easy
- **Claude** - Match the AI name

### Register the chat

```bash
npx tsx setup/index.ts --step register \
  --jid "<jid>" \
  --name "<chat-name>" \
  --trigger "@<trigger>" \
  --folder "main" \
  --channel whatsapp \
  --assistant-name "<name>" \
  --no-trigger-required  # Only for main/self-chat
```

For additional groups (trigger-required):

```bash
npx tsx setup/index.ts --step register \
  --jid "<group-jid>" \
  --name "<group-name>" \
  --trigger "@<trigger>" \
  --folder "<folder-name>" \
  --channel whatsapp
```

## Phase 5: Verify

### Build and restart

```bash
npm run build
```

Restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw

# Linux (nohup fallback)
bash start-nanoclaw.sh
```

### Test the connection

Tell the user:

> Send a message to your registered WhatsApp chat:
> - For self-chat / main: Any message works
> - For groups: Use the trigger word (e.g., "@Andy hello")
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### QR code expired

QR codes expire after ~60 seconds. Re-run the auth command:

```bash
rm -rf store/auth/ && npx tsx src/whatsapp-auth.ts
```

### Pairing code not working

Ensure:
1. Phone number includes country code without `+` (e.g., `1234567890`)
2. Phone has internet access
3. WhatsApp is updated to the latest version

### "conflict" disconnection

This happens when two instances connect with the same credentials. Ensure only one NanoClaw process is running:

```bash
pkill -f "node dist/index.js"
# Then restart
```

### Bot not responding

Check:
1. `ENABLED_CHANNELS` includes `whatsapp` in `.env` AND synced to `data/env/env`
2. Auth credentials exist: `ls store/auth/creds.json`
3. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE '%whatsapp%' OR jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. Logs: `tail -50 logs/nanoclaw.log`

### Group names not showing

Run group metadata sync:

```bash
npx tsx setup/index.ts --step groups
```

This fetches all group names from WhatsApp. Runs automatically every 24 hours.

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

## Removal

To remove WhatsApp integration:

1. Remove `whatsapp` from `ENABLED_CHANNELS` in `.env`
2. Delete auth credentials: `rm -rf store/auth/`
3. Remove WhatsApp registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
4. Sync env: `mkdir -p data/env && cp .env data/env/env`
5. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
