---
name: add-channel
description: Add or switch messaging channels in NanoClaw. Choose from WhatsApp (default), Discord, Telegram, Gmail, or X (Twitter). Supports single channel or multi-channel setups. Use when the user wants to add a new channel, switch transports, or set up multi-channel messaging. Triggers on "add channel", "switch channel", "discord", "telegram", "gmail", "twitter", "messaging", "transport".
disable-model-invocation: true
---

# Add Channel — Transport Megaskill

NanoClaw supports multiple messaging transports. This skill helps you add, replace, or configure any of them.

## Step 1: Ask What They Want

**If the user hasn't specified, ask:**

"Which messaging channel(s) would you like to use?

1. **Keep WhatsApp** (already configured, no changes needed)
2. **Add Discord** (as primary or alongside WhatsApp)
3. **Add Telegram** (via `/add-telegram` skill)
4. **Add Gmail** (via `/add-gmail` skill)
5. **Add X/Twitter** (via `/x-integration` skill)
6. **Multiple channels** (run multiple transports simultaneously)

Note: WhatsApp is currently the default transport. You can keep it, replace it, or add other channels alongside it."

## Available Transports

| Transport | Status | Use Case | Implementation |
|-----------|--------|----------|----------------|
| **WhatsApp** | ✅ Default (already in codebase) | Personal messaging, existing setup | Already configured in `src/channels/whatsapp.ts` |
| **Discord** | 📝 Add via this skill | Discord communities, bot API | See **Discord** section below |
| **Telegram** | 📝 Add via `/add-telegram` | Telegram groups, bot API | Run `/add-telegram` skill |
| **Telegram Swarm** | 📝 Add via `/add-telegram-swarm` | Multi-bot agent teams | Run `/add-telegram-swarm` skill |
| **Gmail** | 📝 Add via `/add-gmail` | Email channel, async responses | Run `/add-gmail` skill |
| **X (Twitter)** | 📝 Add via `/x-integration` | Twitter DMs, tweets | Run `/x-integration` skill |

## Architecture: Channel Abstraction

**Important:** NanoClaw uses a modular `Channel` interface in `src/types.ts`:

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

All channel implementations go in `src/channels/`:
- ✅ `src/channels/whatsapp.ts` - Already exists
- 📝 `src/channels/discord.ts` - Add if user wants Discord
- 📝 `src/channels/telegram.ts` - Created by `/add-telegram`

**The router (`src/router.ts`) handles multi-channel message routing** - it automatically finds which channel owns a given JID and routes messages accordingly.

---

## Option 1: Keep WhatsApp (No Changes)

WhatsApp is already configured and working. No action needed!

**Current setup:**
- ✅ Client: `src/channels/whatsapp.ts` (implements `Channel`)
- ✅ Auth: `src/whatsapp-auth.ts`
- ✅ Integration: `src/index.ts` initializes `WhatsAppChannel`
- ✅ Dependencies: `@whiskeysockets/baileys`, `qrcode-terminal`

**To verify it's working:**
```bash
npm run auth  # Should show QR code
npm run dev   # Should connect to WhatsApp
```

---

## Option 2: Add Discord

Add Discord **alongside** WhatsApp (multi-channel) or **replace** WhatsApp entirely.

### Step 1: Ask User's Preference

"Do you want to:
1. **Add Discord alongside WhatsApp** (run both channels simultaneously)
2. **Replace WhatsApp with Discord** (remove WhatsApp, use only Discord)"

### Step 2: Prerequisites

User needs a Discord bot:

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Go to "Bot" section → Reset Token → Copy token
4. Enable "Message Content Intent" under Privileged Gateway Intents
5. Generate OAuth2 URL (Scopes: `bot`, Permissions: Send Messages, Read Messages, View Channels)
6. Invite bot to Discord server

**Save the bot token** - they'll need it in `.env`.

### Step 3A: Add Discord Alongside WhatsApp (Multi-Channel)

This keeps both WhatsApp and Discord running.

#### 3A.1: Add Discord dependency

Edit `package.json` → add to `dependencies`:
```json
"discord.js": "^14.18.0"
```

Run:
```bash
npm install
```

#### 3A.2: Create Discord channel module

