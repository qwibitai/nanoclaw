# Intent: src/config.ts modifications

## What changed
Added six new configuration exports for DingTalk channel support.

## Key sections
- **readEnvFile call**: Must include all six DingTalk keys in the array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **DINGTALK_CLIENT_ID**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **DINGTALK_CLIENT_SECRET**: Same pattern as CLIENT_ID; both must be set for the channel to activate
- **DINGTALK_ROBOT_CODE**: Optional; only needed when the DingTalk app has multiple robots
- **DINGTALK_ALLOWED_USERS**: Comma-separated StaffIds, parsed to array; `*` allows all; empty array denies all
- **DINGTALK_ALLOWED_GROUPS**: Comma-separated conversationIds (with or without `dd:` prefix), parsed to array; `*` allows all with auto-registration
- **DINGTALK_ONLY**: Boolean flag; when `true` disables WhatsApp channel creation

## Invariants
- All existing config exports remain unchanged
- New DingTalk keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file under a `// DingTalk Channel Configuration` comment
- No existing behavior is modified — DingTalk config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
