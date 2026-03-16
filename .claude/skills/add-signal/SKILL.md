---
name: add-signal
description: Add Signal as a channel via signal-cli HTTP daemon. Supports dedicated phone numbers and shared accounts (Note to Self). Run alongside other channels.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw. It installs the Signal channel code, then guides through signal-cli installation, account registration, and chat configuration.

## Phase 1: Pre-flight

### Check current state

Check if Signal is already configured:

```bash
test -f src/channels/signal.ts && echo "Signal code exists" || echo "No Signal code"
grep -q SIGNAL_ACCOUNT .env 2>/dev/null && echo "Signal configured in .env" || echo "Signal not in .env"
```

If `src/channels/signal.ts` exists AND `SIGNAL_ACCOUNT` is set in `.env`, skip to Phase 4 (Registration) or Phase 5 (Verify).

### Detect platform

```bash
uname -m  # x86_64 or aarch64
uname -s  # Linux or Darwin
```

### Ask the user

AskUserQuestion: How do you want to use Signal with NanoClaw?
- **Dedicated number** (Recommended) — Register a separate phone number for the assistant. Users DM the bot or add it to groups.
- **Shared account (Note to Self)** — Link NanoClaw to your existing Signal account. Chat with the agent via Note to Self. No second phone number needed.

AskUserQuestion: Do you already have signal-cli installed?
- **No** — I need to install it
- **Yes** — It's already installed

If they already have signal-cli, verify it works:

```bash
signal-cli --version
```

Requires v0.14.x or later. If older, guide them to upgrade.

## Phase 2: Apply Code Changes

Check if `src/channels/signal.ts` already exists. If it does, skip to Phase 3.

### Ensure channel remote

```bash
git remote -v
```

If `signal` is missing, add it:

```bash
git remote add signal https://github.com/brentkearney/nanoclaw-signal.git
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
- `src/channels/signal.test.ts` (26 unit tests)
- `import './signal.js'` appended to the channel barrel file `src/channels/index.ts`
- `SIGNAL_ACCOUNT`, `SIGNAL_CLI_PATH`, `SIGNAL_HTTP_HOST`, `SIGNAL_HTTP_PORT`, `SIGNAL_MANAGE_DAEMON`, `ASSISTANT_HAS_OWN_NUMBER` in `.env.example`
- `docs/signal-setup.md` setup and troubleshooting guide

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Install signal-cli

### Check if already installed

```bash
signal-cli --version 2>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If installed and version is 0.14.x or later, skip to Phase 4. If installed but older, guide the user to upgrade using the instructions below.

### macOS

```bash
brew install signal-cli
```

### Linux (x86_64)

```bash
curl -fSL -o signal-cli.tar.gz \
  https://github.com/AsamK/signal-cli/releases/download/v0.14.1/signal-cli-0.14.1.tar.gz
sudo tar -xzf signal-cli.tar.gz -C /opt
sudo ln -sf /opt/signal-cli-0.14.1/bin/signal-cli /usr/local/bin/signal-cli
rm signal-cli.tar.gz
```

