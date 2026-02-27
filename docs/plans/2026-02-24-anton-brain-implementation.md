# Anton's Brain Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mount Anton's brain (`dalab/anton/brain/`) into every container so all agents get company context automatically.

**Architecture:** The agent-runner already discovers directories under `/workspace/extra/` and passes them as `additionalDirectories` to the Claude SDK (agent-runner/src/index.ts:406-420). The SDK loads CLAUDE.md from each. So the entire integration is: clone/cache `dalab/anton` on the host, then mount `brain/` into `/workspace/extra/brain/` in every container. Zero changes to the agent-runner.

**Tech Stack:** TypeScript, Node.js, Docker bind mounts

---

### Task 1: Add brain repo config

**Files:**
- Modify: `src/config.ts`

**Step 1: Add BRAIN_REPO config constants**

Add to `src/config.ts` after the `TIMEZONE` export:

```typescript
// Anton's brain: company context cloned from dalab/anton
export const BRAIN_REPO_URL = process.env.BRAIN_REPO_URL || '';
export const BRAIN_DIR = path.resolve(DATA_DIR, 'brain');
```

`BRAIN_REPO_URL` defaults to empty (disabled). When set (e.g., `https://github.com/dalab-tech/anton.git`), the container-runner will clone/pull and mount the brain.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "Add brain repo config (BRAIN_REPO_URL, BRAIN_DIR)"
```

---

### Task 2: Add brain sync function

**Files:**
- Create: `src/brain-sync.ts`

**Step 1: Write the brain sync module**

```typescript
/**
 * Brain Sync — clones/pulls Anton's knowledge base repo.
 * Called at startup and periodically to keep brain fresh.
 */
import { execSync } from 'child_process';
import fs from 'fs';

import { BRAIN_DIR, BRAIN_REPO_URL } from './config.js';
import { logger } from './logger.js';

/**
 * Sync the brain repo. Clones on first run, pulls on subsequent runs.
 * Returns the path to brain/ subdirectory, or null if disabled/failed.
 */
export function syncBrain(): string | null {
  if (!BRAIN_REPO_URL) return null;

  try {
    if (!fs.existsSync(BRAIN_DIR)) {
      logger.info({ repo: BRAIN_REPO_URL }, 'Cloning brain repo');
      execSync(`git clone --depth 1 ${BRAIN_REPO_URL} ${BRAIN_DIR}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } else {
      logger.debug('Pulling latest brain');
      execSync('git pull --ff-only', {
        cwd: BRAIN_DIR,
        stdio: 'pipe',
        timeout: 15_000,
      });
    }

    const brainPath = `${BRAIN_DIR}/brain`;
    if (!fs.existsSync(brainPath)) {
      logger.warn({ brainPath }, 'brain/ subdirectory not found in repo');
      return null;
    }

    return brainPath;
  } catch (err) {
    logger.error({ err }, 'Failed to sync brain repo');
    return null;
  }
}
```

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/brain-sync.ts
git commit -m "Add brain sync module — clone/pull Anton's knowledge base"
```

---

### Task 3: Mount brain into containers

**Files:**
- Modify: `src/container-runner.ts`

**Step 1: Import and use brain sync**

Add import at the top of `container-runner.ts`:

```typescript
import { syncBrain } from './brain-sync.js';
```

**Step 2: Add brain mount in `buildVolumeMounts`**

At the end of `buildVolumeMounts`, before the `return mounts;` line, add:

```typescript
  // Mount Anton's brain (company context) as an additional directory.
  // The agent-runner auto-discovers /workspace/extra/* and passes them
  // to the SDK as additionalDirectories, which loads their CLAUDE.md.
  const brainPath = syncBrain();
  if (brainPath) {
    mounts.push({
      hostPath: brainPath,
      containerPath: '/workspace/extra/brain',
      readonly: true,
    });
  }
```

**Step 3: Verify it compiles**

Run: `npm run build`
Expected: Clean compile

**Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "Mount brain into containers at /workspace/extra/brain"
```

---

### Task 4: Sync brain at startup

**Files:**
- Modify: `src/index.ts`

**Step 1: Import and call syncBrain at startup**

Add import:

```typescript
import { syncBrain } from './brain-sync.js';
```

Call `syncBrain()` early in the startup sequence (after config loads, before channels connect). This pre-clones the repo so the first container doesn't wait for it.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Pre-clone brain repo at startup"
```

---

### Task 5: Add BRAIN_REPO_URL to .env.example

**Files:**
- Modify: `.env.example` (if it exists, otherwise skip)

**Step 1: Add the config variable**

Add to `.env.example`:

```
# Anton's brain — company context repo (leave empty to disable)
# BRAIN_REPO_URL=https://github.com/dalab-tech/anton.git
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "Document BRAIN_REPO_URL in .env.example"
```

---

### Task 6: Test end-to-end

**Step 1: Set BRAIN_REPO_URL in .env**

Add to `.env`:
```
BRAIN_REPO_URL=https://github.com/dalab-tech/anton.git
```

**Step 2: Run dev and verify**

Run: `npm run dev`
Expected: Logs show "Cloning brain repo" at startup

**Step 3: Send a test message to Anton**

Send a message and verify the container logs show:
- `Additional directories: /workspace/extra/brain`
- Anton references his identity/engineering context in responses

**Step 4: Verify brain mount in container logs**

Check `groups/main/logs/` for the latest container log. The mounts section should include:
```
/path/to/data/brain/brain -> /workspace/extra/brain (ro)
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Config constants | `src/config.ts` |
| 2 | Brain sync module | `src/brain-sync.ts` (new) |
| 3 | Mount brain into containers | `src/container-runner.ts` |
| 4 | Pre-clone at startup | `src/index.ts` |
| 5 | Document in .env.example | `.env.example` |
| 6 | End-to-end test | Manual verification |

Total: ~30 lines of new code. The agent-runner handles the rest automatically.
