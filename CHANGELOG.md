# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.19] — 2026-04-02 (fork: yanggf8/nanoclaw)

### Search capability for container agents
- **feat:** `container/scripts/search` — DuckDuckGo web search via `agent-browser` (Playwright/Chromium). Usage: `search "query" [--limit N] [--json]`. No API key required; parses DDG HTML article blocks for title, URL, and snippet.
- **feat:** `container/Dockerfile.full` — `search` script is copied into `/usr/local/bin/` so agents can call it directly from any Bash tool invocation.

### Upstream cherry-picks (task scripts)
- **feat:** Agents can now attach a bash `script` to `schedule_task` / `update_task`. The script runs before the agent is woken; if it outputs `{ "wakeAgent": false }` the agent is skipped and waits for the next scheduled run. Suppresses unnecessary API invocations for polling/monitoring tasks.
- **fix:** Spurious chat message no longer sent when a task script suppresses the wake-up.
- **fix:** `script` field now included in `current_tasks.json` snapshot.
- **docs:** Task Scripts instructions added to `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`.

## [1.2.19] — 2026-03-29 (fork: yanggf8/nanoclaw)

### OAuth token auto-refresh (updated 2026-03-29)
- **fix:** Token-refresh launchd plist is now generated dynamically by `setup/service.ts` (alongside `com.nanoclaw.plist`) using the resolved `nodePath` and `projectRoot` — no more hard-coded `/opt/homebrew/bin/node` or `/Users/gf/nanoclaw`. The static `launchd/com.nanoclaw.token-refresh.plist` file has been removed.
- **fix:** Token-refresh job is now installed automatically by `/setup` — no manual plist copy required.

### OAuth token auto-refresh
- **feat:** `scripts/refresh-token.mjs` — calls `platform.claude.com/v1/oauth/token` with the stored `refreshToken` to silently renew the OAuth access token. No user interaction, no Claude Code CLI session required.
- **feat:** `launchd/com.nanoclaw.token-refresh.plist` — runs the refresh script every 4 hours so the ~5h token lifetime never lapses while the machine is on.
- **fix:** `scripts/check-token-expiry.mjs` — alert script now attempts a token refresh before sending a Telegram warning; only alerts if the refresh itself fails. Rate-limited to one alert per 4 hours to prevent spam (previously fired every 30 min for the full duration of expiry). Alert threshold changed from "90 min before expiry" to "already expired".

### Upstream cherry-picks (qwibitai/nanoclaw)
- **fix:** Prevent full message history from being sent to container agents (`MAX_MESSAGES_PER_PROMPT`, default 10).
- **fix(security):** Command injection prevention in `stopContainer`; mount path injection validation.
- **fix:** Timezone validation — POSIX-style TZ values (e.g. `EST5EDT`) no longer crash the scheduler.
- **fix:** Per-group trigger patterns — each group can now use a custom `@trigger` instead of the default `@AssistantName`.
- **fix:** Agent-runner source cache now detects changes to any file in the tree, not just `index.ts`.
- **fix(env):** Single-character `.env` values (e.g. `X=1`) no longer crash the parser.
- **fix:** `isMain` flag is preserved on IPC group updates.
- **fix:** Groups registered via IPC or at runtime now receive a `CLAUDE.md` from the global template so agents start with context.
- **fix:** `isMain` groups always get the main CLAUDE.md template; existing files are never overwritten.
- **fix(db):** Telegram DM backfill defaults to DMs instead of groups.
- **fix:** Telegram `/start`, `/help`, and other non-command slash messages now pass through instead of being silently dropped.

### Post-cherry-pick fixes
- **fix:** `stopContainer` `execSync` now has a 15s timeout; `SIGKILL` fallback in container-runner is reachable again.
- **fix:** Telegram bot-mention normalization (`@botUsername` → `@AssistantName`) now passes trigger gating in groups with custom triggers.
- **fix:** Agent-runner cache staleness detection replaced with recursive directory mtime scan.

## [1.2.19] — 2026-03-27 (fork: yanggf8/nanoclaw)

### Apple Container compatibility
- **fix:** Credential proxy now auto-detects the host bridge IP (`bridge100`) and binds there instead of `127.0.0.1`, making it reachable from containers. `CONTAINER_HOST_GATEWAY` is set to the same IP so containers resolve the proxy correctly. Both values support env overrides.
- **fix:** Removed `.env` file bind-mount shadow — Apple Container only supports directory mounts, not file mounts. Credentials are injected by the proxy so `.env` inside the container is never needed.
- **fix:** Credential proxy reads OAuth token fresh from `~/.claude/.credentials.json` on every auth request, so a `/login` in any Claude Code session is picked up immediately without a service restart. Falls back to `.env` value if the file is absent or expired.

### Scheduled task improvements
- **feat:** Exponential backoff retry for failed scheduled tasks: `min(5min × 2^(n-1), 60min)`. Once-tasks pause after 5 consecutive failures with a user notification.
- **fix:** Interval tasks now preserve their original cadence after a retry. Previously, overwriting `next_run` with the retry timestamp caused the interval to shift permanently (e.g. hourly task due at 10:00 fails → retries at 10:05 → next run becomes 11:05). Fixed by passing the pre-retry `next_run` as the anchor to `computeNextRun` on the success path, and using `updateTask` (not `updateTaskAfterRun`) on failure to avoid corrupting `last_run`.

### Config
- **fix:** `IDLE_TIMEOUT` default lowered from 30 min to 10 min to sit clearly below `CONTAINER_TIMEOUT` (20 min) and prevent the two from being confused.

### Maintenance
- **feat:** `scripts/check-token-expiry.mjs` — launchd job (`com.nanoclaw.token-check`) runs every 30 min and sends a Telegram warning when the Claude Code OAuth token expires within 90 minutes.
- **fix:** `launchd/com.nanoclaw.plist` — replaced hard-coded `ASSISTANT_NAME=Macclaw` with `{{ASSISTANT_NAME}}` placeholder, consistent with other template variables.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

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
