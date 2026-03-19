# CI Pipeline Optimization — Specification

## 1. Problem Statement

The CI pipeline takes **~3m30s** end-to-end for every PR, bottlenecked entirely by the `e2e` job. The `ci` job finishes in ~43s and `pr-policy` in ~5s — neither matters for wall-clock time. The e2e job is the critical path.

Measured timing from GHA logs (5 consecutive runs, 2026-03-19):

| E2E step | Duration | % of total |
|----------|----------|------------|
| Setup (job boot + checkout) | ~5s | 2% |
| setup-node + npm ci | ~12s | 6% |
| Docker Buildx setup | ~8s | 4% |
| Docker build (cached) | 42–117s | 20–55% |
| **E2E tests** | **~112s** | **53%** |
| Post-steps | ~3s | 1% |
| **Total** | **~3m30s** | 100% |

The Docker build variance (42s cached vs 117s uncached) is a secondary issue. The dominant cost is **E2E test execution at ~112s**, which is driven by runtime TypeScript compilation inside containers.

### Why it matters

- Every PR waits ~3m30s for CI, and `strict` branch protection means stale PRs re-run. Two PRs racing can wait 7+ minutes.
- Dev agents poll CI every 15–30s during merge loops — long CI wastes agent time and API tokens.
- The same runtime tsc cost hits **production** agent startup: every agent invocation pays ~20–30s to compile TypeScript before it can respond to a user message. This isn't just a CI problem — it's user-facing latency.

### Who experiences it

- **Dev agents** waiting for CI to merge PRs (operational cost).
- **Aviad** watching CI during manual PR reviews (developer experience).
- **End users** waiting for agent responses (production startup latency).

## 2. Desired End State

- **CI wall-clock time under 2 minutes** for the common case (cached Docker build, no docs-only skip).
- **Production agent boot under 5s** (excluding Claude API call latency).
- **Docker build time variance under 20s** (stable caching, no surprise invalidations).
- CI automatically skips expensive steps for changes that can't affect them (docs, CLAUDE.md, hooks).

### Not in scope

- Parallelizing the `ci` job steps (already ~43s — not the bottleneck).
- Caching `node_modules` between jobs (npm ci is only 7s with cache hit).
- Rewriting E2E tests or adding new test tiers.
- Moving to a different CI provider.

## 3. Root Cause Analysis

### 3.1. Runtime TypeScript compilation (~80s wasted in CI, ~25s per production boot)

**The single largest cost.** This is an architectural issue, not a CI config issue.

**How it works today:**

```
Dockerfile (build time):
  COPY agent-runner/ ./        ← source copied into image
  RUN npm run build            ← compiled to /app/dist/ (UNUSED at runtime)

container-runner.ts (production, per boot):
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir)  ← copies source from host repo
  mount: { hostPath: groupAgentRunnerDir, containerPath: '/app/src' }  ← overwrites image source

entrypoint.sh (every boot):
  cd /app && npx tsc --outDir /tmp/dist  ← recompiles from (possibly mounted) /app/src
  node /tmp/dist/index.js                ← runs from /tmp/dist

E2E helpers.ts (CI):
  fs.cpSync(srcDir, agentRunnerSrcDir)   ← copies source from repo checkout
  '-v', `${agentRunnerSrcDir}:/app/src`  ← mounts over image source (same content!)
```

**Why it exists:** Production mounts source at `/app/src` as a hot-deploy mechanism — after merging a PR and running `npm run build`, agents get new MCP tools without rebuilding the container image. The entrypoint recompiles because the mounted source may differ from the pre-built `/app/dist/`.

**Why it's wasteful:**

1. **In CI:** The mounted source is byte-identical to what's built into the image (same repo checkout). Compilation produces the same output. ~20–30s per container boot × 3–4 boots = **~80s wasted**.
2. **In production:** Compilation happens on every agent boot, even when the source hasn't changed since last boot. A typical agent session compiles once then runs for minutes — the 25s startup tax is paid every time.

**Key fact:** The agent-runner imports nothing from mounted paths (verified by grep). The tsconfig compiles only from `src/**/*` with `rootDir: ./src`. No runtime imports cross the mount boundary. The tsc call is self-contained and its output is deterministic for a given source tree.

### 3.2. Docker build cache instability (0–75s variance)

```dockerfile
# Dockerfile line 60 — no version pinning
RUN npm install -g agent-browser @anthropic-ai/claude-code
```

This ~150MB layer has no pinned versions. When either package releases a new version, the layer hash changes, invalidating this layer and all layers below it (python packages, agent-runner deps, agent-runner build). Build time jumps from ~42s (all cached) to ~117s (redownload + reinstall).

### 3.3. Unnecessary work in non-critical jobs (~20s total, ~3m30s on docs merges)

