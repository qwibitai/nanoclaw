# File Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents share files with users via URLs at `code.goette.co/files/<group>/` by mounting a shared directory into containers.

**Architecture:** Add a writable mount from `/home/martin/nanoclaw-files/<group>/` to `/workspace/shared-files/` in each container. A container skill tells agents the URL pattern. A cron job deletes files older than 7 days. Constants live in `src/config.ts`.

**Tech Stack:** Node.js, fs, Vitest, cron.

---

### Task 1: Add constants to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add SHARED_FILES_DIR and SHARED_FILES_URL constants**

Add after the `DATA_DIR` line (line 43) in `src/config.ts`:

```typescript
export const SHARED_FILES_DIR = path.resolve(HOME_DIR, 'nanoclaw-files');
export const SHARED_FILES_URL = 'https://code.goette.co/files';
```

- [ ] **Step 2: Run build to verify no errors**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add SHARED_FILES_DIR and SHARED_FILES_URL constants"
```

---

### Task 2: Add shared files mount to container runner

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Read `src/container-runner.test.ts` to understand the existing test patterns. Then add a test to the describe block that tests `buildVolumeMounts` (or the integration test that checks container args). The test should verify that the shared files mount is present in the generated mounts.

Find the test file's existing pattern for testing mounts. Add a test that:

```typescript
it('includes shared-files writable mount for group', async () => {
  // Look at how existing tests set up a group and call the runner
  // The mount list should contain:
  // - hostPath containing 'nanoclaw-files/<group-folder>'
  // - containerPath: '/workspace/shared-files'
  // - readonly: false
});
```

The exact test code depends on how the existing tests are structured — read the test file first, then follow the same pattern. The assertion should verify a mount exists with:
- `containerPath` equal to `/workspace/shared-files`
- `readonly` equal to `false`
- `hostPath` containing `nanoclaw-files/` and the group folder name

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`
Expected: The new test FAILS because the mount doesn't exist yet.

- [ ] **Step 3: Add the shared files mount to buildVolumeMounts**

In `src/container-runner.ts`, add the import for `SHARED_FILES_DIR` at the top where other config imports are:

```typescript
import { SHARED_FILES_DIR } from './config.js';
```

Then in `buildVolumeMounts()`, add the following block after the IPC namespace section (after line 286, before the agent-runner copy section):

```typescript
  // Shared files directory: agents write files here and they become
  // accessible at code.goette.co/files/<group>/
  const sharedFilesDir = path.join(SHARED_FILES_DIR, group.folder);
  fs.mkdirSync(sharedFilesDir, { recursive: true });
  mounts.push({
    hostPath: sharedFilesDir,
    containerPath: '/workspace/shared-files',
    readonly: false,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/container-runner.test.ts`
Expected: All tests PASS including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: add shared-files writable mount to containers"
```

---

### Task 3: Create container skill with agent instructions

**Files:**
- Create: `container/skills/shared-files/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `container/skills/shared-files/SKILL.md`:

```markdown
---
name: shared-files
description: Share files with users via public URLs. Save files to /workspace/shared-files/ and they become downloadable links.
---

# Sharing Files

To share files (code, images, CSVs, PDFs, charts, etc.) with the user:

1. Save the file to `/workspace/shared-files/`
2. The file becomes accessible at `https://code.goette.co/files/<group>/<filename>`
3. Include the full URL in your response so the user can click it

**The `<group>` name** is the name of the directory at `/workspace/group/`. To find it:

```bash
basename $(readlink -f /workspace/group)
```

**Example:**

```bash
# Save a generated chart
cp /tmp/analysis.png /workspace/shared-files/analysis.png
```

Then in your response:
> Here's the analysis: https://code.goette.co/files/my-group/analysis.png

**Notes:**
- Files are automatically cleaned up after 7 days
- Use descriptive filenames — they appear in the URL
- Any file type is supported
```

- [ ] **Step 2: Verify the skill is picked up by checking the skills sync logic**

Run: `ls container/skills/shared-files/SKILL.md`
Expected: File exists.

The existing skills sync in `container-runner.ts` (lines 150-160) copies everything from `container/skills/` into each group's `.claude/skills/`. No code change needed — the skill will be auto-synced on next container run.

- [ ] **Step 3: Commit**

```bash
git add container/skills/shared-files/SKILL.md
git commit -m "feat: add shared-files container skill with URL instructions"
```

---

### Task 4: Set up cleanup cron job

**Files:**
- None (system configuration)

- [ ] **Step 1: Add cron job for 7-day cleanup**

Run:

```bash
(crontab -l 2>/dev/null; echo '0 3 * * * find /home/martin/nanoclaw-files -type f -mtime +7 -delete && find /home/martin/nanoclaw-files -mindepth 1 -type d -empty -delete') | crontab -
```

This runs daily at 3am: deletes files older than 7 days, then removes empty directories.

- [ ] **Step 2: Verify cron is installed**

Run: `crontab -l`
Expected: The cleanup line is present.

---

### Task 5: Build and verify end-to-end

**Files:**
- None (verification only)

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (except pre-existing formatting.test.ts failures).

- [ ] **Step 3: Verify the shared files directory exists**

Run: `ls -la /home/martin/nanoclaw-files/`
Expected: Directory exists with test.txt from earlier.

- [ ] **Step 4: Clean up test file**

Run: `rm /home/martin/nanoclaw-files/test-nanoclaw.txt 2>/dev/null; rm ~/code/test-nanoclaw.txt 2>/dev/null`
