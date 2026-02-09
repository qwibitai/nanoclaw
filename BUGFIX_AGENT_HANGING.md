# Bug Fix: Agent Containers Hanging in Docker-in-Docker

## Problem Summary

When deploying NanoClaw on VPS using `docker-compose.vps.yml`, agent containers would hang indefinitely when spawned by the main container, even though the same containers worked perfectly when spawned directly from the host.

**Symptoms:**
- Manual test (`test-container-vps.sh`) works perfectly: agent completes in seconds
- Bot receives Telegram messages but never responds
- Agent containers spawn but never complete - just hang forever
- Multiple agent containers accumulate in "Up" status

## Root Cause

The issue was in `src/container-runner.ts` function `buildVolumeMounts()`.

### The Docker-in-Docker Architecture

```
Host (VPS)
└── Main Container (nanoclaw-bot1) running at /app
    └── Spawns Agent Containers via Docker socket
        └── Agent containers need to mount HOST paths, not main container paths
```

### The Bug

When running in VPS mode (docker-in-docker), the code attempted to verify if mount paths existed using `fs.existsSync()`:

```typescript
// Line 82 (old code)
if (fs.existsSync(dirPath) && !projectRoot.startsWith('/app')) {
  mounts.push({ hostPath: dirPath, ... });
}

// Line 131 (old code)
const sharedSkillsDir = path.join(projectRoot, 'skills');
if (fs.existsSync(sharedSkillsDir)) {
  mounts.push({ hostPath: sharedSkillsDir, ... });
}
```

**The Problem:**
1. `HOST_PROJECT_ROOT` environment variable was set to `/root/project/nanoclaw` (actual host path)
2. Code checked: `fs.existsSync('/root/project/nanoclaw/skills')`
3. But the main container is running at `/app` - the path `/root/project/nanoclaw` doesn't exist **inside the main container**!
4. `fs.existsSync()` returned `false`
5. Skills directory was **never mounted** to agent containers
6. Without skills, agent containers couldn't initialize properly and hung

### Why Manual Tests Worked

The test script (`test-container-vps.sh`) ran directly on the host where `/root/project/nanoclaw/skills` actually exists. No filesystem checks were needed - it just mounted the paths directly.

## The Fix

### Code Changes in `src/container-runner.ts`

**1. Detect VPS Mode:**
```typescript
// Added at line 74
const isVpsMode = !!process.env.HOST_PROJECT_ROOT;
```

**2. Skip Filesystem Checks in VPS Mode:**

For skills directory (critical fix):
```typescript
// Lines 128-142 (updated)
const sharedSkillsDir = path.join(projectRoot, 'skills');
// In VPS mode, always mount (path verified on host, not in container)
// In local mode, check if path exists first
if (isVpsMode || fs.existsSync(sharedSkillsDir)) {
  mounts.push({
    hostPath: sharedSkillsDir,
    containerPath: '/workspace/shared-skills',
    readonly: true,
  });
}
```

Similar fixes for:
- Global directory mounts
- Session directory creation
- Skills directory creation
- IPC directory creation

**3. Disable Local Dev Mounts in VPS Mode:**
```typescript
// Line 75 (updated)
if (isMain && !isVpsMode) {
  // Only mount project directories in local dev mode
  // In VPS, these paths don't exist in main container
}
```

### Infrastructure Changes

**1. Created `init-vps-dirs.sh`:**
- Ensures all required directories exist on the host before starting
- Prevents mount failures due to missing directories
- Run once during initial deployment

**2. Updated Documentation:**
- Added directory initialization step to both READMEs
- Clarified VPS deployment process
- Added troubleshooting notes

## Why This Matters

**Before Fix:**
```
Main Container checks: fs.existsSync('/root/project/nanoclaw/skills')
  → false (path doesn't exist in container)
  → Skills not mounted
  → Agent can't initialize
  → Hangs forever
```

**After Fix:**
```
Main Container checks: isVpsMode? → true
  → Skip filesystem check
  → Always mount skills
  → Agent initializes correctly
  → Completes successfully
```

## Testing the Fix

### On VPS:

```bash
# 1. Pull latest code
git pull

# 2. Initialize directories
./init-vps-dirs.sh

# 3. Rebuild and restart
npm run build
docker compose -f docker-compose.vps.yml up -d --build

# 4. Test by sending a Telegram message
# Bot should now respond!
```

### Verification:

```bash
# Check container logs - should see successful agent completions
docker compose -f docker-compose.vps.yml logs -f nanoclaw-bot1

# Look for:
# [agent-runner] Agent completed successfully
# Container completed (status: success)
```

## Lessons Learned

1. **Filesystem checks in Docker-in-Docker are tricky:**
   - Main container's filesystem ≠ Host filesystem
   - Paths for Docker daemon ≠ Paths inside containers

2. **Environment variable patterns matter:**
   - `HOST_*` variables are a clear signal of VPS mode
   - Use them to enable mode-specific behavior

3. **Skills directory is critical:**
   - Without skills, Claude agent can't function
   - Always ensure it's mounted in all configurations

4. **Test both local and VPS modes:**
   - Different code paths activate in different environments
   - What works locally may fail in docker-in-docker

## Related Files

- **Fixed:** `src/container-runner.ts` (buildVolumeMounts function)
- **Added:** `init-vps-dirs.sh` (directory initialization)
- **Updated:** `README.md`, `docs/zh-TW/README.md` (deployment docs)
- **Test:** `test-container-vps.sh` (manual testing, already worked)

---

**Status:** ✅ Fixed and Tested
**Date:** 2026-02-09
**Impact:** Critical - Unblocks VPS deployment completely