| Waste | Where | Time saved |
|-------|-------|------------|
| `npm ci` runs even when E2E tests will be skipped | `e2e` job, before path filter | ~7s on docs PRs |
| `setup-node` + `npm ci` in pr-policy | `pr-policy` job (only runs shell scripts) | ~12s on every PR |
| No path filter on push-to-main for E2E | `e2e` job, push trigger | ~3m30s on docs merges |

### 3.4. Redundant container build in Tier 1 test

`buildContainer()` in Tier 1 test 1 calls `./container/build.sh` (which runs `docker build`). But CI already builds the image in the preceding "Build container image" step via `docker/build-push-action@v6`. The test rebuilds from cache, but still pays Docker's cache-check overhead (~2–5s).

## 4. Solution Design

### 4.1. Eliminating runtime tsc (the big win)

**Decision: Pre-compile on host, mount `dist/` instead of `src/`.**

The host already compiles agent-runner during `npm install` (postinstall runs `cd container/agent-runner && npm install`). The change:

1. **`npm run build`** (harness build) also compiles agent-runner, or a separate step does.
2. **`container-runner.ts`** mounts the compiled `dist/` directory instead of `src/`.
3. **`entrypoint.sh`** uses the mounted (or image-built) `dist/` directly — no tsc.
4. **E2E helpers** mount `dist/` (or skip the mount entirely, using the image's built-in dist).

```
Before (every boot):
  mount src/ → tsc → /tmp/dist → node /tmp/dist/index.js    (~25s)

After (every boot):
  mount dist/ → node /app/dist/index.js                      (~0s)
  (host compiles once per deploy, ~2s, amortized)
```

Why this option over alternatives:

| Option | Verdict | Reason |
|--------|---------|--------|
| **A: Pre-compile on host, mount dist/** | **Chosen** | Cleanest — eliminates tsc at source, same path for CI + prod |
| B: Smart entrypoint (hash check, skip if unchanged) | Rejected | Fragile (filesystem metadata), still pays full tsc on changes, adds complexity |
| C: CI-only skip (don't mount in E2E) | Rejected | CI diverges from production path — defeats purpose of E2E |

**Risk: stale dist after code change.** If the host forgets to recompile after a source change, agents run stale tools. Mitigation: `npm run build` already runs on every deploy (required for harness code). Add agent-runner compilation to the same script. A version marker file can detect staleness at container boot and warn (not block).

### 4.2. Stabilizing Docker build cache

Pin exact versions in the global npm install layer:

```dockerfile
RUN npm install -g agent-browser@X.Y.Z @anthropic-ai/claude-code@A.B.C
```

Track updates via Dependabot or a scheduled workflow that checks for new releases.

### 4.3. Skipping unnecessary CI work

1. **Path filter on push-to-main E2E:**
   ```yaml
   on:
     push:
       branches: [main]
       paths: ['container/**', 'src/**', 'package*.json', 'tests/e2e/**', 'vitest.config.e2e.ts']
   ```

2. **Conditional npm ci in E2E** — move `setup-node` + `npm ci` inside the conditional block, after the path filter check.

3. **Remove Node setup from pr-policy** — it only runs `git diff` and `grep`. No Node required.

4. **Replace `buildContainer()` in Tier 1 test** — use `docker image inspect nanoclaw-agent:latest` to verify the image exists instead of rebuilding.

## 5. Time Budget After Fixes

### CI (PR with E2E-relevant changes)

| Step | Current | After fix | Savings |
|------|---------|-----------|---------|
| Setup + checkout | 5s | 5s | — |
| npm ci | 12s (unconditional) | 7s (conditional) | 5s |
| Buildx setup | 8s | 8s | — |
| Docker build (cached) | 42s | 42s | — |
| E2E tests | **112s** | **~30s** | **~82s** |
| Post-steps | 3s | 3s | — |
| **Total** | **~3m30s** | **~1m35s** | **~1m55s** |

E2E test time breakdown after tsc elimination:

| Test | Current | After | Why |
|------|---------|-------|-----|
| Tier 1.1: build check | ~3s (cache rebuild) | ~1s (image inspect) | Skip redundant docker build |
| Tier 1.2: MCP tools | ~5s | ~5s | Already bypasses entrypoint (`--entrypoint node /app/dist/...`) |
| Tier 1.3: compile check | ~5s | ~5s | Already bypasses entrypoint |
| Tier 2: IPC roundtrip | ~99s | ~15s | No tsc at boot; 5s close sentinel delay + processing |
| **Total** | **~112s** | **~26s** | |

Note: Tier 1 tests 2 and 3 already use `--entrypoint node /app/dist/ipc-mcp-stdio.js`, bypassing the entrypoint entirely. The ~99s Tier 2 test is where the tsc cost actually lives — it uses the full entrypoint with runtime compilation.

### Production agent startup

| Phase | Current | After fix |
|-------|---------|-----------|
| Container boot | ~2s | ~2s |
| TypeScript compilation | ~25s | **0s** |
| Agent SDK initialization | ~2s | ~2s |
| **Total to first response** | **~29s** | **~4s** |

## 6. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Docker BuildKit + GHA cache | `docker/build-push-action` with `cache-from/to: type=gha` | Working |
| E2E path filter for PRs | `ci.yml` filter step compares base..head | Working |
| Pre-built dist in Docker image | `RUN npm run build` in Dockerfile | Built but unused at runtime |
| npm cache in CI | `actions/setup-node` with `cache: npm` | Working (7s install) |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| Host-side agent-runner compilation | `npm run build` also compiles agent-runner dist/ | Current design mounts source for hot-deploy |
| Mount dist/ in container-runner | Change mount from `/app/src` to `/app/dist` | Entrypoint assumes source mount + runtime tsc |
| Simplified entrypoint | Remove tsc, run from pre-compiled dist | Entrypoint was written for the source-mount pattern |
| E2E helper mount update | Mount dist/ or skip mount | Mirrors production pattern |
| Version pinning in Dockerfile | Pin agent-browser + claude-code versions | Never pinned |
| Push-to-main path filter | Add `paths:` to push trigger | Not implemented |
| Remove Node from pr-policy | Drop setup-node step | Always included |

## 7. Implementation Sequencing

### Phase 1: Eliminate runtime tsc (highest impact — ~82s CI, ~25s prod)

Files changed:
- `container/entrypoint.sh` — remove tsc, use pre-compiled dist directly
- `src/container-runner.ts` — compile agent-runner on host, mount dist/ instead of src/
- `tests/e2e/helpers.ts` — update mount to dist/ (or remove mount since image dist/ suffices)
- `container/Dockerfile` — ensure `/app/dist/` is properly preserved as the canonical runtime artifact
- `package.json` — add agent-runner compilation to build script

Verification:
- E2E tests pass without runtime tsc
- Production agent boots and registers all MCP tools (smoke test with real container)
- Add new MCP tool to source, run `npm run build`, boot container — tool is available (hot-deploy still works)
- Container boot time measured < 5s (excluding API latency)

### Phase 2: Stabilize Docker cache (prevents 75s surprise regressions)

Files changed:
- `container/Dockerfile` — pin exact versions for global npm packages

Verification:
- Two consecutive CI runs both hit cache for the global npm layer
- `docker history` shows the pinned-version layer hash is stable across runs

### Phase 3: Skip unnecessary CI work (~20s per PR, ~3m30s on docs merges)

Files changed:
- `.github/workflows/ci.yml` — path filter on push, conditional npm ci, drop Node from pr-policy
- `tests/e2e/tier1-container-boot.test.ts` — replace `buildContainer()` with image existence check

Verification:
- Docs-only PR: E2E job skips or completes in <15s
- Docs-only push to main: E2E job does not trigger
- pr-policy job completes without setup-node (check GHA logs for step list)

## 8. Open Questions

1. **Staleness detection.** Should the entrypoint include a lightweight staleness check (compare a version marker in dist/ against source)? Option A: no check, trust the build pipeline (simple, but silent failure if build is skipped). Option B: warn-on-mismatch (log a warning, don't block — defense-in-depth). **Lean: Option B** — a single `stat` comparison adds negligible time and catches deploy mistakes.

2. **Global npm version update mechanism.** After pinning versions in Phase 2, how do we track updates? Options: Dependabot (may not support Dockerfile RUN commands well), a scheduled GHA workflow that checks npm registry, or manual quarterly review. **Lean: scheduled workflow** — check monthly, create a PR if updates available.

3. **Tier 1 test 1 — remove or replace?** `buildContainer()` is redundant with the CI Docker build step. Removing saves ~3s. Replacing with `docker image inspect` validates the image exists. **Lean: replace** — the assertion has value, the rebuild doesn't.

4. **TypeScript version alignment.** Host-side and container-side compilation should use the same TypeScript version for identical output. Currently both use the version in `container/agent-runner/package.json`. Verify this remains true after the change.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Host-compiled dist gets stale after source change | Medium | Agent runs old MCP tools silently | Compile in `npm run build` (runs on every deploy). Add version marker for staleness warning. |
| E2E tests miss a production bug after mount change | Low | Bug in container startup path escapes CI | Phase 1 keeps mount pattern consistent (dist/ not src/), not removing mounts |
| Pinned npm versions block security patches | Low | Known vuln in agent tooling | Monthly update check workflow |
| TypeScript version mismatch host vs container | Low | Compilation output differs | Pin tsc version in both package.json files, verify in CI |
