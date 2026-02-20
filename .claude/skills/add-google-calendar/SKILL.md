---
name: add-google-calendar
description: Add Google Calendar integration to NanoClaw. Agent can list, search, create, update, and delete calendar events when triggered from WhatsApp. Guides through GCP OAuth setup and implements the integration.
---

# Add Google Calendar Integration

This skill adds Google Calendar capabilities to NanoClaw as a **Tool Mode** integration — the agent can read and manage calendar events when asked from WhatsApp (e.g., "@Claw what's on my calendar today?" or "@Claw schedule a meeting tomorrow at 3pm").

Uses the `@cocal/google-calendar-mcp` package (most popular Google Calendar MCP, 500+ GitHub stars).

---

## Prerequisites

### 1. Check Existing Calendar Setup

First, check if Google Calendar is already configured:

```bash
ls -la ~/.google-calendar-mcp/ 2>/dev/null || echo "No Google Calendar config found"
```

If `gcp-oauth.keys.json` exists and auth tokens are present, skip to "Verify Calendar Access" below.

### 2. Create Config Directory

```bash
mkdir -p ~/.google-calendar-mcp
```

### 3. GCP Project Setup

**USER ACTION REQUIRED**

First check if the user already has a GCP project with OAuth credentials (e.g., from Gmail setup):

```bash
ls ~/.gmail-mcp/gcp-oauth.keys.json 2>/dev/null || ls ~/.google-calendar-mcp/gcp-oauth.keys.json 2>/dev/null || echo "No existing OAuth keys found"
```

**If credentials exist from Gmail or another Google integration:**

The user can reuse the same GCP project and OAuth client ID. They just need to:

1. Enable the Google Calendar API in the same GCP project
2. Copy the keys file

Tell the user:

> You already have a GCP project set up. You just need to enable the Google Calendar API in the same project:
>
> 1. Open https://console.cloud.google.com
> 2. Select the same project you used for Gmail (check the project dropdown at top)
> 3. Go to **APIs & Services → Library**
> 4. Search for "Google Calendar API"
> 5. Click on it, then click **Enable**

Wait for confirmation, then copy the keys:

```bash
cp ~/.gmail-mcp/gcp-oauth.keys.json ~/.google-calendar-mcp/gcp-oauth.keys.json
```

**If no credentials exist**, guide the user through full GCP setup:

> I need you to set up Google Cloud OAuth credentials. I'll walk you through it:
>
> 1. Open https://console.cloud.google.com in your browser
> 2. Create a new project (or select existing) - click the project dropdown at the top

Wait for user confirmation, then continue:

> 3. Now enable the Google Calendar API:
>    - In the left sidebar, go to **APIs & Services → Library**
>    - Search for "Google Calendar API"
>    - Click on it, then click **Enable**

Wait for user confirmation, then continue:

> 4. Now create OAuth credentials:
>    - Go to **APIs & Services → Credentials** (in the left sidebar)
>    - Click **+ CREATE CREDENTIALS** at the top
>    - Select **OAuth client ID**
>    - If prompted for consent screen, choose "External", fill in app name (e.g., "NanoClaw"), your email as test user, and save
>    - For Application type, select **Desktop app** (important!)
>    - Name it anything (e.g., "NanoClaw Calendar")
>    - Click **Create**

Wait for user confirmation, then continue:

> 5. Download the credentials:
>    - Click **DOWNLOAD JSON** on the popup (or find it in the credentials list and click the download icon)
>    - Save it as `gcp-oauth.keys.json`
>
> Where did you save the file? (Give me the full path, or just paste the file contents here)

If user provides a path, copy it:

```bash
cp "/path/user/provided/gcp-oauth.keys.json" ~/.google-calendar-mcp/gcp-oauth.keys.json
```

If user pastes the JSON content, write it to `~/.google-calendar-mcp/gcp-oauth.keys.json`.

### 4. OAuth Authorization

**USER ACTION REQUIRED**

Tell the user:

> I'm going to run the Google Calendar authorization. A browser window will open asking you to sign in to Google and grant calendar access.
>
> **Important:** If you see a warning that the app isn't verified, click "Advanced" then "Go to [app name] (unsafe)" - this is normal for personal OAuth apps.

Run the authorization:

```bash
GOOGLE_OAUTH_CREDENTIALS=~/.google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp
```

This will start the MCP server and trigger the OAuth flow in the browser. Once the user authorizes, the token is stored automatically.

If the above doesn't trigger a browser auth, try:

```bash
GOOGLE_OAUTH_CREDENTIALS=~/.google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
```

Tell user:
> Complete the authorization in your browser. Let me know when you've authorized.

### 5. Verify Calendar Access

