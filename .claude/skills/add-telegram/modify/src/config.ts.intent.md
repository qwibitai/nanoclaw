# Intent: src/config.ts modifications

## What changed
Added two new configuration exports for Telegram channel support.

## Key sections
- **readEnvFile call**: Must include `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **TELEGRAM_BOT_TOKEN**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **TELEGRAM_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation

## Invariants
- All existing config exports remain unchanged
- New Telegram keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Telegram config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
