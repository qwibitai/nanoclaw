# Intent for src/config.ts modifications

## Changes Required

### 1. Add new imports for reading env values

Add `MATTERMOST_URL` and `MATTERMOST_BOT_TOKEN` to the `readEnvFile` call:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_TOKEN',  // existing
  'TELEGRAM_ONLY',        // existing
  'MATTERMOST_URL',       // ADD
  'MATTERMOST_BOT_TOKEN', // ADD
  'MATTERMOST_ONLY',      // ADD
]);
```

### 2. Add new exports at the end of the file

```typescript
// Mattermost configuration
export const MATTERMOST_URL =
  process.env.MATTERMOST_URL || envConfig.MATTERMOST_URL || '';
export const MATTERMOST_BOT_TOKEN =
  process.env.MATTERMOST_BOT_TOKEN || envConfig.MATTERMOST_BOT_TOKEN || '';
export const MATTERMOST_ONLY =
  (process.env.MATTERMOST_ONLY || envConfig.MATTERMOST_ONLY) === 'true';
```

## Invariants

- The existing WhatsApp, Telegram, Discord, Slack config must remain unchanged
- Environment variables are loaded from `.env` file in the project root
- The pattern follows the existing channel configuration (e.g., TELEGRAM_BOT_TOKEN)