Test that the MCP server responds:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | GOOGLE_OAUTH_CREDENTIALS=~/.google-calendar-mcp/gcp-oauth.keys.json timeout 15 npx -y @cocal/google-calendar-mcp 2>/dev/null | head -20 || echo "MCP responded (check output above)"
```

If you see tool names like `list-calendars`, `list-events`, `create-event`, etc., the setup is working.

---

## Tool Mode Implementation

### Step 1: Add Google Calendar MCP to Agent Runner

Read `container/agent-runner/src/index.ts` and find the `mcpServers` config in the `query()` call.

Add `google_calendar` to the `mcpServers` object:

```typescript
google_calendar: {
  command: 'npx',
  args: ['-y', '@cocal/google-calendar-mcp'],
  env: {
    GOOGLE_OAUTH_CREDENTIALS: '/home/node/.google-calendar-mcp/gcp-oauth.keys.json',
  },
},
```

Find the `allowedTools` array and add:

```typescript
'mcp__google_calendar__*'
```

### Step 2: Mount Calendar Credentials in Container

Read `src/container-runner.ts` and find the `buildVolumeMounts` function.

Add this mount block (before the per-group sessions directory section, near any existing Google credential mounts):

```typescript
// Google Calendar credentials directory
const calendarDir = path.join(homeDir, '.google-calendar-mcp');
if (fs.existsSync(calendarDir)) {
  mounts.push({
    hostPath: calendarDir,
    containerPath: '/home/node/.google-calendar-mcp',
    readonly: false,  // MCP may need to refresh tokens
  });
}
```

### Step 3: Update Group Memory

Append to `groups/global/CLAUDE.md`:

```markdown

## Calendar (Google Calendar)

You have access to Google Calendar via MCP tools:
- `mcp__google_calendar__list-calendars` - List all calendars
- `mcp__google_calendar__list-events` - List upcoming events
- `mcp__google_calendar__search-events` - Search events by keyword
- `mcp__google_calendar__get-event` - Get event details
- `mcp__google_calendar__create-event` - Create a new event
- `mcp__google_calendar__update-event` - Update an existing event
- `mcp__google_calendar__delete-event` - Delete an event
- `mcp__google_calendar__get-freebusy` - Check availability
- `mcp__google_calendar__get-current-time` - Get current time in a timezone

Example: "What's on my calendar today?" or "Schedule a meeting tomorrow at 3pm with title 'Team Standup'"
```

Also append the same section to `groups/main/CLAUDE.md`.

### Step 4: Rebuild and Restart

Rebuild the container (agent-runner changed):

```bash
cd container && ./build.sh
```

Compile TypeScript (host code changed):

```bash
cd .. && npm run build
```

Restart the service. Detect the platform and use the appropriate command:

- **Linux (systemd):** `systemctl --user restart nanoclaw.service`
- **macOS (launchd):** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

Verify it started:

- **Linux:** `systemctl --user status nanoclaw.service`
- **macOS:** `launchctl list | grep nanoclaw`

### Step 5: Test Calendar Integration

Tell the user:

> Google Calendar integration is set up! Test it by sending a message in your WhatsApp main channel:
>
> `@Claw what's on my calendar today?`
>
> Or:
>
> `@Claw list my calendars`

Watch the logs for any errors:

```bash
tail -f logs/nanoclaw.log
```

---

## Troubleshooting

### Calendar MCP not responding
```bash
# Test Google Calendar MCP directly
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | GOOGLE_OAUTH_CREDENTIALS=~/.google-calendar-mcp/gcp-oauth.keys.json timeout 15 npx -y @cocal/google-calendar-mcp 2>/dev/null | head -20
```

### OAuth token expired
The `@cocal/google-calendar-mcp` package auto-refreshes tokens. If auth is broken:

```bash
# Clear stored tokens and re-authorize
GOOGLE_OAUTH_CREDENTIALS=~/.google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp auth
```

### Container can't access Calendar
- Verify `~/.google-calendar-mcp` is mounted in container
- Check that `GOOGLE_OAUTH_CREDENTIALS` env var is set in the mcpServers config
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

### "Calendar API not enabled" error
- Go to https://console.cloud.google.com → APIs & Services → Library
- Search for "Google Calendar API" and make sure it's enabled

---

## Removing Google Calendar Integration

To remove Google Calendar entirely:

1. Remove from `container/agent-runner/src/index.ts`:
   - Delete `google_calendar` from `mcpServers`
   - Remove `mcp__google_calendar__*` from `allowedTools`

2. Remove from `src/container-runner.ts`:
   - Delete the `~/.google-calendar-mcp` mount block

3. Remove Calendar sections from `groups/*/CLAUDE.md`

4. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   # Linux: systemctl --user restart nanoclaw.service
   # macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
