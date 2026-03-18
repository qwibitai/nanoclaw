# Development Guidelines

## Code Principles

- **Readability first** — clean, human-readable code with meaningful variable names. Clarity over brevity.
- **Functional design** — services take inputs, yield deterministic outputs. No hidden side effects.
- **Maintainability over cleverness** — no premature optimizations. Code must be maintainable by developers who didn't write it.
- **Simplicity (KISS & YAGNI)** — build only what's needed. Prefer simpler solutions that can be validated before investing in sophisticated alternatives.
- **Follow best practices** — established conventions for the languages, frameworks, and packages in use. Community standards over novel approaches.

## Test-First Development

Unit tests for new logic MUST be written before the implementation code:

1. Write the test
2. Run it — verify it **fails**
3. Write the minimum implementation to make it pass

Applies to: new service functions, business logic, hooks, utilities, and bug fixes (reproduce the bug in a test first). Never proceed with failing tests.

## Quality Gates

All changes must pass before committing:

- All tests pass
- Linting passes with zero errors
- Type checking passes with zero errors (typed languages)

## Git Discipline

- **Never push without explicit permission** — commits are fine, pushing is gated
- Commit format: `type(scope): [ticket] description`
- One logical change per commit
- Branch naming follows spec directory: `XXXX-type-description` where type is `feat`, `fix`, or `chore`

## Process Hygiene

Cleanup is mandatory. Every process started during a session must be stopped before the session ends. A session that completes but leaves orphaned processes is **incomplete**.

- **Dev servers**: before starting one, check if one is already running (`pgrep -f "vite\|webpack-dev-server\|next dev\|rails s"`). Reuse it — never start a duplicate.
- **Docker**: any container started during this session MUST be stopped and removed before finishing. Use `docker stop <id> && docker rm <id>`, or `docker compose down`. Never leave containers running.
- **Watchers, file observers, background build processes**: stop all of them when done.
- **Verification step**: before marking work complete, run `ps aux | grep <project-pattern>` to confirm nothing from this session is still running.
- Verify UI and integration work against the running application. Unit tests alone are insufficient.

## Speckit

- Constitution at `.specify/memory/constitution.md` is **authoritative** — never modify it during implementation
- Adjust spec, plan, or tasks instead
- **Homer (clarify)** → fix one finding per iteration, loop until `ALL_FINDINGS_RESOLVED`
- **Lisa (analyze)** → fix one finding per iteration, loop until `ALL_FINDINGS_RESOLVED`
- **Ralph (implement)** → implement one task per iteration, loop until `ALL_TASKS_COMPLETE`
- Exit after each iteration — restart with fresh context

<!-- ====== PROJECT SPECIFIC ====== -->

<!-- Add project-specific guidelines below (technologies, commands, structure, etc.) -->

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
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/image-gen` | Generate images with fal.ai (works on host and in containers) |

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
launchctl unload ~/Library/LaunchAgents/com.noclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Shared Host + Container Commands

When adding a command that needs to work both on the host (Claude Code) and inside agent containers, follow this pattern:

1. **Core module** in `container/agent-runner/src/` — pure logic with dependency injection (no hard imports of external SDK clients). This compiles with the agent-runner and is the single source of truth.
2. **MCP tool** in `container/agent-runner/src/ipc-mcp-stdio.ts` — imports the core module, passes the SDK client. Container agents call it as `mcp__nanoclaw__<tool_name>`.
3. **CLI script** in `scripts/` — imports the core module, configures credentials from `.env`. Host Claude Code calls it via Bash.
4. **Host skill** in `.claude/skills/<name>/SKILL.md` — documents the CLI interface so Claude Code auto-triggers without reading the script.
5. **Container skill** in `container/skills/<name>/SKILL.md` — documents the MCP tool interface for container agents.
6. **Test** in `container/agent-runner/src/<module>.test.ts` — tests the core module with DI mocks (no cross-`node_modules` issues). Vitest picks it up via the `container/agent-runner/src/**/*.test.ts` include in `vitest.config.ts`.
7. **Env vars** — read secrets from `.env` via `readEnvFile()` in `src/container-runner.ts` and pass as `-e` args to the container. Never mount `.env` into containers.
8. **After changes** — delete stale per-group agent-runner copies (`data/sessions/*/agent-runner-src/`) and rebuild the container (`./container/build.sh`).

Reference implementation: `generate_image` (fal.ai) — see `container/agent-runner/src/fal-image.ts`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Active Technologies
- TypeScript 5.x (Node.js, ESM) + grammy (Telegram), whisper.cpp (transcription), qmd (vault search), better-sqlite3 (001-obsidian-journal-audio-linking)
- Obsidian vault on filesystem (`~/Obsidian/pj-private-vault/pj-private-vault/`), SQLite for message state (001-obsidian-journal-audio-linking)
- TypeScript 5.x (Node.js, ESM) + cron-parser 5.x, better-sqlite3, pino (logging) (002-fix-digest-timezone)
- SQLite via better-sqlite3 (`store/messages.db`) (002-fix-digest-timezone)

## Recent Changes
- 001-obsidian-journal-audio-linking: Added TypeScript 5.x (Node.js, ESM) + grammy (Telegram), whisper.cpp (transcription), qmd (vault search), better-sqlite3
