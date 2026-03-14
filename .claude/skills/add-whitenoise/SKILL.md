---
name: add-whitenoise
description: "Add White Noise (Marmot protocol) as a channel. Decentralized end-to-end encrypted group messaging via MLS + Nostr. Compatible with the White Noise mobile app."
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add White Noise Channel

This skill adds White Noise messaging support to NanoClaw. White Noise uses the Marmot protocol (MLS + Nostr) for decentralized, end-to-end encrypted group messaging. Your assistant joins White Noise groups and can send/receive messages through the White Noise mobile app.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **whitenoise-rs** (`wn` and `wnd`) | The White Noise command-line client and background daemon |
| **wnd daemon** | Runs in the background, maintains MLS group state and relay connections |
| **WhiteNoiseChannel** (`src/channels/whitenoise.ts`) | NanoClaw code that polls `wn` for new messages and sends replies |

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/whitenoise.ts` exists. If it does, skip to Phase 3.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Do you have whitenoise-rs built, or do you need help building it?

Options:
- "I have it built" — Ask where the `wn` binary is located
- "I need to build it" — We'll build it from source in Phase 3
- "What is White Noise?" — Explain: it's a decentralized encrypted messaging app. Think Signal, but without a central server. Uses the Marmot protocol built on MLS (the same encryption standard used by Google Messages and Apple iMessage).

## Phase 2: Apply Code Changes

### Add White Noise channel file

Copy `src/channels/whitenoise.ts` into the project.

### Update config.ts

Add these exports to `src/config.ts`:

```typescript
export const WN_BINARY_PATH = process.env.WN_BINARY_PATH ||
  envConfig.WN_BINARY_PATH ||
  `${process.env.HOME}/.local/bin/wn`;

export const WN_SOCKET_PATH = process.env.WN_SOCKET_PATH ||
  envConfig.WN_SOCKET_PATH ||
  `${process.env.HOME}/.local/share/whitenoise-cli/release/wnd.sock`;

export const WN_ACCOUNT_PUBKEY = process.env.WN_ACCOUNT_PUBKEY ||
  envConfig.WN_ACCOUNT_PUBKEY || '';
```

Add `WN_BINARY_PATH`, `WN_SOCKET_PATH`, `WN_ACCOUNT_PUBKEY` to the `readEnvFile()` keys array.

### Update index.ts

Add White Noise channel initialization:

```typescript
import { WhiteNoiseChannel } from './channels/whitenoise.js';
import { WN_ACCOUNT_PUBKEY } from './config.js';

// In the channel setup section:
if (WN_ACCOUNT_PUBKEY) {
  const whitenoise = new WhiteNoiseChannel({
    onMessage: handleInboundMessage,
    onChatMetadata: handleChatMetadata,
    registeredGroups: () => registeredGroups,
  });
  channels.push(whitenoise);
}
```

### Validate

```bash
npm run build
```

## Phase 3: Setup

### Build whitenoise-rs (if needed)

You need Rust installed (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`).

```bash
cd ~
git clone https://github.com/niceguy/whitenoise-rs.git
cd whitenoise-rs
cargo build --release
```

Create symlinks so NanoClaw can find the binaries:

```bash
mkdir -p ~/.local/bin
ln -sf ~/whitenoise-rs/target/release/wn ~/.local/bin/wn
ln -sf ~/whitenoise-rs/target/release/wnd ~/.local/bin/wnd
```

> **Note:** The bare `wn` command can conflict with WordNet (a dictionary tool). The symlinks in `~/.local/bin/` take priority if that directory is on your PATH.

### Create wnd systemd service

Create `~/.config/systemd/user/wnd.service`:

```ini
[Unit]
Description=White Noise daemon
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/wnd
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable wnd
systemctl --user start wnd
```

### Login

```bash
wn login --socket ~/.local/share/whitenoise-cli/release/wnd.sock
```

After login, restart wnd to pick up the new account:
```bash
systemctl --user restart wnd
```

### Get your account pubkey

```bash
wn account --socket ~/.local/share/whitenoise-cli/release/wnd.sock
```

Copy the pubkey (64-character hex string).

### Configure .env

```
WN_BINARY_PATH=~/.local/bin/wn
WN_SOCKET_PATH=~/.local/share/whitenoise-cli/release/wnd.sock
WN_ACCOUNT_PUBKEY=<your-64-char-hex-pubkey>
```

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw
```

Make sure nanoclaw starts after wnd by adding `After=wnd.service` to your nanoclaw.service file.

## Phase 4: Registration

### Create a group from the app

Open the White Noise mobile app and create a new group. Invite the assistant's pubkey.

### Discover the group ID

Send a message in the group, then check NanoClaw logs:

```bash
grep -i "whitenoise" logs/nanoclaw.log | tail -20
```

Or check the database:

```bash
sqlite3 store/messages.db "SELECT jid FROM chats WHERE channel = 'whitenoise' ORDER BY last_message_time DESC LIMIT 5;"
```

The JID format is `whitenoise:<mls-group-id-hex>`.

> **Important:** Use the **MLS group ID**, not the Nostr group ID. The Nostr group ID will give "Group not found" errors.

### Register the group

```bash
npx tsx setup/index.ts --step register -- \
  --jid "whitenoise:<mls-group-id>" \
  --name "White Noise Group" \
  --folder "whitenoise_group-name" \
  --trigger "@${TRIGGER_WORD}" \
  --channel whitenoise
```

## Phase 5: Verify & Troubleshooting

### Test

Send a message in the White Noise group. The assistant should respond.

### Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "Group not found" | Using the wrong group ID (Nostr vs MLS) | Use the MLS group ID, not the Nostr group ID |
| No messages after reboot | wnd's MLS database is encrypted with a key from the desktop keyring, which is wiped on reboot | Delete MLS dir: `rm -rf ~/.local/share/whitenoise-cli/release/mls/<PUBKEY>`, restart wnd, re-login, recreate groups from the app |
| Socket conflict crash loop | Two wnd processes running | `systemctl --user stop wnd`, kill any stray wnd processes, then `systemctl --user start wnd` |
| "No matching key package" on group invite | Stale key packages on relays after MLS reset | Full logout, delete MLS dir, restart, re-login, wait a few minutes for fresh key packages to propagate, then retry |
| Messages not arriving | wnd not running or socket path wrong | Check `systemctl --user status wnd` and verify WN_SOCKET_PATH |

## Removal

1. Remove `src/channels/whitenoise.ts`
2. Remove White Noise imports and instantiation from `src/index.ts`
3. Remove White Noise config exports from `src/config.ts`
4. Remove `WN_BINARY_PATH`, `WN_SOCKET_PATH`, `WN_ACCOUNT_PUBKEY` from `.env`
5. Rebuild: `npm run build`
6. Optionally stop wnd: `systemctl --user stop wnd && systemctl --user disable wnd`
