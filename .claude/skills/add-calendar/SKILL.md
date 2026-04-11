---
name: add-calendar
description: Add Google Calendar integration to NanoClaw. The agent can list, search, create, update, and delete events via the @cocal/google-calendar-mcp server. Uses OAuth 2.0; credentials live on the host and are mounted read-write into the container.
---

# Add Google Calendar

This skill wires up [`@cocal/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp) so the NanoClaw agent can manage the user's Google Calendar as a tool. It is a **tool integration**, not a channel — no calendar events trigger the agent automatically; the agent reaches for calendar tools when asked (or when scheduled tasks instruct it to).

## What this adds

- `mcp__gcal__*` tools in the agent's allowedTools (list-events, search-events, create-event, update-event, delete-event, list-calendars, get-current-time, etc.)
- A conditional mount for `~/.config/google-calendar-mcp` → `/home/node/.config/google-calendar-mcp` (read-write so the MCP can refresh OAuth tokens)
- The `gcal` MCP server in the agent-runner, registered only when the credentials directory exists on the host

If the user doesn't install the OAuth credentials, **nothing changes** — the mount is skipped and the MCP server is not registered. Calendar is opt-in at the filesystem level, no env var flag required.

## Prerequisites

- A Google account with a calendar
- A Google Cloud project with the **Google Calendar API** enabled
- An **OAuth 2.0 Desktop application** credential (client ID + secret)
- Node.js (already required by NanoClaw)
- Container runtime running (Docker or Apple Container)

## Phase 1: Google Cloud setup

Walk the user through creating GCP OAuth credentials. If they already have `~/.config/google-calendar-mcp/gcp-oauth.keys.json` with a real client ID (not a template), skip to Phase 2.

1. Open [console.cloud.google.com](https://console.cloud.google.com) in a browser.
2. Create a new project or select an existing one.
3. **APIs & Services → Library**, search for `Google Calendar API`, enable it.
4. **APIs & Services → OAuth consent screen** (if not configured yet):
   - User type: **External**
   - Fill in the required fields (app name, support email, developer email)
   - Add the user's email as a **test user** on the next screen
5. **APIs & Services → Credentials → + CREATE CREDENTIALS → OAuth client ID**
   - Application type: **Desktop app**
   - Name: something descriptive (e.g. "NanoClaw Calendar")
   - **DOWNLOAD JSON**
6. Save the downloaded file as:

   ```
   ~/.config/google-calendar-mcp/gcp-oauth.keys.json
   ```

   Create the directory if it doesn't exist:

   ```bash
   mkdir -p ~/.config/google-calendar-mcp
   chmod 700 ~/.config/google-calendar-mcp
   # Then move/copy the downloaded JSON file there:
   mv ~/Downloads/client_secret_*.json ~/.config/google-calendar-mcp/gcp-oauth.keys.json
   chmod 600 ~/.config/google-calendar-mcp/gcp-oauth.keys.json
   ```

   If the user pasted the OAuth `client_id` and `client_secret` values inline instead of the JSON file, write the file manually with this schema:

   ```json
   {
     "installed": {
       "client_id": "<client-id>",
       "project_id": "<gcp-project-id>",
       "auth_uri": "https://accounts.google.com/o/oauth2/auth",
       "token_uri": "https://oauth2.googleapis.com/token",
       "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
       "client_secret": "<client-secret>",
       "redirect_uris": ["http://localhost"]
     }
   }
   ```

## Phase 2: OAuth authorization

Run the interactive auth flow on the host. This opens a local HTTP server, pops a browser for consent, and stores the resulting refresh token in `~/.config/google-calendar-mcp/tokens.json`:

```bash
GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json \
  npx -y @cocal/google-calendar-mcp auth
```

**In the browser:**

1. Pick the target Google account
2. Click through the "Google hasn't verified this app" warning: **Advanced → Go to \<app name\> (unsafe)** — this is normal for personal OAuth apps still in test mode
3. Grant the requested calendar permissions
4. The browser should show "Authentication successful, you can close this tab"

Verify:

```bash
ls -la ~/.config/google-calendar-mcp/
# Expect: gcp-oauth.keys.json  tokens.json  (both 600)
chmod 600 ~/.config/google-calendar-mcp/tokens.json  # tighten if loose
```

## Phase 3: Rebuild and restart

The agent-runner conditionally registers the `gcal` MCP server when the mount is present, so you need to rebuild the container image so it picks up the new code paths, and restart the service so the new mount takes effect.

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

Check the next container run's logs for `Google Calendar MCP server configured` in the agent-runner output (found via `tail -f groups/<folder>/logs/container-*.log`, or during the next agent invocation).

## Phase 4: Verify

Have the user send one of these messages in their main NanoClaw chat:

- `What's on my calendar today?`
- `List my calendars`
- `Create a test event for tomorrow at 10 AM called "calendar test"`

The agent should invoke `mcp__gcal__list-events`, `mcp__gcal__list-calendars`, or `mcp__gcal__create-event` respectively. For create/update/delete operations, the agent should confirm with the user before committing.

## Troubleshooting

### "Cannot find module '@cocal/google-calendar-mcp'"

The MCP package downloads on first use via `npx -y`. Check that the container has internet access on startup. If the container is offline, preinstall the package by adding `RUN npm install -g @cocal/google-calendar-mcp` to `container/Dockerfile` and rebuilding.

### "invalid_grant" or "Token has been expired or revoked"

Refresh tokens can expire if the OAuth app is still in test mode and more than 7 days have passed, or if the user revoked access. Re-run Phase 2 to mint a new refresh token:

```bash
rm ~/.config/google-calendar-mcp/tokens.json
GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json \
  npx -y @cocal/google-calendar-mcp auth
```

To avoid the 7-day test mode limit, publish the OAuth consent screen in GCP (it stays in production after user verification).

### Agent doesn't seem to have calendar tools

1. Verify the mount is active: `ls /home/node/.config/google-calendar-mcp/` inside a running container (via `container exec` or equivalent).
2. Check agent-runner logs for the `Google Calendar MCP server configured` line. If missing, the conditional probably did not match — confirm the host directory actually exists and the container image was rebuilt after this skill was applied.
3. Confirm `mcp__gcal__*` is in `allowedTools` by inspecting `container/agent-runner/src/index.ts` at runtime, or by asking the agent to list its available tools.

## Removal

1. Delete the credentials directory: `rm -rf ~/.config/google-calendar-mcp/`
2. Rebuild and restart — the conditional mount/registration will no-op now that the directory is gone.
3. Optionally revoke the OAuth app access in [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
