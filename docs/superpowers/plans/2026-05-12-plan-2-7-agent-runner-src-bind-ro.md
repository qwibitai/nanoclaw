# NanoClaw v2 — Plan 2.7: agent-runner-src Read-Only Bind from Upstream

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Bug D (cron auto-respawn + admin command stale `agent-runner-src` per-session copies) by binding `container/agent-runner/src/` directly into the container as a read-only volume. Single source of truth in git. No more drift.

**Architecture:** Two-file refactor: extract `buildAgentRunnerMounts(projectRoot)` as a pure function in `src/container-runner.ts` (mounts upstream RO instead of per-session RW), then remove the per-session copy block in `src/group-init.ts:101-109`. v1 is untouched (sunset). 3 vitest cases against the new pure function; smoke S1 (`/clear` still works) + S4 (full suite green) post-deploy. Optional cleanup script removes the 7 orphaned `data/v2-sessions/*/agent-runner-src/` directories.

**Tech Stack:** TypeScript (NanoClaw v2), vitest, Docker bind mounts, systemd.

**Spec:** [docs/superpowers/specs/2026-05-12-agent-runner-src-bind-ro-design.md](../specs/2026-05-12-agent-runner-src-bind-ro-design.md) (commit `94122d3`).

---

## File Structure

### Files modified in this plan

```
src/
├── container-runner.ts                                 # MODIFY: extract buildAgentRunnerMounts, replace lines 211-214
└── group-init.ts                                       # MODIFY: remove lines 101-109 (agent-runner-src copy)
```

### Files created in this plan

```
src/
└── container-runner.test.ts                            # NEW: 3 vitest cases for buildAgentRunnerMounts

scripts/
└── cleanup-stale-agent-runner-src.ts                   # NEW: idempotent rm of orphaned per-session dirs
```

### Files NOT modified (explicitly out of scope)

- `src/v1/container-runner.ts` — v1 is in sunset; preserves the old per-session pattern.
- `container/agent-runner/src/*` — source of truth, unchanged.
- `Dockerfile`, `container/build.sh` — image rebuild is unrelated to mount strategy.
- `src/group-init.test.ts` — does not exist; not creating one (the absence of the `cpSync` call is verified by Smoke S3).
- Channel adapters, router, db, host-sweep — out of scope.

### What's NOT in this plan

- Implementing a real agent self-mod feature.
- Changes to `src/v1/*`.
- Refactoring `wakeContainer`, `buildMounts`, or `initGroupFilesystem` beyond the extractions and removals listed above.
- New admin commands, channel adapters, or skills.
- Log rotation.
- Schema migration.

---

## Naming and conventions

- **Exported function:** `buildAgentRunnerMounts(projectRoot: string): VolumeMount[]` in `src/container-runner.ts`.
- **VolumeMount interface:** already exists at `src/container-runner.ts:41-45`; exported in Task 2 so tests can use it without re-declaring.
- **`projectRoot`:** matches the convention already used in `src/group-init.ts:44` — `process.cwd()`. Inside `buildMounts`, passed to `buildAgentRunnerMounts(process.cwd())`.
- **Mount path:** `path.join(projectRoot, 'container', 'agent-runner', 'src')` → `/app/src`, `readonly: true`.
- **Cleanup script CLI:** `npx tsx scripts/cleanup-stale-agent-runner-src.ts` — no flags; idempotent.

---

## Phase 1 — Extract `buildAgentRunnerMounts` (Bug D core fix)

### Task 1: Write failing tests for `buildAgentRunnerMounts`

**Files:**
- Create: `src/container-runner.test.ts`

- [ ] **Step 1.1: Write the test file**

Create `src/container-runner.test.ts` with EXACTLY:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildAgentRunnerMounts, type VolumeMount } from './container-runner.js';

