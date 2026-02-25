# Intent: src/container-runner.ts modifications

## What changed
Added a volume mount for Gmail OAuth credentials (`~/.gmail-mcp/`) so the Gmail MCP server inside the container can authenticate with Google.

## Key sections

### buildVolumeMounts()
- Added: Gmail credentials mount after the `.claude` sessions mount:
  ```
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false,  // MCP may need to refresh OAuth tokens
    });
  }
  ```
- Uses `os.homedir()` to resolve the home directory
- Mount is read-write because the Gmail MCP server needs to refresh OAuth tokens
- Mount is conditional — only added if `~/.gmail-mcp/` exists on the host

### Imports
- Added: `os` import for `os.homedir()`

## Invariants
- All existing mounts are unchanged
- Mount ordering is preserved (Gmail added after session mounts, before additional mounts)
- The `buildContainerArgs`, `runContainerAgent`, and all other functions are untouched
- Additional mount validation via `validateAdditionalMounts` is unchanged

## Must-keep
- All existing volume mounts (project root, group dir, global, sessions, IPC, agent-runner, additional)
- The mount security model (allowlist validation for additional mounts)
- The `readSecrets` function and stdin-based secret passing
- Container lifecycle (spawn, timeout, output parsing)
