---
name: add-whatsapp
description: Add WhatsApp as a channel. Can replace other channels entirely or run alongside them. Uses QR code or pairing code for authentication.
---

# Add WhatsApp Channel

This skill adds WhatsApp support to NanoClaw. It installs the WhatsApp channel code, dependencies, and guides through authentication, registration, and configuration.

## Phase 1: Pre-flight

### Check current state

Check if WhatsApp is already configured. If `store/auth/` exists with credential files, skip to Phase 4 (Registration) or Phase 5 (Verify).

```bash
ls store/auth/creds.json 2>/dev/null && echo "WhatsApp auth exists" || echo "No WhatsApp auth"
```

### Detect environment

Check whether the environment is headless (no display server):

```bash
[[ -z "$DISPLAY" && -z "$WAYLAND_DISPLAY" && "$OSTYPE" != darwin* ]] && echo "IS_HEADLESS=true" || echo "IS_HEADLESS=false"
```

### Ask the user

Use `AskUserQuestion` to collect configuration. **Adapt auth options based on environment:**

If IS_HEADLESS=true AND not WSL → AskUserQuestion: How do you want to authenticate WhatsApp?

- **Pairing code** (Recommended) - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: How do you want to authenticate WhatsApp?

- **QR code in browser** (Recommended) - Opens a browser window with a large, scannable QR code
- **Pairing code** - Enter a numeric code on your phone (no camera needed, requires phone number)
- **QR code in terminal** - Displays QR code in the terminal (can be too small on some displays)

If they chose pairing code:

AskUserQuestion: What is your phone number? (Include country code without +, e.g., 1234567890)

## Phase 2: Apply Code Changes

Check if `src/channels/whatsapp.ts` already exists. If it does, skip to Phase 3 (Authentication).

### Ensure channel remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp main
git merge whatsapp/main
```

This merges in:

- `src/channels/whatsapp.ts` (WhatsAppChannel class with self-registration via `registerChannel`)
- `src/channels/whatsapp.test.ts` (41 unit tests)
- `src/whatsapp-auth.ts` (standalone WhatsApp authentication script)
- `setup/whatsapp-auth.ts` (WhatsApp auth setup step)
- `import './whatsapp.js'` appended to the channel barrel file `src/channels/index.ts`
- `'whatsapp-auth'` step added to `setup/index.ts`
- `@whiskeysockets/baileys`, `qrcode`, `qrcode-terminal` npm dependencies in `package.json`
- `ASSISTANT_HAS_OWN_NUMBER` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Authentication

### Clean previous auth state (if re-authenticating)

```bash
rm -rf store/auth/
```

### Run WhatsApp authentication

For QR code in browser (recommended):

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

(Bash timeout: 150000ms)

Tell the user:

> A browser window will open with a QR code.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code in the browser
> 3. The page will show "Authenticated!" when done

For QR code in terminal:

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal
```

Tell the user to run `npm run auth` in another terminal, then:

> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Scan the QR code displayed in the terminal

For pairing code:

Tell the user to have WhatsApp open on **Settings > Linked Devices > Link a Device**, ready to tap **"Link with phone number instead"** — the code expires in ~60 seconds and must be entered immediately.

Run the auth process in the background and poll `store/pairing-code.txt` for the code:

```bash
rm -f store/pairing-code.txt && npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone <their-phone-number> > /tmp/wa-auth.log 2>&1 &
```

Then immediately poll for the code (do NOT wait for the background command to finish):

```bash
for i in $(seq 1 20); do [ -f store/pairing-code.txt ] && cat store/pairing-code.txt && break; sleep 1; done
```

Display the code to the user the moment it appears. Tell them:

> **Enter this code now** — it expires in ~60 seconds.
>
> 1. Open WhatsApp > **Settings** > **Linked Devices** > **Link a Device**
> 2. Tap **Link with phone number instead**
> 3. Enter the code immediately

After the user enters the code, poll for authentication to complete:

```bash
for i in $(seq 1 60); do grep -q 'AUTH_STATUS: authenticated' /tmp/wa-auth.log 2>/dev/null && echo "authenticated" && break; grep -q 'AUTH_STATUS: failed' /tmp/wa-auth.log 2>/dev/null && echo "failed" && break; sleep 2; done
```

**If failed:** qr_timeout → re-run. logged_out → delete `store/auth/` and re-run. 515 → re-run. timeout → ask user, offer retry.

### Verify authentication succeeded

```bash
test -f store/auth/creds.json && echo "Authentication successful" || echo "Authentication failed"
```

### Configure environment

Channels auto-enable when their credentials are present — WhatsApp activates when `store/auth/creds.json` exists.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Registration

### Configure trigger and channel type

Get the bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Is this a shared phone number (personal WhatsApp) or a dedicated number (separate device)?

- **Shared number** - Your personal WhatsApp number (recommended: use self-chat or a solo group)
- **Dedicated number** - A separate phone/SIM for the assistant

AskUserQuestion: What trigger word should activate the assistant?

- **@Andy** - Default trigger
- **@Claw** - Short and easy
- **@Claude** - Match the AI name

AskUserQuestion: What should the assistant call itself?

- **Andy** - Default name
- **Claw** - Short and easy
- **Claude** - Match the AI name

AskUserQuestion: Where do you want to chat with the assistant?

**Shared number options:**

- **Self-chat** (Recommended) - Chat in your own "Message Yourself" conversation
- **Solo group** - A group with just you and the linked device
- **Existing group** - An existing WhatsApp group

**Dedicated number options:**

- **DM with bot** (Recommended) - Direct message the bot's number
- **Solo group** - A group with just you and the bot
- **Existing group** - An existing WhatsApp group

### Get the JID

**Self-chat:** JID = your phone number with `@s.whatsapp.net`. Extract from auth credentials:

```bash
node -e "const c=JSON.parse(require('fs').readFileSync('store/auth/creds.json','utf-8'));console.log(c.me?.id?.split(':')[0]+'@s.whatsapp.net')"
```

**DM with bot:** Ask for the bot's phone number. JID = `NUMBER@s.whatsapp.net`

**Group (solo, existing):** Run group sync and list available groups:

```bash
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step groups --list
```

The output shows `JID|GroupName` pairs. Present candidates as AskUserQuestion (names only, not JIDs).

### Register the chat

```bash
npx tsx setup/index.ts --step register \
  --jid "<jid>" \
  --name "<chat-name>" \
  --trigger "@<trigger>" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "<name>" \
  --is-main \
  --no-trigger-required  # Only for main/self-chat
```

For additional groups (trigger-required):

```bash
npx tsx setup/index.ts --step register \
  --jid "<group-jid>" \
  --name "<group-name>" \
  --trigger "@<trigger>" \
  --folder "whatsapp_<group-name>" \
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
>
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

Codes expire in ~60 seconds. To retry:

```bash
rm -rf store/auth/ && npx tsx src/whatsapp-auth.ts --pairing-code --phone <phone>
```

Enter the code **immediately** when it appears. Also ensure:

1. Phone number includes country code without `+` (e.g., `1234567890`)
2. Phone has internet access
3. WhatsApp is updated to the latest version

If pairing code keeps failing, switch to QR-browser auth instead:

```bash
rm -rf store/auth/ && npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

### "conflict" disconnection

This happens when two instances connect with the same credentials. Ensure only one NanoClaw process is running:

```bash
pkill -f "node dist/index.js"
# Then restart
```

### Bot not responding

Check:

1. Auth credentials exist: `ls store/auth/creds.json`
2. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE '%whatsapp%' OR jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
3. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
4. Logs: `tail -50 logs/nanoclaw.log`

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

1. Delete auth credentials: `rm -rf store/auth/`
2. Remove WhatsApp registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net'"`
3. Sync env: `mkdir -p data/env && cp .env data/env/env`
4. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