Create `src/channels/discord.ts` implementing the `Channel` interface:

**Required structure:**
```typescript
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  private client!: Client;
  private connected = false;

  constructor(private opts: DiscordChannelOpts) {}

  async connect(): Promise<void> {
    // Initialize Discord client with intents
    // Listen to Events.MessageCreate
    // Call opts.onMessage() and opts.onChatMetadata() callbacks
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Fetch channel, send message (handle 2000 char limit)
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Discord JIDs are namespaced as "discord:<numericChannelId>"
    return /^discord:\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Optional: Send typing indicator
  }
}
```

**Key implementation details:**
- Client intents: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`
- Message normalization: `{ channelId, content, authorName, messageId, isBot, timestamp }`
- 2000 char limit: Split long messages at newlines
- JID format: Discord uses numeric channel IDs (e.g., `"1234567890"`)

See WhatsAppChannel (`src/channels/whatsapp.ts`) as reference implementation.

#### 3A.3: Create Discord auth script

Create `src/discord-auth.ts`:

```typescript
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN not set');
  process.exit(1);
}

const res = await fetch('https://discord.com/api/v10/users/@me', {
  headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
});

if (res.ok) {
  const bot = await res.json();
  console.log(`✅ Authenticated as ${bot.username} (${bot.id})`);
} else {
  console.error(`❌ Failed: HTTP ${res.status}`);
  process.exit(1);
}
```

Update `package.json` scripts:
```json
"auth:discord": "tsx --env-file=.env src/discord-auth.ts"
```

#### 3A.4: Update main application for multi-channel

Edit `src/index.ts`:

**Add Discord import:**
```typescript
import { DiscordChannel } from './channels/discord.js';
import { DISCORD_BOT_TOKEN } from './config.js'; // Add to config.ts
```

**Initialize both channels:**
```typescript
const channels: Channel[] = [];

// WhatsApp channel (existing)
const whatsapp = new WhatsAppChannel({
  onMessage: (chatJid, msg) => storeMessage(msg),
  onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
  registeredGroups: () => registeredGroups,
});
channels.push(whatsapp);

// Discord channel (new)
if (DISCORD_BOT_TOKEN) {
  const discord = new DiscordChannel({
    token: DISCORD_BOT_TOKEN,
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
  });
  channels.push(discord);
}
```

**Connect all channels:**
```typescript
await whatsapp.connect();
if (discord) await discord.connect();
```

**Update message sending to use router:**
```typescript
import { routeOutbound } from './router.js';

// Instead of: await whatsapp.sendMessage(jid, text);
// Use: await routeOutbound(channels, jid, text);
```

The router automatically determines which channel owns each JID and routes accordingly.

#### 3A.5: Update config

Edit `src/config.ts`:

```typescript
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
```

Add to `.env`:
```
DISCORD_BOT_TOKEN=your_bot_token_here
```

#### 3A.6: Test multi-channel setup

```bash
npm run auth           # Test WhatsApp (QR code)
npm run auth:discord   # Test Discord (bot username)
npm run dev            # Both channels should connect
```

Messages from WhatsApp chats go through WhatsAppChannel, messages from Discord channels go through DiscordChannel.

### Step 3B: Replace WhatsApp with Discord (Single Channel)

This removes WhatsApp entirely and uses only Discord.

Follow steps 3A.1 and 3A.2 to create Discord channel module, then:

#### 3B.1: Remove WhatsApp dependencies

Edit `package.json` - remove from `dependencies`:
```json
"@whiskeysockets/baileys": "...",
"qrcode-terminal": "..."
```

Remove from `devDependencies`:
```json
"@types/qrcode-terminal": "..."
```

#### 3B.2: Update main application

Edit `src/index.ts`:

**Remove WhatsApp import:**
```typescript
// Delete: import { WhatsAppChannel } from './channels/whatsapp.js';
```

**Add Discord import:**
```typescript
import { DiscordChannel } from './channels/discord.js';
import { DISCORD_BOT_TOKEN } from './config.js';
```

**Initialize only Discord:**
```typescript
const discord = new DiscordChannel({
  token: DISCORD_BOT_TOKEN,
  onMessage: (chatJid, msg) => storeMessage(msg),
  onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
});

