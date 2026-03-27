# Changelog

All notable changes to NanoClaw will be documented in this file.

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
