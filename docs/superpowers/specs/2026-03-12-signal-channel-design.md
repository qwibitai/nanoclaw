# Signal Channel for NanoClaw

**Date:** 2026-03-12
**Status:** Draft
**Author:** Greg (Ice Point Labs)
**Target:** PR to upstream `qwibitai/nanoclaw`

## Summary

Add Signal as a messaging channel for NanoClaw, following the same self-registering channel pattern as WhatsApp, Telegram, Slack, and Discord. Uses the `signal-sdk` npm package (TypeScript wrapper around signal-cli with JSON-RPC). Linked device authentication via QR code. Primary use case: personal 1:1 "Note to Self" assistant with voice transcription support.

## Requirements

- Signal as a first-class NanoClaw channel
- Linked device authentication (QR code scan from Signal mobile app)
- "Note to Self" as the primary chat (1:1 with the user's own account)
- Voice message transcription via local whisper-cli
- Setup skill (`/add-signal`) following the same pattern as `/add-whatsapp`
- PR-ready for upstream contribution

## Non-Goals

- Group chat support (can be added later but not in initial scope)
- Standalone Signal account registration (linked device only)
- Signal Desktop integration (we are the secondary device)

## Technical Approach

### Library: `signal-sdk`

- **npm package:** `signal-sdk`
- **How it works:** Auto-downloads signal-cli binary at install time. Communicates via JSON-RPC subprocess. TypeScript-native.
- **Prerequisites:** Java 17+ on macOS (signal-cli is JVM-based). Linux uses native binary.
- **Auth:** Linked device via `npx signal-sdk connect "NanoClaw"` — displays QR in terminal, user scans from Signal app.
- **Messages:** Event-driven (`signal.on("message", ...)`) with full envelope data.
- **Sending:** `signal.sendMessage(recipient, text, options?)` — positional args: phone number, message text, optional options object

### Alternatives Considered

1. **signal-cli-rest-api (Docker sidecar):** Mature but requires a separate Docker container. Architectural mismatch — all other NanoClaw channels are in-process.
2. **Raw signal-cli subprocess:** More work for no benefit — signal-sdk already wraps this cleanly.

## Architecture

### JID Format

Signal uses E.164 phone numbers. To namespace and prevent collision with other channels, Signal JIDs are prefixed:

```
signal:+447700900000
```

The `ownsJid()` method checks for the `signal:` prefix. This is consistent with how other channels could be namespaced if needed.

For "Note to Self", the chat JID is the bot's own linked phone number: `signal:+<SIGNAL_PHONE_NUMBER>`.

### Channel Factory Registration

```typescript
// src/channels/signal.ts
import { registerChannel } from './registry.js';

registerChannel('signal', (opts) => {
  const configDir = path.join(STORE_DIR, 'signal');
  if (!fs.existsSync(configDir) || !process.env.SIGNAL_PHONE_NUMBER) {
    logger.warn('Signal: not configured. Run /add-signal to set up.');
    return null;
  }
  return new SignalChannel(opts);
});
```

Returns `null` when credentials are missing — graceful degradation, same as all other channels.

### SignalChannel Class

Implements the `Channel` interface:

```typescript
class SignalChannel implements Channel {
  name = 'signal';

  async connect(): Promise<void>
  // Instantiate SignalCli with phone number and store/signal/ data path
  // Call signal.connect()
  // Subscribe to "message" events

  async sendMessage(jid: string, text: string): Promise<void>
  // Strip "signal:" prefix, call signal.sendMessage(phone, text)

  isConnected(): boolean
  // Return internal connection state

  ownsJid(jid: string): boolean
  // return jid.startsWith('signal:')

  async disconnect(): Promise<void>
  // signal.gracefulShutdown()

  async setTyping?(jid: string, isTyping: boolean): Promise<void>
  // signal-sdk supports typing indicators
}
```

### Message Flow (Inbound)

```
Signal servers → signal-cli (JSON-RPC subprocess) → signal-sdk "message" event
  → SignalChannel.onMessageEvent()
    → Extract: sender phone, text, timestamp, attachments
    → Build NewMessage {
        id: unique,
        chat_jid: "signal:+<number>",
        sender: "signal:+<sender>",
        sender_name: contact name or phone number,
        content: text or "[Voice: <transcript>]",
        timestamp: ISO string,
        is_from_me: see "Note to Self Detection" below,
        is_bot_message: see "Note to Self Detection" below
      }
    → Call onMessage(chat_jid, message)
    → Call onChatMetadata(chat_jid, timestamp, "Note to Self", 'signal', false)
```

### Note to Self Detection

In "Note to Self", all messages have the same sender (the user's own number). Both the user's typed messages and the bot's replies originate from the same account. We cannot use `sender === bot's number` to detect bot messages because that would flag everything.

**Strategy:** signal-cli distinguishes between messages sent from the primary device and messages sent from linked devices. When the bot (linked device) sends a reply, signal-cli emits a `syncMessage` (a message synced from another device). When the user types on their phone, signal-cli receives a regular `dataMessage`.

Detection logic:
1. **Regular `dataMessage` from own number** → User typed on their phone → `is_from_me: false`, `is_bot_message: false`
2. **`syncMessage` with `sentMessage`** → Bot sent this (or user sent from another linked device) → `is_from_me: true`, `is_bot_message: true` (also check ASSISTANT_NAME prefix as fallback)
3. **Messages from other numbers** (future group support) → Standard sender detection

If signal-sdk does not expose the `syncMessage` vs `dataMessage` distinction clearly, fall back to **ASSISTANT_NAME prefix detection only**: any message starting with the assistant's name prefix is treated as a bot message, everything else is a user message. This is the same fallback WhatsApp uses.

```
```

### Message Flow (Outbound)

```
Container IPC → routeOutbound() → findChannel() via ownsJid("signal:...")
  → SignalChannel.sendMessage("signal:+447700900000", text)
    → signal.sendMessage("+447700900000", text)
```

### Voice Transcription

Current `src/transcription.ts` is coupled to WhatsApp (uses Baileys types for audio download). The existing private function `transcribeWithWhisperCpp(audioBuffer: Buffer)` handles Buffer→temp file→ffmpeg→whisper-cli. Refactor:

1. **Extract generic function:** `transcribeAudioFile(filePath: string): Promise<string>` — takes a local audio file path (any format ffmpeg can handle), converts to 16kHz WAV, runs whisper-cli, returns transcript text, cleans up temp files.

2. **WhatsApp adapter:** Downloads voice note via Baileys into a `Buffer`, writes Buffer to a temp file, calls `transcribeAudioFile(tempPath)`, deletes temp file. This replaces the current `transcribeWithWhisperCpp(buffer)` call with the same behavior, just split into download→file→transcribe.

3. **Signal adapter:** signal-sdk provides attachment file paths on disk. Pass the file path directly to `transcribeAudioFile(attachmentPath)`. No Buffer intermediary needed.

Both adapters live in their respective channel files (or a thin helper in transcription.ts). The shared `transcribeAudioFile()` is the only export from `transcription.ts`.

The refactor is backward-compatible — WhatsApp's behavior doesn't change, we just restructure the internals.

### Message Filtering

signal-cli emits events for delivery receipts, read receipts, typing notifications, and other protocol messages. The `"message"` event handler must filter these out and only process events that contain a `dataMessage` (or `syncMessage.sentMessage`) with actual text content. Receipt and typing events should be silently ignored.

### Reconnection Strategy

signal-sdk's `SignalCli` constructor accepts `maxRetries` and `retryDelay` options. We rely on signal-sdk's built-in reconnection for JSON-RPC subprocess restarts. At the channel layer:

- **On disconnect:** Set `connected = false`. Log a warning. signal-sdk handles subprocess restart internally.
- **Outgoing message queue:** Mirror WhatsApp's pattern — queue outbound messages when disconnected, flush on reconnect. This prevents lost bot replies during brief signal-cli restarts.
- **On permanent failure:** After signal-sdk exhausts retries, log an error. The channel remains registered but `isConnected()` returns false. The orchestrator skips it for routing.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIGNAL_PHONE_NUMBER` | Yes | Bot's phone number in E.164 format (e.g. `+447700900000`) |

Signal-cli stores its own credentials/keys in `store/signal/` (the data directory passed to `SignalCli` constructor). No additional secrets needed — the linked device pairing handles key exchange.

### Credential Storage

```
store/signal/
├── data/           # signal-cli internal state (keys, sessions, contacts)
└── attachments/    # Downloaded attachments (temporary)
```

This follows the same pattern as WhatsApp's `store/auth/`.

## Files to Create/Modify

### New Files

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/channels/signal.ts` | Channel implementation + factory registration | ~250 |
| `src/channels/signal.test.ts` | Unit tests | ~300 |
| `.claude/skills/add-signal/SKILL.md` | Setup skill (auth, registration, verify) | ~200 |
| `setup/signal-auth.ts` | Programmatic device linking step (see interface below) | ~100 |

### Modified Files

| File | Change |
|------|--------|
| `src/channels/index.ts` | Add `import './signal.js'` |
| `src/transcription.ts` | Extract `transcribeAudioFile()` as shared function |
| `package.json` | Add `signal-sdk` dependency |
| `.env.example` | Add `SIGNAL_PHONE_NUMBER` |

## Setup Skill: `/add-signal`

### Phase 1: Pre-flight

- Check Java 17+ installed (`java -version`)
- If missing: `brew install openjdk` (macOS) or guide for Linux
- Check if `signal-sdk` is in dependencies
- Check if already linked: look for `store/signal/data/` contents

### `setup/signal-auth.ts` Interface

Called by `npx tsx setup/index.ts --step signal-auth`. Wraps signal-sdk's `deviceLink()` method:

1. Instantiate `SignalCli` with data path `store/signal/`
2. Call `deviceLink({ deviceName: "NanoClaw" })` — displays QR in terminal
3. Wait for scan (90s timeout)
4. On success: print `SIGNAL_AUTH_OK=true` status block, credentials are auto-saved to `store/signal/`
5. On failure/timeout: print `SIGNAL_AUTH_OK=false` with error details

### Phase 2: Code Installation

- Merge from `signal` skill branch (or install directly if first contribution)
- `npm install && npm run build`

### Phase 3: Authentication (Device Linking)

- Run device linking: `npx signal-sdk connect "NanoClaw"` or programmatic via `setup/signal-auth.ts`
- Display QR code in terminal
- User scans from Signal mobile: Settings > Linked Devices > Link New Device
- Credentials stored automatically in `store/signal/`
- Ask user for their phone number, write `SIGNAL_PHONE_NUMBER` to `.env`

### Phase 4: Registration

- Default to "Note to Self" (JID = `signal:+<SIGNAL_PHONE_NUMBER>`)
- Register via: `npx tsx setup/index.ts --step register --jid "signal:+<number>" --name "Signal Main" --trigger "@Andy" --folder signal_main --channel signal --is-main --no-trigger-required`

### Phase 5: Verify

- `npm run build`
- Restart service
- User sends test message in Signal "Note to Self"
- Check logs: `tail -f logs/nanoclaw.log | grep -i signal`

## Testing Strategy

### Unit Tests (`signal.test.ts`)

- Factory returns `null` when credentials missing
- Factory returns `SignalChannel` when credentials present
- `ownsJid()` returns true for `signal:` prefixed JIDs, false otherwise
- Message event correctly builds `NewMessage` object
- `sendMessage()` strips prefix and calls signal-sdk
- Bot message detection (ASSISTANT_NAME prefix, is_from_me)
- Voice attachment triggers transcription flow

### Integration Testing

- Manual: send message in Signal, verify agent responds
- Manual: send voice note, verify transcript appears in agent prompt

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `signal-sdk` is a newer package | Pin version, test thoroughly. Fallback: wrap signal-cli directly (Approach C) |
| Java 17+ requirement on macOS | Setup skill handles installation. Clear error message if missing. |
| Signal rate limiting | signal-sdk has built-in rate limiting and retry logic |
| signal-cli binary size (~50MB) | Auto-downloaded at `npm install`, acceptable for a server-side tool |
| Linked device can be unlinked from phone | Document in troubleshooting. Re-run `/add-signal` to re-link. |

## Future Extensions (Not In Scope)

- Group chat support (listen to group messages, send to groups)
- Image/media attachment support (beyond voice)
- Contact name resolution from Signal profile
- Multiple Signal accounts
