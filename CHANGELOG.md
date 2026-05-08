# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

## [Unreleased]

- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).
- **Migration fixes.** `1b-db` now resolves Discord DMs as `discord:@me:<id>` (previously skipped any v1 chat that wasn't a guild channel — a blocker for personal-bot installs). `1c-groups` skips symlinks instead of following them (a single broken `.claude-shared.md → /app/CLAUDE.md` no longer aborts the whole copy). When `1b-db` reuses an auto-created `messaging_group` with no wired agents, its `unknown_sender_policy` is now reconciled to the migration's `public` default.

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
