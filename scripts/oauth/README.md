# OAuth Token Refresh

Keeps the Claude API OAuth token in `.env` in sync with `~/.claude/.credentials.json`.

## How it works

Claude Code CLI manages OAuth credentials at `~/.claude/.credentials.json`, which contains:

- `accessToken` — short-lived (~8h), used for API calls
- `refreshToken` — long-lived, used by the CLI to obtain new access tokens
- `expiresAt` — epoch milliseconds when the access token expires

NanoClaw containers don't have access to this file. Instead, the host copies the access token
into `.env` (as `CLAUDE_CODE_OAUTH_TOKEN`), which gets mounted into containers.

### Refresh logic (`refresh.sh`)

1. Read `expiresAt` from credentials
2. **Token fresh** (>5 min remaining) → copy `accessToken` to `.env`, schedule next run
3. **Token expired** → run `claude -p "ok" --no-session-persistence` to trigger the CLI's
   internal refresh, re-read the updated credentials, copy to `.env`
4. **CLI refresh fails** → log error and exit (user needs `claude login`)

### Scheduling

The script schedules its own next run via `systemd-run --user`:
- Normal: 30 minutes before token expiry
- Token nearly expired: retry in 5 minutes

### Entry points

The script is invoked from three places:

| Caller | When | File |
|--------|------|------|
| Pre-flight check | Before each container spawn | `src/oauth.ts` |
| Auth error retry | After 401 from container | `src/index.ts`, `src/task-scheduler.ts` |
| IPC trigger | Container requests refresh | `src/ipc.ts` |

### Logs

All operations log to `logs/oauth-refresh.log`.

### Manual refresh

Run the script directly:

    bash scripts/oauth/refresh.sh

Or trigger from inside a container via IPC:

    echo '{"type":"refresh_oauth"}' > /workspace/ipc/tasks/refresh-oauth-$(date +%s).json
