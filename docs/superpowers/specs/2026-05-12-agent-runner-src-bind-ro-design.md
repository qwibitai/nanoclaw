# NanoClaw v2 — Plan 2.7: agent-runner-src Read-Only Bind from Upstream

**Status:** spec (pre-plan)
**Author:** Jonas + Claude Opus 4.7
**Date:** 2026-05-12
**Trigger:** Bug D discovered during Plan 2.6 deploy (Smoke S2). `src/group-init.ts:101-109` only copies `container/agent-runner/src/` into `data/v2-sessions/<id>/agent-runner-src/` on the initial install; any upstream change after that never reaches existing sessions. Workaround was manual `cp` to 7 agent groups. Plan 2.6 deferred the fix here.

---

## 1. Problem statement

The container mounts `/app/src` from a per-session copy at `data/v2-sessions/<id>/agent-runner-src/`. The copy is initialized once in `group-init.ts` only when the destination doesn't already exist (`if (!fs.existsSync(groupRunnerDir))`). After that, **the copy and the upstream `container/agent-runner/src/` drift apart forever** unless someone manually `cp`s files.

Plan 2.6 Smoke S2 surfaced this concretely: the new `formatter.ts` was built into `nanoclaw-agent:latest` and on `dist/`, but the running container booted from the stale per-session copy and returned `Permission denied` to `/clear`. Manual sync of 7 groups was required.

---

## 2. Root cause analysis

`src/container-runner.ts:213-214` builds the mount:

```typescript
const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });
```

The mount is RW. The original design intent (per the inline comment) was *"agents can modify their runner"* — a self-modification feature where a running container could write back to `/app/src` and persist changes to the host.

**Evidence that the feature is purely aspirational:**

- `grep -rn "agent-runner-src" container/ src/ scripts/ docs/` shows only:
  - `src/group-init.ts:102-107` — initial copy
  - `src/container-runner.ts:213-214` — mount
  - `src/v1/container-runner.ts:190` — v1 equivalent
  - One doc reference
- No code writes to `agent-runner-src/` after initial install
- No agent in any of 7 active groups has actually modified its own runner — the only diffs from upstream are *drift of time* (commits like `2a72ddd` added image-attachment support and updated `poll-loop.ts` upstream, but the existing per-session copies stayed on the old version)
- The container's entrypoint compiles `/app/src` → `/tmp/dist` and runs from `/tmp/dist`, so even a hypothetical runtime edit to `/app/src` would only take effect on next container spawn

The cost of the aspirational feature (Bug D — silent staleness, hard-to-diagnose production bugs) far exceeds its zero current value.

---

## 3. Goals

Make Bug D structurally impossible by eliminating the per-session copy entirely. Mount `container/agent-runner/src/` directly into the container as a read-only bind. One source of truth (git). Any upstream change reaches the next container respawn automatically.

Stay focused: don't refactor `wakeContainer`, don't touch v1, don't migrate schemas.

---

## 4. Architecture

### Approach: read-only bind of upstream

**Before (Plan 2.6 and earlier):**
```
host-sweep → wakeContainer(session)
  → docker run -v data/v2-sessions/<id>/agent-runner-src:/app/src   (RW)
```

**After (Plan 2.7):**
```
host-sweep → wakeContainer(session)
  → docker run -v container/agent-runner/src:/app/src:ro            (RO)
```

The per-session copy is removed entirely. `group-init.ts` no longer creates `agent-runner-src/` on init.

### Why read-only

1. **Defense:** a compromised agent cannot modify its own runner in runtime to escalate or persist arbitrary code.
2. **Predictability:** the container always sees the same canonical files that exist in git. Reproducible.
3. **Bug D is impossible:** there is no second copy to drift from.

### Why upstream source path (not the baked image)

The image's `/app/src` (baked at `./container/build.sh` time) would also work, but:
- The image is rebuilt less often than the source changes.
- Mount from host is the existing pattern — TS source is still compiled at runtime by the entrypoint (`npx tsc --outDir /tmp/dist`), so behavior is identical.
- Faster iteration: developer edits `container/agent-runner/src/X.ts` → restart container → change live. No image rebuild needed.

### Reversibility

If a real self-modification use case appears (e.g., the agent needs to install per-group custom MCP tools as TypeScript source), reverting to per-session copy is a 1-commit change. The decision is documented in this spec.

---

## 5. Components

### Files modified

| File | Change |
|---|---|
| `src/container-runner.ts` | Extract `buildAgentRunnerMounts(projectRoot: string): Mount[]` as exported function. Replace the inline block (lines 211-214) with `mounts.push(...buildAgentRunnerMounts(projectRoot))`. Mount hostPath is `<projectRoot>/container/agent-runner/src`, containerPath is `/app/src`, `readonly: true`. ~10 lines refactored. |
| `src/group-init.ts` | Remove the block `// 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy` (lines 101-109). ~9 lines deleted. |

