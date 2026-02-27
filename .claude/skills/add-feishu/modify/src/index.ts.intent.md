# Intent: src/index.ts modifications for Feishu support

## What Changed

Added Feishu (Lark) channel support alongside existing WhatsApp channel:

1. **Imports**: Added `FeishuChannel` import and `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY` config imports
2. **Channel initialization**: Replaced single WhatsApp initialization with conditional logic:
   - If `FEISHU_ONLY=true`: Use only Feishu channel
   - Otherwise: Use WhatsApp + optional Feishu if credentials configured

## Key Sections

### Import Changes
```typescript
import { FeishuChannel } from './channels/feishu.js';
import {
  // ... existing imports
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_ONLY,
  // ...
} from './config.js';
```

### Channel Initialization Logic
```typescript
// Create and connect channels
// If FEISHU_ONLY is set, skip WhatsApp and only use Feishu
if (FEISHU_ONLY && FEISHU_APP_ID && FEISHU_APP_SECRET) {
  const feishu = new FeishuChannel({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  });
  channels.push(feishu);
  await feishu.connect();
} else {
  // Use WhatsApp by default
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();

  // Add Feishu channel if configured ( alongside WhatsApp)
  if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
    const feishu = new FeishuChannel({
      appId: FEISHU_APP_ID,
      appSecret: FEISHU_APP_SECRET,
      onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
      onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => registeredGroups,
    });
    channels.push(feishu);
    await feishu.connect();
  }
}
```

## Invariants (Must NOT Change)

1. **WhatsApp is default**: When no `FEISHU_ONLY` flag is set and no Feishu credentials provided, WhatsApp must still work as before
2. **Channel callbacks**: The `channelOpts` object structure must remain consistent for all channels
3. **Multi-channel routing**: `findChannel()` function must continue to work with mixed channel types
4. **Graceful degradation**: If Feishu connection fails, other channels should continue working

## Must Keep

- `let whatsapp: WhatsAppChannel;` declaration (for WhatsApp users)
- `const channels: Channel[] = [];` array initialization
- `channelOpts` callback definitions for message handling
- Existing shutdown logic that iterates over all channels
