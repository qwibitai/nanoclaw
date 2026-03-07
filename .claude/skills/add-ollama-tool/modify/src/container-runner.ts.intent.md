# Intent: src/container-runner.ts modifications

## What changed
Removed the `[OLLAMA]` stderr detection logic. Ollama status is now handled via structured JSON-RPC `ollama_status` notifications through the IPC handler system, so stderr parsing is no longer needed.

## Key sections

### container.stderr handler (inside runContainerAgent)
- Changed: empty line check from `if (line)` to `if (!line) continue;`
- Removed: `[OLLAMA]` tag detection — all stderr lines now logged at `logger.debug` uniformly

## Invariants
- All existing mounts are unchanged
- The JSON-RPC handler registration, `buildContainerArgs`, `runContainerAgent`, and all other functions are untouched
- Additional mount validation via `validateAdditionalMounts` is unchanged
- Secrets passed via JSON-RPC initialize request (not mounted as files)
- Stderr truncation logic unchanged
- Timeout reset logic unchanged (stderr doesn't reset timeout)

## Must-keep
- All existing volume mounts (project root, group dir, global, sessions, agent-runner, additional)
- The mount security model (allowlist validation for additional mounts)
- The `readSecrets` function and JSON-RPC-based secret passing
- Container lifecycle (spawn, JSON-RPC server/client, timeout, output handling)