await discord.connect();
```

**Update message sending:**
```typescript
// Replace: await whatsapp.sendMessage(jid, text);
// With: await discord.sendMessage(jid, text);
```

#### 3B.3: Delete WhatsApp files

```bash
rm src/channels/whatsapp.ts
rm src/channels/whatsapp.test.ts
rm src/whatsapp-auth.ts
```

#### 3B.4: Update config

Edit `src/config.ts`:

```typescript
// Remove: export const ASSISTANT_HAS_OWN_NUMBER = ...;
// Add:
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
```

Update `.env`:
```
DISCORD_BOT_TOKEN=your_bot_token_here
```

#### 3B.5: Update package.json scripts

```json
"auth": "tsx --env-file=.env src/discord-auth.ts"
```

#### 3B.6: Install and test

```bash
npm install            # Remove WhatsApp deps, add Discord
npm run auth           # Test Discord bot token
npm run dev            # Should connect to Discord only
```

### Step 4: Update Documentation

After adding Discord (with or without WhatsApp), update:

- `CLAUDE.md` - Mention Discord in "Quick Context"
- `README.md` - Update "What It Supports" and architecture diagram
- `groups/main/CLAUDE.md` - Update JID examples (Discord uses numeric channel IDs)

---

## Option 3: Add Telegram

Use the `/add-telegram` skill - it handles Telegram bot setup.

**What it does:**
- Creates `src/channels/telegram.ts` implementing `Channel`
- Adds Telegram bot authentication
- Supports control-only mode (trigger actions) or full channel mode
- Can run alongside WhatsApp and/or Discord

---

## Option 4: Add Gmail

Use the `/add-gmail` skill - it sets up Gmail as a channel.

**Modes:**
- **Tool mode** - Agent can read/send emails when triggered from other channels
- **Channel mode** - Emails can trigger the agent and receive responses

---

## Option 5: Add X (Twitter)

Use the `/x-integration` skill - adds Twitter DM and tweet capabilities via browser automation.

---

## Option 6: Multiple Channels Simultaneously

To run multiple channels at once (e.g., WhatsApp + Discord + Telegram):

1. Follow the "Add alongside" instructions for each channel
2. Each channel implements the `Channel` interface
3. Add all channels to the `channels` array in `src/index.ts`
4. Use `routeOutbound(channels, jid, text)` for message sending
5. The router automatically determines which channel owns each JID

**Example multi-channel setup:**
```typescript
const channels: Channel[] = [
  new WhatsAppChannel({...}),
  new DiscordChannel({...}),
  new TelegramChannel({...}),
];

for (const channel of channels) {
  await channel.connect();
}
```

Messages are routed based on JID format:
- `@g.us` or `@s.whatsapp.net` → WhatsAppChannel
- Numeric IDs like `"1234567890"` → DiscordChannel
- `chat:123456` → TelegramChannel

---

## Troubleshooting

**Channel not connecting:**
- Verify token/credentials with auth script (`npm run auth`, `npm run auth:discord`, etc.)
- Check bot permissions in platform settings
- Review logs: `LOG_LEVEL=debug npm run dev`

**Messages not routing:**
- Verify channel implements `ownsJid()` correctly
- Check router logs to see which channel is selected
- Ensure JID format matches channel expectations

**Type errors:**
- Make sure all channels implement the `Channel` interface
- Check callback signatures match `OnInboundMessage` and `OnChatMetadata`

**Multi-channel conflicts:**
- Each channel should recognize its own JID format via `ownsJid()`
- Channels should not overlap in JID ownership

---

## Summary

| Want to... | Do this |
|------------|---------|
| Keep using WhatsApp | Nothing - it's already configured |
| Add Discord alongside WhatsApp | Follow "Add Discord Alongside" (multi-channel) |
| Switch from WhatsApp to Discord | Follow "Replace WhatsApp with Discord" (single channel) |
| Add Telegram | Run `/add-telegram` skill |
| Add Gmail | Run `/add-gmail` skill |
| Add X/Twitter | Run `/x-integration` skill |
| Run multiple channels | Follow multi-channel pattern for each channel |

All channels use the same core architecture - only the message I/O layer changes. The `Channel` interface and router handle the rest.
