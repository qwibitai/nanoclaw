# Intent: src/container-runner.ts modifications

## What changed
Added a volume mount for Proton Bridge credentials (`~/.proton-mcp/`) so the Proton MCP server inside the container can connect to Bridge's IMAP/SMTP.

## Key sections

### buildVolumeMounts()
- Added: Proton credentials mount after the Gmail credentials mount (or after session mounts if Gmail is not applied):
  ```
  const protonDir = path.join(homeDir, '.proton-mcp');
  if (fs.existsSync(protonDir)) {
    mounts.push({
      hostPath: protonDir,
      containerPath: '/home/node/.proton-mcp',
      readonly: false,  // MCP server may cache connection state
    });
  }
  ```
- Uses `os.homedir()` to resolve the home directory
- Mount is read-write because the MCP server may need to write state
- Mount is conditional — only added if `~/.proton-mcp/` exists on the host

### Imports
- Added: `os` import for `os.homedir()` (may already exist from Gmail skill)

## Invariants
- All existing mounts are unchanged
- Mount ordering is preserved (Proton added after session mounts, before additional mounts)
- The `buildContainerArgs`, `runContainerAgent`, and all other functions are untouched
- Additional mount validation via `validateAdditionalMounts` is unchanged

## Must-keep
- All existing volume mounts (project root, group dir, global, sessions, IPC, agent-runner, additional)
- The mount security model (allowlist validation for additional mounts)
- The `readSecrets` function and stdin-based secret passing
- Container lifecycle (spawn, timeout, output parsing)
