# Security Fixes Cherry-Pick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate upstream security fixes (commit `a4fd4f2`) that prevent command injection in `stopContainer` and mount path injection via Docker `-v` options.

**Architecture:** Cherry-pick the upstream commit, then fix one downstream caller in `container-runner.ts` that depends on the old `stopContainer` string-return signature.

**Tech Stack:** TypeScript, Node.js `execSync`, vitest

---

### Task 1: Cherry-pick upstream commit and resolve conflicts

**Files:**
- Modify: `src/container-runtime.ts:59-62` (stopContainer) and `src/container-runtime.ts:114` (cleanupOrphans caller)
- Modify: `src/container-runtime.test.ts:41-47`
- Modify: `src/mount-security.ts:65-67` (allowlist caching) and `src/mount-security.ts:215` (colon check)

- [ ] **Step 1: Attempt the cherry-pick**

```bash
git cherry-pick a4fd4f2 --no-commit
```

If conflicts arise in `container-runtime.ts`, they'll be in the `stopContainer` function or `cleanupOrphans`. The upstream changes:

`src/container-runtime.ts` — `stopContainer` becomes:
```typescript
/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}
```

`cleanupOrphans` caller changes from `execSync(stopContainer(name), ...)` to just `stopContainer(name)`.

`src/mount-security.ts` — line 66, remove `allowlistLoadError = ...` assignment (replace with a comment). And add colon check in `isValidContainerPath` before the final `return true`:
```typescript
  // Must not contain colons — prevents Docker -v option injection (e.g., "repo:rw")
  if (containerPath.includes(':')) {
    return false;
  }
```

`src/container-runtime.test.ts` — replace the existing `stopContainer` test:
```typescript
describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Resolve any conflicts and stage**

```bash
git add src/container-runtime.ts src/container-runtime.test.ts src/mount-security.ts
```

- [ ] **Step 3: Verify the cherry-pick compiles**

```bash
npm run build
```

Expected: may fail due to `container-runner.ts` still using old `stopContainer` signature. That's Task 2.

---

### Task 2: Fix downstream `stopContainer` caller in container-runner.ts

**Files:**
- Modify: `src/container-runner.ts:556-571`

- [ ] **Step 1: Update the killOnTimeout function**

In `src/container-runner.ts`, the current code at line 556-571:

```typescript
    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };
```

Replace with:

```typescript
    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };
```

- [ ] **Step 2: Remove unused `exec` import if no longer needed**

Check if `exec` from `child_process` is used anywhere else in `container-runner.ts`. If not, remove it from the imports.

- [ ] **Step 3: Build and run tests**

```bash
npm run build && npm test
```

Expected: all pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/container-runtime.ts src/container-runtime.test.ts src/mount-security.ts src/container-runner.ts
git commit -m "fix(security): cherry-pick upstream a4fd4f2 — command injection + mount path fixes

Cherry-picks upstream security fixes:
- stopContainer validates container name, executes internally (no shell injection)
- mount-security rejects : in container paths (Docker -v injection)
- Allowlist file-not-found no longer permanently cached

Fixes downstream caller in container-runner.ts killOnTimeout.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
