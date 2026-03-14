# Modification Intent: src/container-runner.ts

## Goal
Mount the Google Workspace CLI configuration directory (`~/.config/gws`) into containers so agents can access Google Workspace services (Gmail, Drive, Calendar, etc.).

## Changes

### 1. Import `os` module (top of file)
Add to imports section:
```typescript
import os from 'os';
```

### 2. Add gws config mount (in `buildVolumeMounts` function)
Location: After the `.claude` session mount (around line 151), before the IPC mount

Add:
```typescript
// Google Workspace CLI credentials (shared across all groups)
const gwsConfigDir = path.join(os.homedir(), '.config', 'gws');
if (fs.existsSync(gwsConfigDir)) {
  mounts.push({
    hostPath: gwsConfigDir,
    containerPath: '/home/node/.config/gws',
    readonly: false,
  });
}
```

## Invariants
- Mount only if `~/.config/gws` exists (don't break installations without gws)
- Use read-write mount (gws needs to update token cache)
- Place after session mounts, before IPC mounts (order matters for mount precedence)
- Use `os.homedir()` for cross-platform compatibility

## Rationale
- gws stores OAuth credentials in `~/.config/gws/credentials.enc`
- Container needs access to read credentials and write token cache
- Shared across all groups (not per-group like Claude sessions)
- Conditional mount ensures backward compatibility
