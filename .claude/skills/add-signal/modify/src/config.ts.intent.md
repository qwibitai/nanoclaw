# Intent: src/config.ts modifications

## What changed
Added three new configuration exports for Signal channel support.

## Key sections
- **readEnvFile call**: Must include `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_PATH`, and `SIGNAL_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **SIGNAL_PHONE_NUMBER**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **SIGNAL_CLI_PATH**: Read from `process.env` first, then `envConfig` fallback, defaults to `'signal-cli'` (assumes it's in PATH)
- **SIGNAL_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation

## Invariants
- All existing config exports remain unchanged
- New Signal keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file (before TIMEZONE)
- No existing behavior is modified — Signal config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
