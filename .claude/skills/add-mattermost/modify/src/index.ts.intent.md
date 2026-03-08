# Intent for src/index.ts modifications

## Changes Required

### 1. Add new imports

Add these imports alongside the existing channel imports:

```typescript
import { MattermostChannel } from './channels/mattermost.js';
// Keep existing imports:
import { WhatsAppChannel } from './channels/whatsapp.js';
// If Telegram/Slack/Discord are already added, keep their imports
```

### 2. Add config imports

```typescript
import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  MATTERMOST_BOT_TOKEN,    // ADD
  MATTERMOST_ONLY,          // ADD
  MATTERMOST_URL,          // ADD
  TRIGGER_PATTERN,
} from './config.js';
```

### 3. Create and connect Mattermost channel

In the `main()` function, after channel callbacks setup and before WhatsApp:

```typescript
// Create and connect channels
if (MATTERMOST_BOT_TOKEN && MATTERMOST_URL) {
  const mattermost = new MattermostChannel(MATTERMOST_URL, MATTERMOST_BOT_TOKEN, channelOpts);
  channels.push(mattermost);
  await mattermost.connect();
}

if (!MATTERMOST_ONLY) {
  // Existing WhatsApp connection
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}
```

### 4. Update IPC sync function

In `startIpcWatcher` call, update the syncGroupMetadata to include Mattermost:

```typescript
startIpcWatcher({
  // ... existing options
  syncGroupMetadata: (force) => {
    const promises = [];
    if (whatsapp) promises.push(whatsapp.syncGroupMetadata?.(force) ?? Promise.resolve());
    // ADD: if (mattermost) promises.push(mattermost.syncGroupMetadata?.(force) ?? Promise.resolve());
    return Promise.all(promises);
  },
  // ...
});
```

## Invariants

- The `Channel` interface must be preserved - MattermostChannel implements it
- The `channels` array is used for routing via `findChannel()`
- Existing WhatsApp, Telegram, Discord, Slack channels continue to work
- The JID format for Mattermost is `mm:<channel-id>`
- Message format follows the existing `NewMessage` type
- The trigger pattern (`@AssistantName`) is checked for non-main groups

## Testing

After modifications, run:
```bash
npm test
npm run build
```

All existing tests must pass, and new Mattermost tests should be added to `src/routing.test.ts`.
