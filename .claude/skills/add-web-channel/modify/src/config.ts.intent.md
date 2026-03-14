# Modify `src/config.ts`

## What this change adds

1. Adds web channel keys to `readEnvFile(...)`:
- `WEB_CHANNEL_ENABLED`
- `WEB_CHANNEL_REDIS_URL`
- `WEB_CHANNEL_SECRET`

2. Adds web channel config exports:
- `WEB_CHANNEL_ENABLED` (boolean)
- `WEB_CHANNEL_REDIS_URL` (string)

## Invariant

Follow the existing config parsing pattern (`parseBoolean`, fallback to `.env` values).  
Do not expose `WEB_CHANNEL_SECRET` as a parsed export for runtime channel logic.
