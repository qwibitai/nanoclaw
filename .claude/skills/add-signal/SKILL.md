---
name: add-signal
description: Add Signal channel integration via signal-cli TCP daemon. Native adapter — no Chat SDK bridge.
---

# Add Signal Channel

Adds Signal messaging support via a native adapter that speaks JSON-RPC to a [signal-cli](https://github.com/AsamK/signal-cli) TCP daemon. No Chat SDK bridge, no npm deps — only Node.js builtins.

## Prerequisites

`signal-cli` installed and a Signal account linked:

- macOS: `brew install signal-cli`
- Linux: download from [GitHub releases](https://github.com/AsamK/signal-cli/releases)
- Link your account: `signal-cli -a +1YOURNUMBER link` (follow the QR instructions)

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Signal adapter and its tests in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/signal.ts` and `src/channels/signal.test.ts` both exist
- `src/channels/index.ts` contains `import './signal.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and tests

```bash
git show origin/channels:src/channels/signal.ts      > src/channels/signal.ts
git show origin/channels:src/channels/signal.test.ts > src/channels/signal.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './signal.js';
```

### 4. Build

```bash
pnpm run build
```

No npm packages to install — the adapter uses only Node.js builtins (`node:net`, `node:child_process`, `node:fs`).

## Credentials

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+1YOURNUMBER
```

### Optional settings

```bash
# TCP daemon host and port (default: 127.0.0.1:7583)
SIGNAL_TCP_HOST=127.0.0.1
SIGNAL_TCP_PORT=7583

# Path to the signal-cli binary (default: resolved on PATH)
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli

# Whether NanoClaw manages the daemon lifecycle (default: true).
# Set to false if you run signal-cli daemon externally.
SIGNAL_MANAGE_DAEMON=true

# signal-cli data directory (default: ~/.local/share/signal-cli)
SIGNAL_DATA_DIR=~/.local/share/signal-cli
```

**Security note:** keep the TCP host on `127.0.0.1`. The daemon has no auth — binding it to a public interface would expose your full Signal account to the network.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent and wire it to your Signal DM, or `/manage-channels` to wire this channel to an existing agent group. Signal is direct-addressable — your phone number is the platform ID.

## Channel Info

- **type**: `signal`
- **terminology**: Signal has "chats" (1:1 DMs) and "groups."
- **how-to-find-id**: DMs use your phone number (e.g. `+15555550123`). Groups use `group:<groupId>` — find group IDs via `signal-cli -a +1YOURNUMBER listGroups`.
- **supports-threads**: no
- **typical-use**: Personal assistant via Signal DMs or small group chats
- **default-isolation**: One agent per Signal account. Multiple chats with the same operator can share an agent group; groups with other people should typically be separate.

### Features

- Markdown formatting — `**bold**`, `*italic*` / `_italic_`, `` `code` ``, ` ```code fence``` `, `~~strike~~`, `||spoiler||` (converted to Signal's offset-based text styles)
- Quoted replies — `replyTo*` fields populated from Signal quotes
- Typing indicators — DMs only (Signal doesn't support group typing)
- Echo suppression — outbound messages are matched on `(platformId, text)` within a 10 s TTL to avoid syncMessage loops
- Note to Self — messages you send to your own account from another device route to the agent as inbound with `isFromMe: true`
- Voice attachments — detected but not transcribed by default; the agent receives `[Voice Message]` placeholder text. Run `/add-voice-transcription` for local transcription via parakeet-mlx

Not supported yet: outbound file attachments (logged and dropped), edit/delete messages, reactions.

## Troubleshooting

### Daemon not reachable

```bash
grep "Signal" logs/nanoclaw.log | tail
```

If you see `Signal daemon failed to start. Is signal-cli installed and your account linked?`:
- Confirm `signal-cli` is on PATH (or set `SIGNAL_CLI_PATH`)
- Confirm the account is linked: `signal-cli -a +1YOURNUMBER listIdentities` should succeed without prompting

If you see `Signal daemon not reachable at 127.0.0.1:7583` and `SIGNAL_MANAGE_DAEMON=false`, start the daemon yourself: `signal-cli -a +1YOURNUMBER daemon --tcp 127.0.0.1:7583`.

### Bot not responding

1. Channel initialized: `grep "Signal channel connected" logs/nanoclaw.log | tail -1`
2. Channel wired: `sqlite3 data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='signal'"`
3. Service running: `launchctl print gui/$(id -u)/com.nanoclaw` (macOS) / `systemctl --user status nanoclaw` (Linux)

### Lost connection mid-session

If you see `Signal channel lost TCP connection to signal-cli daemon` in the logs, the daemon dropped us. There's no auto-reconnect yet — restart the service to re-establish.
