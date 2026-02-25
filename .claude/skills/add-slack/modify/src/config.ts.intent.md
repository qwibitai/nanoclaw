# Intent: src/config.ts modifications

## What changed
Added SLACK_ONLY configuration export for Slack channel support.

## Key sections
- **readEnvFile call**: Must include `SLACK_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **SLACK_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation
- **Note**: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are NOT read here. They are read directly by SlackChannel via `readEnvFile()` in `slack.ts` to keep secrets off the config module entirely (same pattern as ANTHROPIC_API_KEY in container-runner.ts).

## Invariants
- All existing config exports remain unchanged
- New Slack key is added to the `readEnvFile` call alongside existing keys
- New export is appended at the end of the file
- No existing behavior is modified — Slack config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
