---
name: add-nostr-dm
description: "Add Nostr private direct messages (NIP-17) as a channel. End-to-end encrypted DMs with image support via signing daemon."
depends:
  - add-nostr-signer
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add Nostr DM Channel

This skill adds Nostr private direct messaging (NIP-17 gift-wrapped DMs) to NanoClaw. Your assistant can receive and reply to encrypted Nostr DMs, with support for images and an allowlist to control who can message it.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **NostrDMChannel** (`src/channels/nostr-dm.ts`) | Connects to Nostr relays, listens for NIP-17 gift-wrapped DMs, unwraps them via the signing daemon, and sends replies |
| **Relay connections** | Maintains persistent WebSocket connections to Nostr relays for receiving and sending messages |
| **Allowlist** | Controls which Nostr pubkeys can message the assistant |

## Prerequisites

The **add-nostr-signer** skill must be installed first. It provides the signing daemon that this channel uses to decrypt incoming DMs and encrypt outgoing replies.

## Phase 1: Pre-flight

### Check prerequisites

1. Check if `tools/nostr-signer/index.js` exists. If not, tell the user to run `/add-nostr-signer` first.
2. Check if `src/channels/nostr-dm.ts` already exists. If it does, skip to Phase 3.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: What is your Nostr public key (npub)?

The user's npub identifies who they are on Nostr. It starts with `npub1...`. They can find it in their Nostr client (Damus, Amethyst, Primal, etc.) under profile/settings.

## Phase 2: Apply Code Changes

### Install dependencies

```bash
npm install nostr-tools ws @types/ws
```

### Add Nostr DM channel file

Copy `src/channels/nostr-dm.ts` into the project.

### Update config.ts

Add these exports to `src/config.ts`:

```typescript
export const NOSTR_SIGNER_SOCKET =
  process.env.NOSTR_SIGNER_SOCKET ||
  `${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}/nostr-signer.sock`;

export const NOSTR_DM_RELAYS =
  process.env.NOSTR_DM_RELAYS ||
  envConfig.NOSTR_DM_RELAYS ||
  'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social';

export const NOSTR_DM_ALLOWLIST =
  process.env.NOSTR_DM_ALLOWLIST ||
  envConfig.NOSTR_DM_ALLOWLIST ||
  '';
```

Add `NOSTR_DM_RELAYS` and `NOSTR_DM_ALLOWLIST` to the `readEnvFile()` keys array.

### Update index.ts

Add Nostr DM channel initialization:

```typescript
import { NostrDMChannel } from './channels/nostr-dm.js';
import { NOSTR_DM_ALLOWLIST } from './config.js';

// In the channel setup section:
if (NOSTR_DM_ALLOWLIST) {
  const nostrDm = new NostrDMChannel({
    onMessage: handleInboundMessage,
    onChatMetadata: handleChatMetadata,
    registeredGroups: () => registeredGroups,
  });
  channels.push(nostrDm);
}
```

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Configure .env

Add to `.env`:

```
NOSTR_DM_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social
NOSTR_DM_ALLOWLIST=<hex-pubkey-1>,<hex-pubkey-2>
```

**Converting npub to hex pubkey:**
```bash
node -e "const {decode} = await import('nostr-tools/nip19'); console.log(decode('npub1...').data)"
```

Replace `npub1...` with the actual npub. The output is the hex pubkey to put in the allowlist.

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Register the user's Nostr pubkey

The JID format for Nostr DMs is `nostr:<hex-pubkey>`:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "nostr:<hex-pubkey>" \
  --name "Nostr DM" \
  --folder "nostr-<username>" \
  --trigger "@${TRIGGER_WORD}" \
  --channel nostr-dm \
  --no-trigger-required
```

Set `--no-trigger-required` since DMs are always directed at the assistant.

## Phase 5: Verify

### Send a test DM

Open your Nostr client and send a direct message to the assistant's npub (the pubkey from the signing daemon).

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i nostr
```

Look for: `Nostr DM channel connected` and `Subscribed to NIP-17 DMs`.

### Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| No messages arriving | Relay connection failed or allowlist blocking | Check relay URLs are reachable and sender's hex pubkey is in the allowlist |
| "Cannot connect to signing daemon" | Signing daemon not running | `systemctl --user start nostr-signer` |
| "Unwrap failed" | Message wasn't encrypted for this key | Verify both sides are using the same pubkey |
| DMs from self not showing | By design — outgoing DMs aren't echoed back | Normal behavior |

## Removal

1. Remove `src/channels/nostr-dm.ts`
2. Remove Nostr DM imports and instantiation from `src/index.ts`
3. Remove Nostr DM config exports from `src/config.ts`
4. Remove `NOSTR_DM_RELAYS`, `NOSTR_DM_ALLOWLIST` from `.env`
5. `npm uninstall nostr-tools ws @types/ws` (only if no other skills use them)
6. Rebuild: `npm run build`
