# Intent: src/container-runner.ts modifications

## What changed
Surface llama.cpp MCP server log lines at info level so they appear in `nanoclaw.log` for the monitoring watcher script.

## Key sections

### container.stderr handler (inside runContainerAgent)
- Changed: empty line check from `if (line)` to `if (!line) continue;`
- Added: `[LLAMACPP]` tag detection — lines containing `[LLAMACPP]` are logged at `logger.info` instead of `logger.debug`
- All other stderr lines remain at `logger.debug` level

## Invariants (must-keep)
- Stderr truncation logic unchanged
- Timeout reset logic unchanged (stderr doesn't reset timeout)
- Stdout parsing logic unchanged
- Volume mount logic unchanged
- All other container lifecycle unchanged
