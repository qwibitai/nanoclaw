# Channel Development Guide

This guide explains how to build a new channel for NanoClaw. A channel connects an external messaging platform (WhatsApp, Telegram, Slack, etc.) to the NanoClaw orchestrator.

## Architecture Overview

Channels follow a **self-registration** pattern:

1. A channel module calls `registerChannel()` with a factory function at import time.
2. `src/channels/index.ts` barrel-imports all channel modules, triggering registration.
3. At startup, the orchestrator (`src/index.ts`) iterates registered factories, calls each one, and connects the returned `Channel` objects.
4. Factories return `null` when credentials are missing, so unconfigured channels are silently skipped.

## The Channel Interface

Defined in `src/types.ts`:

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

### Required Members

| Member | Purpose |
|--------|---------|
| `name` | Unique identifier (e.g. `"telegram"`, `"slack"`). Used in logs and routing. |
| `connect()` | Authenticate and establish a persistent connection to the platform. Called once at startup. |
| `sendMessage(jid, text)` | Send an outbound message. `jid` is a channel-specific chat identifier. |
| `isConnected()` | Return `true` if the channel is ready to send/receive messages. Used by the router to skip disconnected channels. |
| `ownsJid(jid)` | Return `true` if this channel is responsible for the given JID. The router calls this to dispatch outbound messages to the correct channel. Typically implemented as a prefix or suffix check (e.g. `jid.startsWith("tg:")`). |
| `disconnect()` | Tear down the connection gracefully. |

### Optional Members

| Member | Purpose |
|--------|---------|
| `setTyping(jid, isTyping)` | Show/hide a typing indicator. Implement if the platform supports it. |
| `syncGroups(force)` | Fetch group/chat names from the platform and report them via `onChatMetadata`. |

## Callbacks

The factory receives a `ChannelOpts` object (defined in `src/channels/registry.ts`):

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

### `onMessage(chatJid, message)`

Call this when your channel receives an inbound message. The `NewMessage` shape (from `src/types.ts`):

```typescript
interface NewMessage {
  id: string;           // Platform-specific message ID
  chat_jid: string;     // Chat identifier (must match your ownsJid pattern)
  sender: string;       // Platform user ID
  sender_name: string;  // Display name
  content: string;      // Message text
  timestamp: string;    // ISO 8601 timestamp
  is_from_me?: boolean;
  is_bot_message?: boolean;
}
```

### `onChatMetadata(chatJid, timestamp, name?, channel?, isGroup?)`

Call this when you discover chat metadata (name, type). Some channels report this inline with messages; others batch-sync via `syncGroups()`.

### `registeredGroups()`

Returns the current set of registered groups. Use this to filter events or look up group configuration.

## Registration

Defined in `src/channels/registry.ts`:

```typescript
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

export function registerChannel(name: string, factory: ChannelFactory): void;
```

Your channel module calls `registerChannel()` at the **top level** (not inside a function), so registration happens at import time. Return `null` from the factory if required credentials are missing.

After creating your module, add an import to `src/channels/index.ts`:

```typescript
// src/channels/index.ts
import '../channels/my-channel.js';  // triggers registerChannel()
```

## JID Convention

Each channel uses a unique JID format so `ownsJid()` can route correctly:

- WhatsApp: `12345@g.us`, `12345@s.whatsapp.net`
- Telegram: `tg:12345`
- Slack: `slack:C12345`
- Discord: `discord:12345`

Pick a prefix like `mychannel:` and use it consistently. The JID is how the orchestrator identifies chats across the system — it's stored in the database, used in scheduled tasks, and passed back to `sendMessage()`.

## Minimal Channel Example

```typescript
// src/channels/my-channel.ts
import { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

function createMyChannel(opts: ChannelOpts): Channel | null {
  const apiKey = process.env.MY_CHANNEL_API_KEY;
  if (!apiKey) return null; // credentials missing — skip

  let connected = false;
  let client: any; // your platform SDK client

  return {
    name: 'my-channel',

    async connect() {
      client = createPlatformClient(apiKey); // hypothetical SDK

      client.on('message', (event: any) => {
        const msg: NewMessage = {
          id: event.id,
          chat_jid: `mychannel:${event.chatId}`,
          sender: event.userId,
          sender_name: event.userName,
          content: event.text,
          timestamp: new Date(event.ts).toISOString(),
        };
        opts.onMessage(msg.chat_jid, msg);
        opts.onChatMetadata(msg.chat_jid, msg.timestamp, event.chatName, 'my-channel', true);
      });

      await client.connect();
      connected = true;
    },

    async sendMessage(jid: string, text: string) {
      const chatId = jid.replace('mychannel:', '');
      await client.send(chatId, text);
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return jid.startsWith('mychannel:');
    },

    async disconnect() {
      await client.disconnect();
      connected = false;
    },
  };
}

// Self-register at import time
registerChannel('my-channel', createMyChannel);
```

## Testing

### Unit Testing the Registry

The registry itself is tested in `src/channels/registry.test.ts`. It demonstrates the core pattern: register a factory, retrieve it, verify names.

### Testing Your Channel

For unit tests, mock the platform SDK and verify your channel calls `onMessage` and `onChatMetadata` correctly:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('my-channel', () => {
  it('calls onMessage when platform delivers a message', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const opts = {
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
    };

    // Import your factory and create the channel with mock opts
    const channel = createMyChannel(opts);
    expect(channel).not.toBeNull();

    // Simulate a platform event and verify the callback
    // (depends on your SDK mock setup)
    expect(onMessage).toHaveBeenCalledWith(
      'mychannel:123',
      expect.objectContaining({ content: 'hello' }),
    );
  });

  it('returns null when credentials are missing', () => {
    delete process.env.MY_CHANNEL_API_KEY;
    const channel = createMyChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeNull();
  });

  it('ownsJid matches the channel prefix', () => {
    process.env.MY_CHANNEL_API_KEY = 'test-key';
    const channel = createMyChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel!.ownsJid('mychannel:123')).toBe(true);
    expect(channel!.ownsJid('slack:456')).toBe(false);
  });
});
```

For integration-level patterns, see `src/remote-control.test.ts` (mocking external processes) and `src/routing.test.ts` (testing JID ownership and message routing).

## Checklist

Before submitting your channel:

- [ ] Factory returns `null` when credentials are missing
- [ ] `ownsJid()` uses a unique prefix/pattern that won't collide with other channels
- [ ] `onMessage()` is called with a well-formed `NewMessage` for every inbound message
- [ ] `onChatMetadata()` is called so the orchestrator can discover chat names
- [ ] `isConnected()` accurately reflects connection state
- [ ] Import added to `src/channels/index.ts`
- [ ] Environment variables documented in `.env.example` (if applicable)
- [ ] Tests cover: credential-missing path, JID ownership, message callback
