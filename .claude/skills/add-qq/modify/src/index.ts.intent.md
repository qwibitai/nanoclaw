# Intent: Add QQ Bot Channel Support to index.ts

## What Changed

Added QQ Bot as a new channel alongside Telegram and WhatsApp.

## Changes Required

### 1. Import QQBotChannel

Add import at the top with other channel imports:

```typescript
import { QQBotChannel } from './channels/qqbot.js';
```

### 2. Import QQ Bot config

Add to config imports:

```typescript
import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TRIGGER_PATTERN,
  QQBOT_APP_ID,
  QQBOT_CLIENT_SECRET,
} from './config.js';
```

### 3. Initialize QQ Bot channel in main()

Add QQ Bot initialization after Telegram and before WhatsApp:

```typescript
async function main(): Promise<void> {
  // ... existing code ...

  // Create and connect channels
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    await telegram.connect();
  }

  // ADD THIS BLOCK:
  if (QQBOT_APP_ID && QQBOT_CLIENT_SECRET) {
    const qqbot = new QQBotChannel(QQBOT_APP_ID, QQBOT_CLIENT_SECRET, channelOpts);
    channels.push(qqbot);
    try {
      await qqbot.connect();
    } catch (err) {
      logger.warn({ err }, 'QQ Bot channel failed to connect, continuing without it');
    }
  }

  if (!TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  // ... rest of main() ...
}
```

## Invariants

- QQ Bot is optional (only connects if credentials are provided)
- QQ Bot runs alongside other channels (doesn't replace them)
- Connection failure is non-fatal (logs warning and continues)
- QQ Bot uses the same `channelOpts` as other channels
- Order: Telegram → QQ Bot → WhatsApp
- All channels are added to the `channels` array for routing

## Testing

After applying:

1. Build should succeed: `npm run build`
2. Service should start without QQ Bot if credentials not provided
3. Service should connect to QQ Bot if credentials are in .env
4. Check logs for: `QQ Bot channel connecting...` and `QQ Bot ready`
