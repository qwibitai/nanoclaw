# Gmail MCP Runbook

What to do when the agent says it can't read email bodies, or when
Telegram shows messages like:

> Gmail tools are no longer available in this session, so I can't read
> the email with thread ID …

## 0. Quick triage (60 seconds)

Run from the host:

```bash
cd ~/dev/nanoclaw
./scripts/check-gmail-mcp.sh
```

This dumps the OAuth token state and runs a probe. Possible outcomes:

| Output | Cause | Fix |
|---|---|---|
| `(directory missing inside container)` | Container started without the Gmail mount. Almost certainly a bug — check `src/container-runner.ts` mount logic. | Restart the host service. |
| `minutes_until_expiry: -X.X` (negative) | Access token expired and the in-container refresh failed. | Run `python3 scripts/refresh-gmail-tokens.py` on the host (rewrites the credentials.json that's bind-mounted into the container). |
| `(probe failed — see error above)` with "ECONNREFUSED" or "fetch failed" | Container has no outbound network OR the npx fetch for the gmail-mcp package failed. | Check `docker logs <container>` for npm errors. May need to pre-bake the gmail-mcp into the container image (separate task). |
| `(credentials.json missing)` | Account was never authorized OR credentials file was deleted. | Re-authorize manually (see section 2 below). |
| Tool list returns successfully but the agent still says "unavailable" | The MCP is healthy but the agent's model context lost the tool registration. | Send the agent a new message — the next container spawn will re-register tools. |

## 1. Pre-emptively refresh tokens (no downtime)

Run anytime — safe to run during normal operation. Refreshes only the
accounts that are within 5 minutes of expiry; no-op for accounts with
plenty of time left.

```bash
python3 ~/dev/nanoclaw/scripts/refresh-gmail-tokens.py
```

Exit codes:
- 0: All accounts checked, all good
- 2: At least one account is missing credentials.json (expected for
     accounts you haven't authorized yet — attaxion, dev)
- 3: At least one refresh failed (refresh_token revoked, network, etc.)
     — see section 2 to manually re-auth that account

## 2. Manually re-authorize a Gmail account

If a refresh_token is revoked (Google does this if you change your
password, sign out everywhere, or hit the "Manage third-party access"
revoke button), the only fix is to re-run the OAuth flow from scratch.

```bash
# 1. Make sure the OAuth client config is in place
ls ~/.gmail-mcp/gcp-oauth.keys.json            # personal  — ACTIVE
ls ~/.gmail-mcp-jonathan/gcp-oauth.keys.json   # whoisxml  — inert (see note)
ls ~/.gmail-mcp-attaxion/gcp-oauth.keys.json   # attaxion  — inert (see note)
ls ~/.gmail-mcp-dev/gcp-oauth.keys.json        # dev       — inert (see note)

# 2. Run the gmail-mcp's auth helper (opens a browser)
cd ~/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth

# 3. To re-auth any other account, the current package forces you to
#    temporarily rename your ~/.gmail-mcp to ~/.gmail-mcp.bak, then
#    symlink the target account's dir as ~/.gmail-mcp, run the auth flow,
#    restore, and move the new credentials.json into the target account
#    dir. This is clunky because the upstream package is hard-coded to a
#    single directory. Example for jonathan:
#
#      mv ~/.gmail-mcp ~/.gmail-mcp.personal-bak
#      cp -R ~/.gmail-mcp-jonathan ~/.gmail-mcp
#      cd ~/.gmail-mcp && npx -y @gongrzhe/server-gmail-autoauth-mcp auth
#      cp ~/.gmail-mcp/credentials.json ~/.gmail-mcp-jonathan/credentials.json
#      rm -rf ~/.gmail-mcp
#      mv ~/.gmail-mcp.personal-bak ~/.gmail-mcp
```

After re-auth, `credentials.json` will be regenerated with a fresh
refresh_token. Confirm with section 1's refresh script.

> **Note (IMPORTANT):** The in-container `@gongrzhe/server-gmail-autoauth-mcp`
> package is hard-coded to a single account directory (`~/.gmail-mcp`), so
> even though jonathan, attaxion, and dev directories can be authorized on
> disk, **only personal is reachable from the agent today**. Authorizing the
> other accounts is forward-compat work — it prepares the credentials but
> does not yet expose the tools to the agent. Multi-account would require
> launching one MCP server instance per account with distinct
> `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` env vars (future task).

## 3. Force-restart the active container (clean slate)

If the container is wedged but you don't want to bounce the whole host:

```bash
# Find the stuck container
docker ps --filter name=nanoclaw- --format '{{.Names}}'

# Send the close sentinel (graceful)
touch ~/dev/nanoclaw/data/ipc/<group>/input/_close

# Hard stop if it doesn't exit within 30s
docker stop -t 5 <container-name>
```

The next agent trigger will spawn a fresh container with refreshed tokens.

## 4. Bounce the whole host (last resort)

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
launchctl list | grep com.nanoclaw   # should show a new PID
tail -f ~/dev/nanoclaw/logs/nanoclaw.log
```

## How to tell if the fixes are working

After this runbook's commits ship, the morning briefing should:

- Print no `GMAIL-DEGRADED:` lines on a normal day
- If Gmail does fail, the briefing prints the LITERAL failure (not an
  invented reason like "bot token not configured") and labels each
  affected email with `[CLASSIFIED FROM SUBJECT ONLY]`
- The host log should show `gmail-token-refresh: all accounts ok` (debug
  level) before each email-trigger spawn
- The host log should show `Gmail account directory present but no
  credentials.json — skipping mount` at info level (once per process)
  for each unauthorized account
