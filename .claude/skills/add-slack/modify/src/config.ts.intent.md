# Intent: src/config.ts modifications

## What changed

Added Slack configuration exports for Socket Mode channel support.

## Key sections

- **readEnvFile call**: Must include `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY`, and `SLACK_FILTER_BOT_MESSAGES` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **SLACK_BOT_TOKEN**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **SLACK_APP_TOKEN**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (required for Socket Mode)
- **SLACK_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation
- **SLACK_FILTER_BOT_MESSAGES**: Boolean flag from `process.env` or `envConfig`, defaults to `'true'`. When `true`, filters out messages from other bots to prevent bot loops.

## Invariants

- All existing config exports remain unchanged
- New Slack keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Slack config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep

- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