### Files created

| File | Purpose |
|---|---|
| `src/container-runner.test.ts` | 3 vitest cases for `buildAgentRunnerMounts` (paths, readonly, no per-session reference). Pure function, no mocks. |
| `scripts/cleanup-stale-agent-runner-src.ts` | Optional one-shot CLI: remove all `data/v2-sessions/*/agent-runner-src/` directories. ~15 lines. Idempotent. |

### Files NOT modified (explicitly out of scope)

- `src/v1/container-runner.ts` — v1 is in sunset; preserves the old per-session pattern.
- `container/agent-runner/src/*` — source of truth, unchanged.
- `Dockerfile`, `container/build.sh` — image rebuild is unrelated to mount strategy.
- `src/group-init.test.ts` — does not exist; not creating one (the `cpSync` call being absent is verified via smoke S3).

---

## 6. Data flow

### Container spawn (post-deploy)

```
host-sweep tick (60s)
  → countDueMessages → row due
  → wakeContainer(session)
    → buildMounts(agentGroup, session)
        → buildAgentRunnerMounts(projectRoot) returns:
            [{ hostPath: '/root/nanoclaw/container/agent-runner/src',
               containerPath: '/app/src',
               readonly: true }]
    → docker run --rm --name nanoclaw-v2-<group>-<ts>
        -v /root/nanoclaw/container/agent-runner/src:/app/src:ro
        ...
        nanoclaw-agent:latest

container entrypoint:
  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
    → reads /app/src/*.ts (mounted RO from upstream)
    → writes compiled JS to /tmp/dist (RW, ephemeral)
  ln -sf /app/node_modules /tmp/dist/node_modules
  node /tmp/dist/index.js
    → poll-loop starts; reads inbox; processes
```

### Group init (new agent group post-deploy)

```
add-finance / add-naia / ... skill creates agent_group row → group-init runs:
  1. Create groups/<folder>/CLAUDE.md, .claude/, settings.json, skills/ ← unchanged
  2. (PREVIOUSLY) Copy container/agent-runner/src → data/v2-sessions/<id>/agent-runner-src
     REMOVED. No per-session source dir is created.
  3. chownRecursive to UID 1000 ← unchanged
```

### Compatibility

| Behavior | Before | After |
|---|---|---|
| Container sees `/app/src` as a TS source tree | ✅ | ✅ (same content, RO mount) |
| `npx tsc` compiles at runtime | ✅ | ✅ (writes to `/tmp/dist`, still RW) |
| Agent edits `/app/src/X.ts` at runtime | technically allowed (RW) | blocked (RO mount) — aceitable |
| Upstream TS change reaches next container | ❌ (Bug D) | ✅ (next respawn picks it up) |
| `./container/build.sh` required after TS edit | No (and was irrelevant for runtime src) | No (still irrelevant for runtime src) |

### Error handling

| Scenario | Behavior |
|---|---|
| Agent tries to write to `/app/src/X.ts` | EACCES from kernel; agent's container stderr captures it. No host impact. Comportamento esperado. |
| `container/agent-runner/src/` deleted on host | Next container spawn fails with "bind source path does not exist". Loud, visible. Same severity as deleting `dist/`. |
| Two builds racing while container is up | POSIX inode semantics: running container keeps reading the version that was mounted at spawn time. Next respawn reads new version. No race. |
| v1 session ever reactivated | v1 mount path unchanged. Bug D persists in v1, but v1 is in sunset. Out of scope. |

### Observability

- After deploy, `data/v2-sessions/*/agent-runner-src/` become dead directories. `lsof -p <container-pid> | grep agent-runner-src` returns empty (the cleanup script can then safely remove them).
- No new log line is added — this is a "less code path" change.
- A regression that re-adds per-session bind would show up as either (a) the cleanup script flagging non-empty dirs again or (b) `buildAgentRunnerMounts.test.ts` T3 failing.

---

## 7. Testing strategy

### Automated — vitest

**`src/container-runner.test.ts`** (NEW)

3 tests against the extracted `buildAgentRunnerMounts(projectRoot)` pure function:

| Test | Setup | Assertion |
|---|---|---|
| T1 — mount paths | `buildAgentRunnerMounts('/repo/root')` | returns 1 mount with `hostPath === '/repo/root/container/agent-runner/src'` and `containerPath === '/app/src'` |
| T2 — read-only | same | mount.readonly === true |
| T3 — no per-session reference | same | hostPath does NOT contain `'data/v2-sessions'` or `'agent-runner-src'` (regression guard against accidental revert) |

Pure function, no mocks, no DB. Trivial.

