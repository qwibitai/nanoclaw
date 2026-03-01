# Intent: src/index.ts modifications

## What changed
Added conditional Feishu channel initialization in `main()` alongside existing WhatsApp, Telegram, and Slack channel setup.

## Key sections

### Imports
- Added: `FeishuChannel` from `./channels/feishu.js`
- Added: `FEISHU_ONLY` from `./config.js`
- The `readEnvFile` import is already present — no new import needed for that

### Module-level state
- Added: `let feishu: FeishuChannel | undefined` alongside existing `let whatsapp`, `let telegram`, `let slack`
- All other state unchanged

### main() — Feishu initialization
Read `FEISHU_APP_ID` and `FEISHU_APP_SECRET` via `readEnvFile()` at the top of main (alongside other secrets reads). Then conditionally create and connect the Feishu channel:

```typescript
const { FEISHU_APP_ID, FEISHU_APP_SECRET } = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);

if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  feishu = new FeishuChannel(FEISHU_APP_ID, FEISHU_APP_SECRET, channelOpts);
  channels.push(feishu);
  await feishu.connect();
}
```

### main() — FEISHU_ONLY guard
If `FEISHU_ONLY` is true, skip WhatsApp creation (same pattern as `TELEGRAM_ONLY` / `SLACK_ONLY`):

```typescript
if (!FEISHU_ONLY && !TELEGRAM_ONLY && !SLACK_ONLY) {
  // existing WhatsApp initialization
}
```

### Shutdown handler
The shutdown handler already iterates the `channels` array — no explicit Feishu disconnect is needed if `feishu` is pushed to `channels`.

## Invariants
- All existing message processing logic is completely unchanged
- WhatsApp, Telegram, and Slack channel setup is unchanged
- The `channelOpts` object (onMessage, onChatMetadata, registeredGroups) is unchanged — passed as-is to FeishuChannel
- State management, IPC watcher, and task scheduler setup are unchanged
- Feishu initialization follows the same conditional pattern as Telegram and Slack

## Must-keep
- All existing channel guards (`TELEGRAM_ONLY`, `SLACK_ONLY`) remain in place — the new guard is additive
- The `channels` array pattern for multi-channel routing
- The `readEnvFile` call for secrets — never load credentials from `process.env` directly
- All existing error handling and reconnection logic
