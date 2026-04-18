# Intent: src/config.ts modifications

## What changed
Added one new configuration export for WeChat channel support.

## Key sections
- **readEnvFile call**: Must include `WEIXIN_ENABLED` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **WEIXIN_ENABLED**: Boolean flag from `process.env` or `envConfig`, when `true` enables WeChat channel creation

## Invariants
- All existing config exports remain unchanged
- New WeChat key is added to the `readEnvFile` call alongside existing keys
- New export is appended at the end of the file (before proxy section)
- No existing behavior is modified — WeChat config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `TELEGRAM_ONLY`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- The proxy injection logic at the end
