# Intent: src/config.ts modifications

## What changed
Added MemOS configuration exports: API URL, user ID, and container network name. These are read from `.env` via the existing `readEnvFile()` mechanism.

## Key sections

### readEnvFile() call
- Added: `CONTAINER_NETWORK`, `MEMOS_API_URL`, `MEMOS_USER_ID` to the key array

### New exports
- `CONTAINER_NETWORK` — Docker network name for joining containers to the MemOS network
- `MEMOS_API_URL` — MemOS API endpoint; empty string disables MemOS entirely
- `MEMOS_USER_ID` — User namespace in MemOS; defaults to `ASSISTANT_NAME.toLowerCase()`

## Invariants
- All existing exports are unchanged
- `readEnvFile` still reads all original keys
- No new imports added
- Fallback chain preserved: `process.env` → `.env` file → default

## Must-keep
- `CREDENTIAL_PROXY_PORT` export
- All existing path constants (`STORE_DIR`, `GROUPS_DIR`, etc.)
- `TRIGGER_PATTERN` and `TIMEZONE` exports
- The `escapeRegex` helper function
