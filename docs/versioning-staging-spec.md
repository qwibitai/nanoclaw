# Harness-Vertical Versioning & Staging — Specification

## 1. Problem Statement

NanoClaw is a harness that powers private vertical repos (e.g. garsson-prints). The harness exposes an implicit contract to verticals through 7 surfaces: container runtime, MCP tools, IPC protocol, mount paths, environment variables, config schema, and the case sync adapter interface. None of these are formally declared or versioned.

**Today:**
- `package.json` auto-bumps patch on every `src/` or `container/` change. A breaking IPC rename and a typo fix get the same version treatment.
- The auto-update system (kaizen #50) cannot know if pulling a harness update will break a running vertical.
- There is no staging environment. Testing a harness change requires risking production, or manually standing up an ad-hoc test. The codebase assumes a single instance per machine.

**Who experiences the problem:**
- **Operators (Aviad):** Must manually inspect every commit to decide if an update is safe.
- **Work agents:** Will silently break if the harness updates and removes/renames an MCP tool or IPC type they depend on.
- **Future verticals:** Cannot declare "I need harness >= X" or "I use these surfaces."

**Cost of not solving it:**
- The auto-update system (#50) cannot be safely deployed — it has no brakes.
- Every harness update is a manual, high-risk operation.
- As more verticals are added, the chance of a breaking update silently affecting one increases.

## 2. Desired End State

After this work:

1. **A machine-readable contract manifest** (`contract.json`) declares exactly what the harness exposes to verticals. It is generated from source code, so it cannot drift.

2. **Breaking changes are signaled in the version.** Conventional commits (`feat!:`, `BREAKING CHANGE:`) trigger minor version bumps. Non-breaking changes bump patch. The version number carries semantic meaning.

3. **Verticals declare their dependencies.** A `nanoclaw-compat.json` in the vertical repo lists which contract surfaces the vertical uses. A compatibility checker compares this against the harness contract and reports safe/breaking before any update is applied.

4. **A staging environment can run alongside production.** A single env var (`NANOCLAW_INSTANCE`) namespaces all conflicting resources. When unset, behavior is identical to today (zero regression risk).

### Out of scope

- Runtime contract enforcement (rejecting unknown MCP tool calls at the container boundary)
- Automatic migration scripts for breaking changes
- Multi-machine distributed staging (this is single-machine, two-process)
- The auto-update system itself (#50) — this provides the safety layer it depends on

## 3. Roles & Boundaries

| Role | Owns | Reads | Cannot access |
|------|------|-------|---------------|
| Harness repo | `contract.json`, generation script, version bump workflow | Vertical's `nanoclaw-compat.json` (via compat checker) | Vertical domain code |
| Vertical repo | `nanoclaw-compat.json` | Harness `contract.json` | Harness internals beyond the contract |
| Auto-updater (#50) | Update decisions | Both manifests, version comparison | Direct code modification |
| CI | Contract drift check, version bump | Commit messages, source files | Production state |

## 4. Architecture

### 4a. Contract Manifest System

```
Source files (ground truth)          Generated artifact
┌─────────────────────────┐         ┌──────────────────┐
│ ipc-mcp-stdio.ts        │──┐      │                  │
│ ipc.ts                  │  │      │  contract.json   │
│ container-runner.ts     │──┼─────▶│  (checked in)    │
│ Dockerfile              │  │      │                  │
│ case-backend.ts         │──┘      └────────┬─────────┘
│ escalation.ts           │                  │
└─────────────────────────┘                  │ compared against
                                             ▼
                                   ┌──────────────────┐
                                   │ nanoclaw-compat   │
                                   │ .json (vertical)  │
                                   └──────────────────┘
```

**Generation script** (`scripts/generate-contract.ts`):
- Parses each source file with targeted regex to extract surface declarations
- Produces a deterministic JSON output (sorted keys, stable ordering)
- `npm run contract:check` diffs generated vs checked-in — fails if out of sync
- `npm run contract:generate` overwrites `contract.json` with fresh output

**CI enforcement:**
- `contract:check` runs in CI on every PR
- If contract surfaces changed but `contract.json` wasn't updated, CI fails

### 4b. Version Bump Logic

```
Commit messages on main
        │
        ▼
┌───────────────────────────┐
│ bump-version.yml          │
│                           │
│ Any commit has            │
│ "BREAKING CHANGE:" or     │──── yes ───▶ npm version minor
│ "feat!:" / "fix!:" ?      │
│                           │──── no ────▶ npm version patch
└───────────────────────────┘
```

This extends the existing `bump-version.yml` workflow. The `contractVersion` field in `contract.json` is bumped independently of `package.json` — it tracks the contract schema version, not the release version.

### 4c. Staging Instance Isolation

```
Production                          Staging
(NANOCLAW_INSTANCE unset)           (NANOCLAW_INSTANCE=staging)

store/messages.db                   store-staging/messages.db
data/ipc/                           data-staging/ipc/
groups/                             groups-staging/
port 3001                           port 3002
nanoclaw-agent:latest               nanoclaw-agent:staging
nanoclaw.service                    nanoclaw-staging.service
.env                                .env.staging
TELEGRAM_BOT_TOKEN=prod             TELEGRAM_BOT_TOKEN=staging
nanoclaw-{group}-{ts}               nanoclaw-staging-{group}-{ts}
```

**Implementation:** All paths flow through `src/config.ts` constants. The change adds an `INSTANCE_ID` that conditionally suffixes directory names and adjusts port defaults. When `NANOCLAW_INSTANCE` is not set, every export produces the exact same value as today.

**Telegram isolation:** Two long-polling consumers cannot share one bot token. The staging instance must use a separate Telegram bot (created via @BotFather). The `.env.staging` file holds the staging bot token.

## 5. Interaction Models

### 5a. Developer updates the harness contract

1. Developer adds a new MCP tool to `ipc-mcp-stdio.ts`
2. Developer runs `npm run contract:generate` — `contract.json` is updated with the new tool
3. Developer commits both files: source change + updated manifest
4. CI runs `contract:check` — passes (manifest is in sync)
5. If the change is breaking (tool renamed/removed), developer uses `feat!:` commit prefix
6. CI bumps minor version instead of patch

### 5b. Auto-updater checks compatibility before applying

1. Detector finds new harness version (new SHA on main)
2. Fetches new `contract.json` from the new commit
3. Runs `check-vertical-compat.ts` against each registered vertical's `nanoclaw-compat.json`
4. If all verticals report safe → apply update to production
5. If any vertical reports breaking → route update to staging, notify operator

### 5c. Operator tests a change in staging

1. Operator (or auto-updater) applies the harness update to staging checkout
2. `NANOCLAW_INSTANCE=staging npm start` starts staging alongside production
3. Staging uses its own DB, dirs, bot, port — zero interference with production
4. Operator tests via staging Telegram bot
5. If good → apply same update to production. If bad → investigate, staging is disposable.

### 5d. Error case: contract.json is stale

1. Developer changes an MCP tool but forgets to update `contract.json`
2. PR created
3. CI runs `contract:check` → fails with diff showing what changed
4. Developer runs `npm run contract:generate`, commits the update, pushes
5. CI passes

## 6. State Management

| Component | State | Storage | Survives restart |
|-----------|-------|---------|-----------------|
| `contract.json` | Harness contract declaration | Git (checked in) | Yes (repo file) |
| `nanoclaw-compat.json` | Vertical's dependency declaration | Git (vertical repo) | Yes (repo file) |
| Version | `package.json` version field | Git (checked in) | Yes (repo file) |
| Staging DB | Staging instance's SQLite | `store-staging/messages.db` | Yes (disk file) |
| Staging groups | Staging group folders | `groups-staging/` | Yes (disk dirs) |

No new in-memory state. No new databases. Everything is files.

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Auto version bump | `.github/workflows/bump-version.yml` | Working — bumps patch on src/container changes |
| Path configuration | `src/config.ts` — all paths as exported constants | Working — all consumers import from config |
| Container naming | `container-runner.ts` line 333 | Working — `nanoclaw-{group}-{ts}` |
| Orphan cleanup | `container-runtime.ts` `cleanupOrphans()` | Working — kills containers matching prefix |
| Env file loading | `src/env.ts` `readEnvFile()` | Working — reads `.env` from `process.cwd()` |
| Systemd service setup | `setup/service.ts` | Working — generates unit file |
| CI pipeline | `.github/workflows/ci.yml` | Working — format, typecheck, tests |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| Contract manifest | `contract.json` + generation script | Contract was never formalized |
| Contract CI check | `contract:check` step in CI | No manifest existed to check against |
| Conventional commit bumping | Minor vs patch based on commit message | Version bump was always patch |
| Vertical compat file | `nanoclaw-compat.json` schema + checker | No contract existed to check against |
| Instance namespacing | `NANOCLAW_INSTANCE` support in config.ts | Single-instance assumption was fine until auto-update |
| Instance-aware env loading | `.env.{instance}` support | Single `.env` was sufficient |
| Instance-scoped containers | Container name + cleanup prefixed with instance | Single-instance assumption |
| Instance-aware service setup | Systemd unit name includes instance | Single service was sufficient |

## 8. Open Questions & Known Risks

### Open Questions

**Q1: Should `contractVersion` track independently from `package.json` version?**
Options: (a) Independent counter, bumped only when contract surfaces change. (b) Same as package.json version.
Lean: (a) — the contract changes less frequently than the code. A vertical pinning `minContractVersion: 2` shouldn't need to update every time a non-contract internal change bumps the package version.

**Q2: How granular should the compat checker be?**
Options: (a) Surface-level only ("mcpTools changed"). (b) Element-level ("tool `send_message` was removed").
Lean: (b) — element-level is more useful and not much harder to implement. A vertical that uses only `send_message` shouldn't care that `schedule_task` was renamed.

**Q3: Should staging auto-create its directories on first start?**
Options: (a) Auto-create `store-staging/`, `data-staging/`, `groups-staging/`. (b) Require manual setup.
Lean: (a) — the existing code already creates `store/` and `groups/` if missing. Same pattern.

### Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Regex extraction in generate-contract.ts is fragile | Medium | Low (CI catches drift) | Tests with known patterns; CI as safety net |
| Developer forgets `feat!:` prefix on breaking change | Medium | Medium (wrong version) | CI contract check catches surface changes; advisory in pre-commit |
| Staging Telegram bot not created | Low | Low (staging won't receive messages) | Document in setup instructions |
| Two instances stepping on same Docker daemon | Low | Low | Container names are namespaced by instance |

## 9. Implementation Sequencing

```
PR 1 (staging) ──────────────────────────────────────┐
PR 2 (contract manifest) ──┬── PR 4 (CI check) ──────┤
                            └── PR 5 (compat checker) ┤
PR 3 (conventional commits) ─────────────────────────┘
                                                      ↓
                                              kaizen #50 (auto-update)
```

PRs 1, 2, and 3 have zero dependencies on each other. PRs 4 and 5 depend on PR 2 (need the manifest to check against). The auto-update system (#50) benefits from all of these.

Estimated total effort: ~1 day across 5 small PRs.