**Existing tests** must remain green (439 total in pre-2.7 baseline → 442 after Plan 2.7).

### Manual smoke (operator post-deploy)

| Cenário | Procedure | Pass |
|---|---|---|
| S1 — Levis after respawn | `docker stop <levis-container>`; wait for next sweep tick; `/clear` no `@LevisBot` | Replies `Session cleared.` (Plan 2.6 regression check). |
| S2 — `/app/src` is RO | `docker exec <levis-container> touch /app/src/test-ro 2>&1` | Fails with read-only filesystem error. |
| S3 — new agent groups don't create dir | Create a throwaway agent_group via DB or test script; verify `data/v2-sessions/<new-id>/agent-runner-src/` does NOT exist | Directory absent. (Cleanup the throwaway group after.) |
| S4 — full vitest suite | `npx vitest run` | 442 passed, 0 failed. |

S1 + S4 = minimum acceptance. S2 + S3 = nice-to-have.

### Cleanup post-deploy (optional)

`scripts/cleanup-stale-agent-runner-src.ts` (NEW):

```typescript
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

Operator runs once post-deploy. Idempotent.

---

## 8. Deploy strategy

1. Merge all commits to `main`.
2. `npm run build` (regenerates `dist/` with the new `buildAgentRunnerMounts` + group-init change).
3. **Skip `./container/build.sh`** — image content doesn't change (the entrypoint already compiles from `/app/src` at runtime). Image rebuild is irrelevant to the mount path change.
4. Restart host service: `systemctl restart nanoclaw`.
5. Force respawn of active containers: `docker ps --format '{{.Names}}' | grep nanoclaw-v2 | xargs -r docker stop`. Host-sweep respawns them on next cron tick / message.
6. Validate: S1 (Levis still works) and S4 (vitest green) at minimum; S2 + S3 if time permits.
7. Optional: `npx tsx scripts/cleanup-stale-agent-runner-src.ts` to remove the 7 orphaned dirs.

---

## 9. Acceptance criteria

- [ ] `buildAgentRunnerMounts(projectRoot: string): Mount[]` extracted as an exported function in `src/container-runner.ts`
- [ ] Returned mount has `hostPath: '<projectRoot>/container/agent-runner/src'`, `containerPath: '/app/src'`, `readonly: true`
- [ ] `wakeContainer` in `src/container-runner.ts` uses `buildAgentRunnerMounts(projectRoot)` and no longer references `groupRunnerDir`
- [ ] Block `// 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy` removed from `src/group-init.ts`
- [ ] `src/v1/container-runner.ts` unchanged
- [ ] 3 new tests in `src/container-runner.test.ts` (T1 paths, T2 readonly, T3 no per-session reference) — all green
- [ ] Full vitest suite green (442 tests after Plan 2.7)
- [ ] After deploy: `/clear` via Telegram on a respawned container still returns `Session cleared.` (regression of Plan 2.6 holds)
- [ ] After deploy: `docker exec` shows `/app/src` mounted RO with content matching `container/agent-runner/src/`
- [ ] After deploy: creating a new agent group does NOT create `data/v2-sessions/<new-id>/agent-runner-src/`
- [ ] `scripts/cleanup-stale-agent-runner-src.ts` exists; running it once removes the 7 orphaned dirs

---

## 10. Residual risk + follow-ups

- **Self-mod use case in the future:** if a real need appears (e.g., per-group custom MCP servers as TS source), the revert is straightforward — restore `buildAgentRunnerMounts` to use per-session path and re-add the `group-init.ts` copy block. This spec is the historical record of the trade-off.
- **v1 still has Bug D:** intentional. v1 is in sunset. When v1 is fully removed, the `src/v1/` directory goes with it.
- **Cleanup script idempotent but destructive in concept:** the script targets only `agent-runner-src/` subdirs, not the parent session dirs. The 7 affected groups today are all drift; manual customization is not in evidence anywhere. If somehow a group had real customization that was never propagated upstream, this would lose it — but the same script can be inspected before running.
- **Container image cache:** if a developer rebuilds `nanoclaw-agent:latest` after Plan 2.7 with an old Dockerfile that COPYs `agent-runner/src/` into the image, that's fine — the bind RW from host overrides whatever was COPYed. No mitigation needed.

---

## 11. What's NOT in this spec

- Implementing a real agent self-mod feature
- Changes to `src/v1/*`
- Changes to `Dockerfile`, `container/build.sh`, or image build process
- Refactoring `wakeContainer` beyond extracting `buildAgentRunnerMounts`
- New admin commands, channel adapters, or skills
- Log rotation
- Schema migration
- Documenting the trade-off in `CONTRIBUTING.md` (out of scope here; one-line update can happen as a small follow-up commit)
