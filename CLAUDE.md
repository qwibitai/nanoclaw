# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Quality Standards

These are hard rules for any change to `src/` or `container/agent-runner/src/`. New code that violates them is not accepted; existing violations are tracked for split.

### Module size

- **400-line ceiling** per `.ts` file (implementation and tests). When a file approaches the limit, split along a natural seam (responsibility, subsystem, or `describe` block).
- Prefer directories of small files (`foo/bar.ts`, `foo/baz.ts`) over monoliths. The top-level `src/foo.ts` becomes a thin barrel that re-exports the split.
- Target: each module under ~300 lines where practical; 400 is the hard cap.

### Testability

- **Pure functions get direct unit tests.** Side-effect code (fs, spawn, network, DB, timers) should be isolated behind a thin layer that is trivially mockable.
- **Dependency injection at module boundaries**: functions that need fs / spawn / a DB should accept those as arguments or via a `Deps` object, not import them at module scope where tests would have to patch ESM imports.
- **No hidden mutable state**. Module-level `let` variables need an `_resetForTests()` exporter, or should be refactored into an object returned by a factory.
- **Barrel files** (`src/db.ts`, `src/host-runner.ts`) exist only to preserve the public API after a split. They re-export and contain no logic.

### Test coverage

- **Coverage tool**: `@vitest/coverage-v8`, run via `npm run test:coverage`. Report is written to `coverage/` (git-ignored).
- **Target**: `lines ≥ 90`, `statements ≥ 90`, `functions ≥ 85`, `branches ≥ 80`. Enforced in CI via thresholds in `vitest.config.ts`.
- **Exclusions are justified**: a file added to `coverage.exclude` must be either (a) a barrel, (b) a type-only module, or (c) a spawn/SDK-for-await wrapper where mocking costs more than it buys. Document the reason inline in `vitest.config.ts`.
- **Every new implementation file ships with tests in the same commit.** No test gaps left for later.

### Test file organization

- Tests live alongside their implementation: `foo.ts` → `foo.test.ts`.
- Tests for a split directory live inside it: `db/tasks.ts` → `db/tasks.test.ts`.
- Integration tests live in `src/__tests__/integration/` and use the helpers in `harness.ts`.
- Test files follow the same 400-line cap. Split by `describe` block when they grow past it.

### Quality gates (must all pass)

Run locally before committing; CI runs the same set:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage   # enforces thresholds above
npm run build           # includes container/agent-runner
```

`.husky/pre-commit` auto-runs `format:fix`; the rest is on you.

### When refactoring large files

Use the **extract → re-export → rewire** pattern so every intermediate state stays green:

1. Create the new module, move functions with their signatures unchanged.
2. Make the original file a barrel that re-exports everything, so no caller's imports break.
3. Add unit tests for the extracted module in the same commit (or the very next one).
4. Only after all callers work, start updating imports to point at the new path directly. Remove barrel entries once no one uses them.

Never leave a refactor half-done: split **and** tested within the same sequence of commits.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Logs

Application logs are written to `./logs/`:

| File | Contents |
|------|---------|
| `logs/nanoclaw.error.log` | stderr (warn/error level) |
| `logs/nanoclaw.error.log-YYYYMMDD` / `.gz` | Rotated daily |

Per-group host-agent run logs: `groups/{name}/logs/host-agent-*.log`

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