Install Java 25 via [Eclipse Temurin](https://adoptium.net/):

```bash
curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | sudo tee /usr/share/keyrings/adoptium.asc
echo "deb [signed-by=/usr/share/keyrings/adoptium.asc] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" \
  | sudo tee /etc/apt/sources.list.d/adoptium.list
sudo apt update && sudo apt install -y temurin-25-jdk
```

### Linux ARM64 (Raspberry Pi)

Follow the x86_64 instructions above, then install the native libsignal library.

signal-cli's Java distribution only bundles x86_64 native libraries. On ARM64 you need `libsignal_jni.so` from [exquo/signal-libs-build](https://github.com/exquo/signal-libs-build):

```bash
# Check which version signal-cli needs
ls /opt/signal-cli-0.14.1/lib/libsignal-client-*.jar
# e.g. libsignal-client-0.87.4.jar → need v0.87.x

# Download closest available ARM64 build
curl -fSL -o libsignal.tar.gz \
  https://github.com/exquo/signal-libs-build/releases/download/libsignal_v0.87.3/libsignal_jni.so-v0.87.3-aarch64-unknown-linux-gnu.tar.gz
tar -xzf libsignal.tar.gz
sudo cp libsignal_jni.so /usr/lib64/
rm libsignal.tar.gz libsignal_jni.so
```

### Verify installation

```bash
signal-cli --version
```

Should show `signal-cli 0.14.x`.

## Phase 4: Register Signal Account

### Dedicated number

Register a number that only the assistant uses:

```bash
signal-cli -a +1YOURNUMBER register
# You'll receive an SMS or voice call with a verification code
signal-cli -a +1YOURNUMBER verify CODE
```

### Shared account (Note to Self)

Link to an existing Signal account:

```bash
signal-cli link -n "NanoClaw"
```

This prints a `sgnl://` URI. Convert it to a QR code to scan:

```bash
# Option 1: Use qrencode (install with apt/brew)
signal-cli link -n "NanoClaw" 2>&1 | head -1 | xargs qrencode -t UTF8
# Option 2: Paste the URI into an online QR generator
```

Then scan with Signal on your phone: **Settings → Linked Devices → Link New Device**.

The link process requires quick action — the URI expires within seconds. Have your phone ready before running the command.

## Phase 5: Configure

### Set environment variables

AskUserQuestion: What should the assistant call itself?
- **Andy** — Default name
- **Claw** — Short and easy
- **Claude** — Match the AI name

AskUserQuestion: What trigger word should activate the assistant in group chats?
- **@Andy** — Default trigger
- **@Claw** — Short and easy
- **@Claude** — Match the AI name

Set the following in `.env`:

```bash
# Signal configuration
SIGNAL_ACCOUNT=+1YOURNUMBER
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli   # or: signal-cli (if in PATH)
SIGNAL_MANAGE_DAEMON=true

# Only if assistant has its own dedicated number:
ASSISTANT_HAS_OWN_NUMBER=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 6: Register a Chat

### Get the JID

**Dedicated number (DM):** The JID is the sender's phone number or UUID. Start the service briefly, send a test message to the bot, and check logs for the JID:

```bash
npm run build && timeout 30 npx tsx src/index.ts 2>&1 | grep "Signal chat"
```

The log will show something like `signal:+14035551234` or `signal:390d5c00-...`.

**Shared account (Note to Self):** The JID is your own account number:

```
signal:+1YOURNUMBER
```

**Group:** Start the service, send a message in the group mentioning the trigger, and check logs for the group JID:

```
signal:group:<base64Id>
```

### Register the chat

```bash
npx tsx setup/index.ts --step register \
  --jid "<jid>" \
  --name "<chat-name>" \
  --trigger "@<trigger>" \
  --folder "signal_main" \
  --channel signal \
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
  --folder "signal_<group-name>" \
  --channel signal
```

## Phase 7: Verify

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

> Send a message to your registered Signal chat:
> - For Note to Self / main: Any message works
> - For groups: Use the trigger word (e.g., "@Andy hello")
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### "Signal daemon failed to start"

Check that signal-cli can run standalone:

```bash
signal-cli -a +1YOURNUMBER daemon --http 127.0.0.1:7583
```

### "User +NUMBER is not registered"

The signal-cli data directory doesn't have the account. If you registered as a different user, copy the data:

```bash
sudo cp -a /home/otheruser/.local/share/signal-cli/data/* \
  ~/.local/share/signal-cli/data/
```

### "bad parameter type SignedPreKeyStore"

Version mismatch between `libsignal_jni.so` and the signal-cli JAR. Ensure the native library version matches the `libsignal-client-*.jar` version in signal-cli's lib directory.

### ARM64: "no signal_jni in java.library.path"

The native library isn't in a path Java can find. Copy it to `/usr/lib64/` or the path shown in the error.

### Messages show as "Unknown" sender

The profile name wasn't set. NanoClaw sets it automatically on connect (using `ASSISTANT_NAME` from `.env`). If it still shows Unknown, restart the service.

### signal-cli link URI expires too fast

The WebSocket connection closes quickly. Have your phone ready on **Settings → Linked Devices** before running the command. Use `qrencode` to display the QR code instantly:

```bash
signal-cli link -n "NanoClaw" 2>&1 | head -1 | xargs qrencode -t UTF8
```

## Removal

To remove Signal integration:

1. Remove Signal registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'signal:%'"`
2. Remove `SIGNAL_ACCOUNT` and related vars from `.env`
3. Sync env: `mkdir -p data/env && cp .env data/env/env`
4. Rebuild and restart
