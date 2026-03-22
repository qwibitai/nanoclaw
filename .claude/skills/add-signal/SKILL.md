---
name: add-signal
description: "Add Signal messenger as a channel via signal-cli TCP JSON-RPC daemon. Supports text, voice notes, images, groups, and contact approval."
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add Signal Channel

This skill adds Signal messenger support to NanoClaw. Your assistant can send and receive messages, transcribe voice notes, view images, and manage group conversations — all through Signal's end-to-end encrypted protocol.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **signal-cli** | A command-line tool that connects to Signal's servers (like a headless Signal app) |
| **signal-cli daemon** | signal-cli running as a background service, listening for messages on a TCP port |
| **SignalChannel** (`src/channels/signal.ts`) | NanoClaw code that connects to signal-cli and routes messages to/from the agent |

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/signal.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Do you have signal-cli installed, or do you need help installing it?

Options:
- "I have signal-cli installed" — Proceed to ask for their Signal phone number
- "I need to install it" — We'll install it in Phase 3
- "What is signal-cli?" — Explain: it's a command-line Signal client that runs without a phone. Your assistant gets its own Signal number.

Then ask:

AskUserQuestion: Do you have a dedicated phone number for the assistant, or will it share yours?

- "Dedicated number" — Set `ASSISTANT_HAS_OWN_NUMBER=true` (assistant responds to all DMs without trigger word)
- "Shared number" — Keep default (trigger word required like `@AssistantName`)

## Phase 2: Apply Code Changes

### Add Signal channel files

Copy these files into the project:

| File | Purpose |
|------|---------|
| `src/channels/signal.ts` | Signal channel implementation — connects to signal-cli via TCP, handles messages, voice notes, images |
| `src/channels/signal.test.ts` | Unit tests for the Signal channel |

### Update config.ts

Add these exports to `src/config.ts` (read from `.env` via `readEnvFile`):

```typescript
export const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST = process.env.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = process.env.SIGNAL_CLI_TCP_PORT || '7583';
export const TRIGGER_WORD = process.env.TRIGGER_WORD || envConfig.TRIGGER_WORD || ASSISTANT_NAME;
export const ASSISTANT_HAS_OWN_NUMBER = (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
```

Also add `SIGNAL_PHONE_NUMBER`, `TRIGGER_WORD`, `ASSISTANT_HAS_OWN_NUMBER` to the `readEnvFile()` keys array.

### Update index.ts

Add Signal channel initialization in `src/index.ts`:

```typescript
import { SignalChannel } from './channels/signal.js';
import { SIGNAL_PHONE_NUMBER } from './config.js';

// In the channel setup section:
if (SIGNAL_PHONE_NUMBER) {
  const signal = new SignalChannel({
    onMessage: handleInboundMessage,
    onChatMetadata: handleChatMetadata,
    registeredGroups: () => registeredGroups,
  });
  channels.push(signal);
}
```

### Update container-runner.ts

Add a mount so containers can view images sent via Signal:

- Host path: `~/.local/share/signal-cli/attachments/` (or wherever signal-cli stores attachments)
- Container path: `/workspace/attachments`
- Read-only: yes

### Validate

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and build must be clean.

## Phase 3: Setup

### Install signal-cli (if needed)

Download the latest release:

```bash
# Check latest version at https://github.com/AsamK/signal-cli/releases
VERSION=0.13.24
curl -L -o /tmp/signal-cli.tar.gz \
  "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux.tar.gz"
sudo tar xf /tmp/signal-cli.tar.gz -C /opt/
sudo ln -sf /opt/signal-cli-${VERSION}/bin/signal-cli /usr/local/bin/signal-cli
```

Verify: `signal-cli --version`

### Register a Signal number

You need a phone number that can receive SMS for verification:

```bash
signal-cli -u +1YOURNUMBER register
# Enter the verification code you receive via SMS:
signal-cli -u +1YOURNUMBER verify CODE
```

### Create signal-cli systemd service

Create `~/.config/systemd/user/signal-cli.service`:

```ini
[Unit]
Description=signal-cli JSON-RPC daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/signal-cli -u +1YOURNUMBER daemon --tcp 127.0.0.1:7583
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Replace `+1YOURNUMBER` with the registered number.

```bash
systemctl --user daemon-reload
systemctl --user enable signal-cli
systemctl --user start signal-cli
```

### Configure .env

Add to `.env`:

```
SIGNAL_PHONE_NUMBER=+1YOURNUMBER
SIGNAL_CLI_TCP_HOST=127.0.0.1
SIGNAL_CLI_TCP_PORT=7583
TRIGGER_WORD=YourAssistantName
```

Set `ASSISTANT_HAS_OWN_NUMBER=true` if using a dedicated number.

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Discover chat JIDs

Send a message to the assistant's Signal number. Then check the database for the chat JID:

```bash
sqlite3 store/messages.db "SELECT jid FROM chats WHERE channel = 'signal' ORDER BY last_message_time DESC LIMIT 5;"
```

Signal JID formats:
- **Individual:** `signal:<UUID>` or `signal:+phone`
- **Group:** `signal:group.<base64GroupId>`

### Register the main chat

```bash
npx tsx setup/index.ts --step register -- \
  --jid "signal:<your-jid>" \
  --name "Main" \
  --folder "main" \
  --trigger "@${TRIGGER_WORD}" \
  --channel signal \
  --no-trigger-required \
  --is-main
```

### Register additional groups

For groups where the trigger word is required:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "signal:group.<base64id>" \
  --name "Group Name" \
  --folder "signal_group-name" \
  --trigger "@${TRIGGER_WORD}" \
  --channel signal
```

### Contact approval (optional)

When someone sends a DM for the first time, NanoClaw stores the message and notifies the main chat. You can approve contacts by telling the assistant "approve contact [name]", which registers them as a new group.

## Phase 5: Verify

### Test the connection

Send a message to the assistant via Signal. You should see a response within a few seconds.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i signal
```

Look for: `Signal channel connected` and `Subscribed to receive messages`.

### Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "ECONNREFUSED" on port 7583 | signal-cli daemon isn't running | `systemctl --user start signal-cli` |
| "InvalidMetadataMessageException" | signal-cli version too old for sealed sender | Upgrade to signal-cli 0.13.22 or newer |
| Messages not arriving | signal-cli only sends others' messages, not your own | This is by design — you won't see messages you send from other devices |
| Voice notes say "transcription not available" | Voice transcription skill not installed | Apply the `add-voice-transcription` skill for voice note support |
| Images not visible to agent | Attachments directory not mounted | Check the container-runner.ts mount for signal-cli attachments |

## Removal

1. Remove `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove Signal imports and instantiation from `src/index.ts`
3. Remove Signal config exports from `src/config.ts`
4. Remove attachments mount from `src/container-runner.ts`
5. Remove `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_TCP_*`, `TRIGGER_WORD` from `.env`
6. Rebuild: `npm run build`
7. Optionally stop signal-cli: `systemctl --user stop signal-cli && systemctl --user disable signal-cli`
