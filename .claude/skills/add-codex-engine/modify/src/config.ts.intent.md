# Intent: src/config.ts modifications

## What changed
Added engine selection and Codex working directory configuration.

## Key sections

### readEnvFile call
Must include `'AI_ENGINE'` and `'CODEX_WORKING_DIR'` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.

### AI_ENGINE
String config: `'claude'` (default) or `'codex'`. Read from `process.env` or `envConfig`, defaults to `'claude'`.

### CODEX_WORKING_DIR
String config: root path where Codex group working directories live. Each group gets a subdirectory. Empty string default (required only when `AI_ENGINE=codex`).

### Security note
`OPENAI_API_KEY` is NOT read here. It is read directly by the Codex engine via `readEnvFile()` in `engines/codex.ts` to keep secrets off the config module entirely (same pattern as `ANTHROPIC_API_KEY` in `container-runner.ts`).

## Invariants
- All existing config exports remain unchanged
- New keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — engine config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, `CONTAINER_IMAGE`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- Container-related exports (`CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, etc.) — still needed for Claude engine
