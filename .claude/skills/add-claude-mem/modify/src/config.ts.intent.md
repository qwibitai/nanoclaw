# Intent: src/config.ts modifications

## What changed
Exported `HOME_DIR` so container-runner.ts can import it for locating the claude-mem plugin cache.

## Key sections
- **HOME_DIR**: Changed from `const` to `export const`. Used by container-runner to find `~/.claude/plugins/cache/thedotmack/claude-mem/`.
- No new env vars or readEnvFile changes — claude-mem runs on the host, not from config.

## Invariants
- All existing config exports remain unchanged
- HOME_DIR value calculation is unchanged (`process.env.HOME || os.homedir()`)
- The `import os` was already present before this skill
- No new dependencies or env vars

## Must-keep
- All existing exports
- The `readEnvFile` pattern for all config values
- `escapeRegex` helper and `TRIGGER_PATTERN` construction
