# Intent: src/container-runner.ts modifications

## What changed
Added `CORSAIR_MCP_URL` env var passthrough and Linux `host.docker.internal` host entry to `buildContainerArgs()`.

## Key sections

### buildContainerArgs()
After the `TZ` env var push, added:
```typescript
// Pass Corsair MCP URL so the agent can connect to the integration server
if (process.env.CORSAIR_MCP_URL) {
  args.push('-e', `CORSAIR_MCP_URL=${process.env.CORSAIR_MCP_URL}`);
}

// On Linux, host.docker.internal doesn't resolve by default
if (process.platform === 'linux') {
  args.push('--add-host=host.docker.internal:host-gateway');
}
```
- Conditional on `CORSAIR_MCP_URL` being set — no-op when Corsair is not configured
- Linux host entry required because Docker Desktop handles `host.docker.internal` on macOS/Windows automatically but not on Linux

## Invariants
- All existing volume mounts are unchanged
- Mount ordering is preserved
- `readSecrets()` and stdin-based secret passing unchanged
- Container lifecycle (spawn, timeout, output parsing) unchanged
- `runContainerAgent`, `writeTasksSnapshot`, `writeGroupsSnapshot` unchanged

## Must-keep
- TZ passthrough (must come before CORSAIR additions)
- User/group passthrough (`--user` flag)
- All existing volume mounts (project, group, global, sessions, IPC, agent-runner, additional)
- Mount security model (`validateAdditionalMounts`)
