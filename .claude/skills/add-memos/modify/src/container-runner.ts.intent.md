# Intent: src/container-runner.ts modifications

## What changed
Added MemOS support to the container launcher: secrets passing, Docker network joining, settings.json synchronization, and agent-runner source freshness.

## Key sections

### Imports
- Added: `CONTAINER_NETWORK`, `MEMOS_API_URL`, `MEMOS_USER_ID` to config import
- Added: `import { readEnvFile } from './env.js'`

### ContainerInput interface
- Added: `secrets?: Record<string, string>` field

### readSecrets() function (new)
- Reads allowed secrets from `.env` via `readEnvFile()`
- Includes `MEMOS_CONTAINER_API_URL` for direct Docker network access (no auth)
- Falls back to `MEMOS_API_URL` if container URL not set
- Passes `MEMOS_USER_ID` when MemOS is configured
- Secrets are passed to containers via stdin, never written to disk

### Settings.json synchronization
- Changed from write-once (`if (!exists)`) to read-merge-write pattern
- Reads existing settings, merges with defaults, always syncs `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
- When `MEMOS_API_URL` is set: disables Claude's auto-memory (`'1'`)
- When `MEMOS_API_URL` is empty: enables Claude's auto-memory (`'0'`)
- Preserves any other settings the user may have added

### Agent-runner source copy
- Removed existence check — always copies from canonical source
- Ensures containers get updated code on every launch (prevents stale code bugs)

### Container networking
- Added `--network ${CONTAINER_NETWORK}` flag when `CONTAINER_NETWORK` is set
- Allows containers to reach MemOS services by hostname (e.g., `http://memos-api:8000`)

### Secrets via stdin
- Passes `readSecrets()` result to container input
- Container receives secrets through stdin JSON, never via environment variables or mounted files

## Invariants
- All existing volume mounts are unchanged
- Mount security (allowlist validation) is unchanged
- Container lifecycle (spawn, timeout, output parsing) is unchanged
- Credential proxy port handling is unchanged
- Host gateway detection logic is unchanged

## Must-keep
- `buildVolumeMounts()` and all existing mounts
- `validateAdditionalMounts()` security model
- Container image selection and timeout handling
- The stdin-based config passing protocol
- All existing `buildContainerArgs()` flags
