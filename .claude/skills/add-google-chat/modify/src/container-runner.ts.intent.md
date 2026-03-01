# Intent: src/container-runner.ts modifications

## What changed
Added a volume mount for Google Chat OAuth credentials (`~/.google-chat-mcp/`) so token refresh works inside the container.

## Key sections

### buildVolumeMounts()
- Added: Google Chat credentials mount after the Gmail credentials mount:
  ```
  const gchatDir = path.join(homeDir, '.google-chat-mcp');
  if (fs.existsSync(gchatDir)) {
    mounts.push({
      hostPath: gchatDir,
      containerPath: '/home/node/.google-chat-mcp',
      readonly: false,  // OAuth token refresh
    });
  }
  ```
- Uses `os.homedir()` to resolve the home directory (already imported for Gmail)
- Mount is read-write because OAuth tokens may need refreshing
- Mount is conditional — only added if `~/.google-chat-mcp/` exists on the host

## Invariants
- All existing mounts are unchanged (including Gmail mount)
- Mount ordering is preserved (Google Chat added after Gmail, before IPC)
- The `buildContainerArgs`, `runContainerAgent`, and all other functions are untouched
- Additional mount validation via `validateAdditionalMounts` is unchanged

## Must-keep
- All existing volume mounts (project root, group dir, global, sessions, Gmail, IPC, agent-runner, additional)
- The mount security model (allowlist validation for additional mounts)
- The `readSecrets` function and stdin-based secret passing
- Container lifecycle (spawn, timeout, output parsing)