describe('buildAgentRunnerMounts', () => {
  it('T1: mounts container/agent-runner/src under /app/src using the given projectRoot', () => {
    const mounts: VolumeMount[] = buildAgentRunnerMounts('/repo/root');

    expect(mounts).toHaveLength(1);
    expect(mounts[0].hostPath).toBe(path.join('/repo/root', 'container', 'agent-runner', 'src'));
    expect(mounts[0].containerPath).toBe('/app/src');
  });

  it('T2: mount is read-only (defense + no Bug D recurrence)', () => {
    const mounts = buildAgentRunnerMounts('/repo/root');
    expect(mounts[0].readonly).toBe(true);
  });

  it('T3: regression guard — hostPath must NOT reference per-session data dirs', () => {
    const mounts = buildAgentRunnerMounts('/repo/root');
    // If anyone reverts to per-session copy, hostPath would include
    // 'data/v2-sessions' or 'agent-runner-src'. Block that at the test layer.
    expect(mounts[0].hostPath).not.toContain('data/v2-sessions');
    expect(mounts[0].hostPath).not.toContain('agent-runner-src');
  });
});
```

- [ ] **Step 1.2: Run the test — expect FAIL with import error**

```bash
cd /root/nanoclaw && npx vitest run src/container-runner.test.ts
```

Expected: failure on import of `buildAgentRunnerMounts` and/or `VolumeMount` — neither is currently exported. Error like `"buildAgentRunnerMounts" is not exported by ./container-runner.js`.

- [ ] **Step 1.3: Commit the failing test**

```bash
git add src/container-runner.test.ts
git commit -m "test(container-runner): add buildAgentRunnerMounts tests (Plan 2.7, failing)"
```

---

### Task 2: Extract `buildAgentRunnerMounts` + export `VolumeMount`

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 2.1: Export `VolumeMount` interface**

Use the `Edit` tool:

- old_string:
```typescript
interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}
```

- new_string:
```typescript
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}
```

- [ ] **Step 2.2: Add the exported `buildAgentRunnerMounts` function**

Use the `Edit` tool to add the new function immediately before the existing `buildMounts` function. Find the line `function buildMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {` and insert the new function above it.

- old_string:
```typescript
function buildMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {
```

- new_string:
```typescript
/**
 * Build the mount for the agent-runner TypeScript source tree. The container's
 * /app/src is bound read-only directly from container/agent-runner/src/ in the
 * repository — single source of truth in git. This replaces the per-session
 * copy at data/v2-sessions/<id>/agent-runner-src/ that caused Bug D (silent
 * drift across upstream changes; see Plan 2.7 spec §2).
 *
 * Read-only because (a) no code path writes to /app/src at runtime (the
 * compile step writes to /tmp/dist, which is RW), and (b) blocking a
 * compromised agent from rewriting its own runner is defense-in-depth.
 *
 * Exported so src/container-runner.test.ts can verify the path + readonly
 * contract without spinning a real container.
 */
export function buildAgentRunnerMounts(projectRoot: string): VolumeMount[] {
  return [
    {
      hostPath: path.join(projectRoot, 'container', 'agent-runner', 'src'),
      containerPath: '/app/src',
      readonly: true,
    },
  ];
}

function buildMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {
```

- [ ] **Step 2.3: Replace the inline per-session mount block with a call to `buildAgentRunnerMounts`**

Use the `Edit` tool:

- old_string:
```typescript
  // Per-group agent-runner source at /app/src (initialized once at group
  // creation, persistent thereafter — agents can modify their runner)
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
  mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });
```

- new_string:
```typescript
  // Agent-runner source at /app/src — bound read-only directly from the
  // repository's container/agent-runner/src/. Single source of truth; no
  // per-session copy. See Plan 2.7 spec for the Bug D context.
  mounts.push(...buildAgentRunnerMounts(process.cwd()));
```

- [ ] **Step 2.4: Run the tests — expect all 3 to PASS**

```bash
cd /root/nanoclaw && npx vitest run src/container-runner.test.ts
```

Expected: 3 passed, 0 failed.

If a test fails:
- T1 fails on hostPath → recheck `path.join(projectRoot, 'container', 'agent-runner', 'src')` literal.
- T2 fails on readonly → confirm `readonly: true` (NOT `false`) in the returned mount.
- T3 fails because hostPath contains `agent-runner-src` → this is a TRUE failure; the upstream path is `container/agent-runner/src`, NOT `container/agent-runner-src`. Recheck the directory naming.

- [ ] **Step 2.5: Run the full vitest suite to check for regressions**

```bash
cd /root/nanoclaw && npx vitest run
```

Expected: all tests pass. Currently 439 baseline + 3 new = 442 expected.

- [ ] **Step 2.6: Run tsc to confirm no type regressions**

```bash
cd /root/nanoclaw && npm run build
```

Expected: tsc completes without errors.

- [ ] **Step 2.7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(container-runner): bind agent-runner/src read-only from upstream (Plan 2.7)"
```

(The test file is staged again together with the implementation; the prior commit was just the failing skeleton.)

---

### Task 3: Remove per-session `agent-runner-src` copy from `group-init.ts`

**Files:**
- Modify: `src/group-init.ts`

- [ ] **Step 3.1: Remove the copy block**

Use the `Edit` tool:

- old_string:
```typescript
  // 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', group.id, 'agent-runner-src');
  if (!fs.existsSync(groupRunnerDir)) {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
      initialized.push('agent-runner-src/');
    }
  }

```

- new_string:
```typescript
```

(That is: replace the 9-line block with **nothing** — a single empty new_string. The block is deleted entirely. Note: the trailing blank line in the `old_string` is intentional — it removes the separator before the next section.)

- [ ] **Step 3.2: Verify the block is gone**

```bash
grep -n "agent-runner-src" src/group-init.ts
```

Expected: **empty output**. No matches.

- [ ] **Step 3.3: Verify the build still passes**

```bash
cd /root/nanoclaw && npm run build
```

Expected: tsc completes without errors. (If `projectRoot` becomes unused after the deletion, tsc may warn — verify with the next step.)

- [ ] **Step 3.4: Check whether `projectRoot` is still used elsewhere in `group-init.ts`**

```bash
grep -n "projectRoot" src/group-init.ts
```

If output is empty, the `const projectRoot = process.cwd();` on line 44 became dead. Remove it:

Use the `Edit` tool:

- old_string:
```typescript
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const projectRoot = process.cwd();
  const initialized: string[] = [];
```

- new_string:
```typescript
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];
```

If output shows other usages (likely — the `skills/` copy on line ~94 also uses it), **skip this sub-step** and leave `projectRoot` in place.

- [ ] **Step 3.5: Re-run the build to confirm clean compile**

```bash
cd /root/nanoclaw && npm run build
```

Expected: exit 0, no output.

- [ ] **Step 3.6: Run the full vitest suite**

```bash
cd /root/nanoclaw && npx vitest run
```

Expected: 442 passed, 0 failed.

- [ ] **Step 3.7: Commit**

```bash
git add src/group-init.ts
git commit -m "refactor(group-init): drop per-session agent-runner-src copy (Plan 2.7)"
```

---

## Phase 2 — Cleanup script (post-deploy artifact)

### Task 4: Add `cleanup-stale-agent-runner-src.ts`

**Files:**
- Create: `scripts/cleanup-stale-agent-runner-src.ts`

- [ ] **Step 4.1: Write the script**

Create `scripts/cleanup-stale-agent-runner-src.ts` with EXACTLY:

```typescript
/**
 * Remove the orphaned data/v2-sessions/<id>/agent-runner-src/ directories left
 * behind by the pre-Plan 2.7 per-session copy pattern. After Plan 2.7, the
 * container mounts container/agent-runner/src/ directly (RO), so these
 * per-session copies are dead disk.
 *
 * Idempotent: re-running is a no-op once everything is cleaned. Safe to run
 * before or after host restart — does not touch any active session DB or
 * agent state.
 *
 * Usage:
 *   npx tsx scripts/cleanup-stale-agent-runner-src.ts
 */
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data', 'v2-sessions');
if (!fs.existsSync(dataDir)) {
  console.error(`Data dir not found: ${dataDir}`);
  process.exit(1);
}

let removed = 0;
const entries = fs.readdirSync(dataDir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const stale = path.join(dataDir, entry.name, 'agent-runner-src');
  if (fs.existsSync(stale)) {
    fs.rmSync(stale, { recursive: true, force: true });
    console.log(`✓ removed ${stale}`);
    removed++;
  }
}
console.log(`\nDone. Removed ${removed} stale agent-runner-src directories.`);
console.log('Containers now read /app/src directly from container/agent-runner/src/ (Plan 2.7).');
```

- [ ] **Step 4.2: Verify the script parses**

```bash
cd /root/nanoclaw && npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext scripts/cleanup-stale-agent-runner-src.ts
```

Expected: exit 0, no output.

- [ ] **Step 4.3: Commit (do NOT run the script yet — that's a deploy step)**

```bash
git add scripts/cleanup-stale-agent-runner-src.ts
git commit -m "feat(scripts): add cleanup-stale-agent-runner-src.ts for Plan 2.7 post-deploy"
```

---

## Phase 3 — Build + deploy (operator-driven)

### Task 5: Regenerate `dist/`

- [ ] **Step 5.1: Run the build**

```bash
cd /root/nanoclaw && npm run build
```

Expected: tsc completes without errors. `dist/container-runner.js`, `dist/group-init.js` regenerated.

- [ ] **Step 5.2: Verify the new dist contains `buildAgentRunnerMounts`**

```bash
grep -c "buildAgentRunnerMounts" dist/container-runner.js
```

Expected: ≥ 2 (one definition + one call site).

- [ ] **Step 5.3: Verify the new dist does NOT reference per-session `agent-runner-src`**

```bash
grep -n "agent-runner-src" dist/container-runner.js dist/group-init.js
```

Expected: **empty output**. (The string only survives in source comments after the refactor; comments are stripped from compiled JS.)

If output shows hits, recheck Tasks 2 and 3 — something was missed.

---

### Task 6: Restart the host service

This step is operator-decisioned because restarting cancels in-flight tool calls in active agents. If any agent is mid-conversation, coordinate timing.

- [ ] **Step 6.1: Find the host PID (current)**

```bash
ps auxf | grep -E "node.*nanoclaw/dist/index" | grep -v grep
```

Record the PID. Then:

- [ ] **Step 6.2: Restart via systemd**

```bash
systemctl restart nanoclaw
```

- [ ] **Step 6.3: Verify the new process is running**

```bash
sleep 3
systemctl status nanoclaw | head -8
tail -5 logs/nanoclaw.log
```

Expected: a fresh `Main PID` distinct from Step 6.1's, status `active (running)`, recent log lines showing channel/webhook adapters started.

---

### Task 7: Force respawn of active containers

The host restart usually takes containers down with it. Verify and force any stragglers.

- [ ] **Step 7.1: List active nanoclaw containers**

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E "NAMES|nanoclaw-v2"
```

If only the header appears, all containers exited with the host. Skip to Task 8.

- [ ] **Step 7.2 (if any container listed): Stop them**

```bash
docker ps --format '{{.Names}}' | grep nanoclaw-v2 | xargs -r docker stop
```

Host-sweep respawns them on the next cron tick or inbound message, this time with the new RO mount of upstream.

- [ ] **Step 7.3: Wait for the next respawn**

```bash
sleep 65
grep "Spawning container" logs/nanoclaw.log | tail -3
```

Expected: at least one `Spawning container` line with timestamp after Task 6.2's restart.

If no spawn appears, no session was due — that's fine. The next inbound message or cron tick will spawn with the new mount.

---

## Phase 4 — Smoke validation

### Task 8: Smoke S1 — `/clear` via Telegram (Plan 2.6 regression check)

- [ ] **Step 8.1: Send `/clear` to a Telegram-attached agent bot**

For Levis (finance), send to `@LevisBot`:

```
/clear
```

Expected reply: `Session cleared.`

If the reply is `Permission denied: /clear requires admin access.`, the container is running with the new mount but somehow doesn't have the Plan 2.6 formatter fix in `/app/src`. That would mean `container/agent-runner/src/formatter.ts` is missing the fix — verify with:

```bash
grep -c "Compose senderId with channel prefix" container/agent-runner/src/formatter.ts
```

Expected: 1. If 0, the upstream file is broken — investigate before proceeding.

- [ ] **Step 8.2: Mark S1**

Record `S1: ✅` or `S1: ❌ <reason>` in your notes.

---

### Task 9 (optional): Smoke S2 — `/app/src` is read-only

- [ ] **Step 9.1: Pick an active container name**

```bash
docker ps --format '{{.Names}}' | grep nanoclaw-v2 | head -1
```

Record the name. If empty, send any chat message via Telegram to wake a container, then re-run.

- [ ] **Step 9.2: Try to touch a file under `/app/src`**

Replace `<name>` with the container name from Step 9.1:

```bash
docker exec <name> touch /app/src/test-ro 2>&1
```

Expected: an error like `touch: cannot touch '/app/src/test-ro': Read-only file system`.

- [ ] **Step 9.3: Mark S2**

Record `S2: ✅` (got the read-only error) or `S2: ❌`.

---

### Task 10 (optional): Smoke S3 — new agent groups don't create `agent-runner-src/`

This requires creating a throwaway agent group. Skip if you don't want to mutate the DB.

- [ ] **Step 10.1: Create a temporary agent group via DB**

```bash
sqlite3 data/v2.db "INSERT INTO agent_groups (id, name, folder, agent_provider, container_config, created_at)
  VALUES ('tmp-plan-2-7-smoke', 'TmpSmoke', 'tmp_smoke', NULL, NULL, datetime('now'));"
```

- [ ] **Step 10.2: Trigger `initGroupFilesystem` for it**

Use a one-shot tsx invocation:

```bash
cd /root/nanoclaw && npx tsx -e '
import { initGroupFilesystem } from "./src/group-init.js";
import { getAgentGroup } from "./src/db/agent-groups.js";
const g = getAgentGroup("tmp-plan-2-7-smoke");
if (!g) { console.error("group not found"); process.exit(1); }
initGroupFilesystem(g);
console.log("init done");
'
```

Expected output: `init done`.

- [ ] **Step 10.3: Verify NO `agent-runner-src/` was created**

```bash
test -d data/v2-sessions/tmp-plan-2-7-smoke/agent-runner-src && echo "FAIL: directory exists" || echo "PASS: directory absent"
```

Expected: `PASS: directory absent`.

- [ ] **Step 10.4: Clean up the throwaway**

```bash
sqlite3 data/v2.db "DELETE FROM agent_groups WHERE id='tmp-plan-2-7-smoke';"
rm -rf data/v2-sessions/tmp-plan-2-7-smoke groups/tmp_smoke
```

- [ ] **Step 10.5: Mark S3**

Record `S3: ✅` or `S3: ❌`.

---

### Task 11 (optional): Run the cleanup script

Removes the 7 orphaned `data/v2-sessions/*/agent-runner-src/` directories left from the pre-Plan 2.7 era.

- [ ] **Step 11.1: Inspect the script before running**

```bash
cat scripts/cleanup-stale-agent-runner-src.ts | head -25
```

Confirm: targets only `agent-runner-src/` subdirectories under `data/v2-sessions/*`, never any other path.

- [ ] **Step 11.2: Run it**

```bash
cd /root/nanoclaw && npx tsx scripts/cleanup-stale-agent-runner-src.ts
```

Expected output: lines like `✓ removed data/v2-sessions/<group-id>/agent-runner-src` for each orphaned dir, then `Done. Removed N stale agent-runner-src directories.` where N is between 0 and 7.

- [ ] **Step 11.3: Confirm idempotency**

```bash
cd /root/nanoclaw && npx tsx scripts/cleanup-stale-agent-runner-src.ts
```

Expected output: `Done. Removed 0 stale agent-runner-src directories.`

- [ ] **Step 11.4: Verify no orphans remain**

```bash
ls -d data/v2-sessions/*/agent-runner-src/ 2>/dev/null | wc -l
```

Expected: `0`.

---

## Phase 5 — Plan closeout

### Task 12: Mark Plan 2.7 complete

- [ ] **Step 12.1: Update the acceptance checklist below**

Edit this file. In the §Acceptance criteria section, change each `- [ ]` to `- [x]` for items that were verified.

- [ ] **Step 12.2: Commit closeout**

```bash
git add docs/superpowers/plans/2026-05-12-plan-2-7-agent-runner-src-bind-ro.md
git commit -m "chore(plans): mark Plan 2.7 complete"
```

---

## Acceptance criteria

- [x] `buildAgentRunnerMounts(projectRoot: string): VolumeMount[]` exported in `src/container-runner.ts`
- [x] Returned mount has `hostPath: '<projectRoot>/container/agent-runner/src'`, `containerPath: '/app/src'`, `readonly: true`
- [x] `buildMounts` in `src/container-runner.ts` calls `buildAgentRunnerMounts(process.cwd())` instead of the inline per-session block (lines 211-214 removed)
- [x] `VolumeMount` interface is exported (was previously local) so the test can import its type
- [x] Block `// 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy` removed from `src/group-init.ts`
- [x] `src/v1/container-runner.ts` unchanged
- [x] 3 new tests in `src/container-runner.test.ts` (T1 paths, T2 readonly, T3 regression guard) — all green
- [x] Full vitest suite green (442 passing — 439 pre-2.7 baseline + 3 new)
- [x] `npm run build` produces a clean `dist/`
- [x] `dist/group-init.js` has 0 references to `agent-runner-src`; `dist/container-runner.js` has only a JSDoc comment reference (preserved by tsc, not a live code path)
- [x] Post-deploy Smoke S1: `/clear` on the respawned Levis Telegram bot returned `Session cleared.` (Plan 2.6 regression check holds)
- [x] Post-deploy Smoke S2: `docker exec nanoclaw-v2-finance-1778598010645 touch /app/src/test-ro` failed with `Read-only file system`; `mount` confirms `/app/src ext4 (ro,relatime)`; `md5sum /app/src/formatter.ts` matches upstream `container/agent-runner/src/formatter.ts` exactly
- [x] Post-deploy Smoke S3: empirical check — `data/v2-sessions/finance/agent-runner-src` was deleted by cleanup script before `/clear` respawned the Levis container; `initGroupFilesystem` did NOT recreate it (directory still absent after respawn)
- [x] `scripts/cleanup-stale-agent-runner-src.ts` ran idempotently: first run removed 7 orphaned dirs, second run reported `Removed 0 stale agent-runner-src directories`

---

## Residual risk + follow-ups

- **Container image cache:** if `nanoclaw-agent:latest` has a stale `agent-runner/src/` baked in, that's fine — the host bind RO overrides whatever was COPYed into the image. No mitigation needed.
- **`./container/build.sh` not run as part of deploy:** intentional. The image only carries Dockerfile layers (deps, entrypoint), not the agent-runner TS source we mount over. Skip the rebuild unless `Dockerfile` itself changed.
- **v1 sessions ever reactivated:** v1's per-session pattern persists. Bug D remains in v1 only. Tolerable because v1 is in sunset; deletion of `src/v1/*` is a separate plan.
- **Future self-mod use case:** if a real need appears, reverting is a 1-commit change (restore `buildAgentRunnerMounts` to use per-session path, restore `group-init.ts` copy block). The spec is the historical record of the trade-off.

---

## Troubleshooting

- **Test T3 fails with "expected hostPath not to contain 'agent-runner-src'"** — the implementation in Task 2 is using `container/agent-runner-src/` instead of `container/agent-runner/src/`. Recheck the path components: `path.join(projectRoot, 'container', 'agent-runner', 'src')`.
- **`npm run build` fails with "Property 'projectRoot' is declared but never read"** — Step 3.4 missed the dead variable. Re-run the grep, remove the line if no other usages remain.
- **`/clear` after deploy still returns "Permission denied"** — container is still running the pre-Plan 2.6 formatter. Force respawn via `docker stop`. If still fails, check `container/agent-runner/src/formatter.ts` for the "Compose senderId" comment that Plan 2.6 added.
- **Smoke S2: `touch /app/src/test-ro` succeeds (no error)** — the mount is still RW. Recheck Task 2.3 — `readonly: true` (NOT `false`) in `buildAgentRunnerMounts`.
- **vitest "v4.x" not recognized** — `npx vitest` invokes the project-local vitest from `node_modules`. If broken, run `npm install` first.
