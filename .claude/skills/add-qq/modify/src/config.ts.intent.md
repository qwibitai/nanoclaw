# Intent: Add QQ Bot Configuration to config.ts

## What Changed

Added QQ Bot credentials configuration (App ID and Client Secret).

## Changes Required

### 1. Add QQ Bot to envConfig array

Update the `readEnvFile` call to include QQ Bot variables:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
  'HTTPS_PROXY',
  'QQBOT_APP_ID',
  'QQBOT_CLIENT_SECRET',
]);
```

### 2. Export QQ Bot configuration

Add after Telegram configuration:

```typescript
// Telegram configuration
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';

// QQ Bot configuration
export const QQBOT_APP_ID =
  process.env.QQBOT_APP_ID || envConfig.QQBOT_APP_ID || '';
export const QQBOT_CLIENT_SECRET =
  process.env.QQBOT_CLIENT_SECRET || envConfig.QQBOT_CLIENT_SECRET || '';

// Proxy — inject into process.env so fetch/grammy can pick it up
const httpsProxy = envConfig.HTTPS_PROXY;
if (httpsProxy && !process.env.HTTPS_PROXY) {
  process.env.HTTPS_PROXY = httpsProxy;
}
```

## Invariants

- QQ Bot credentials are optional (empty string if not provided)
- Reads from both `process.env` and `.env` file (process.env takes precedence)
- App ID is numeric but stored as string
- Client Secret is alphanumeric string
- No validation at config level (validation happens in channel initialization)

## Environment Variables

Add to `.env.example`:

```bash
# QQ Bot Configuration (optional)
# Get credentials from https://q.qq.com/qqbot/openclaw
QQBOT_APP_ID=
QQBOT_CLIENT_SECRET=
```

## Testing

After applying:

1. Build should succeed: `npm run build`
2. Config should export empty strings if not set
3. Config should read from .env if set
4. Config should prefer process.env over .env file
