# Intent: src/config.ts modifications

## What changed
Added three new configuration exports for Signal channel support.

## Key sections
- **readEnvFile call**: Must include `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_URL`, and `SIGNAL_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **SIGNAL_PHONE_NUMBER**: The registered phone number for signal-cli (e.g., `+1234567890`). Empty string disables channel.
- **SIGNAL_CLI_URL**: Host and port of the signal-cli daemon TCP endpoint. Defaults to `localhost:7583`.
- **SIGNAL_ONLY**: Boolean flag. When `true`, disables WhatsApp channel creation.

## Invariants
- All existing config exports remain unchanged
- New Signal keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Signal config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
