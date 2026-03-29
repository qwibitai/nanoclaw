# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.19] — 2026-03-29 (fork: yanggf8/nanoclaw)

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

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
