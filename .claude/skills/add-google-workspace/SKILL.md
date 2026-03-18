---
name: add-google-workspace
description: Add Google Workspace MCP integration to NanoClaw. Supports Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, Apps Script, and Custom Search. Users pick which services they need. Guides through GCP OAuth setup and implements the integration.
---

# Add Google Workspace Integration

This skill adds Google Workspace capabilities to NanoClaw via the [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) server. The agent gains access to Google services as MCP tools, running inside the container.

## Phase 1: Pre-flight

### Check if already configured

Check if Google Workspace is already set up:

```bash
ls -la ~/.workspace-mcp/ 2>/dev/null || echo "No Workspace config found"
grep -q 'google_workspace_mcp' container/Dockerfile 2>/dev/null && echo "Dockerfile already has workspace MCP" || echo "Dockerfile needs workspace MCP"
grep -q 'mcp__workspace__' container/agent-runner/src/index.ts 2>/dev/null && echo "Agent runner already configured" || echo "Agent runner needs workspace MCP"
```

If all three are configured and `~/.workspace-mcp/credentials/` has token files, skip to Phase 6 (Verify).

### Select Google services

Use `AskUserQuestion` with three multiSelect questions to let the user pick which services they want:

**Question 1: Core Productivity** (multiSelect)
- **Gmail** - Read, send, search, draft, and manage emails
- **Google Calendar** - Create events, check availability, manage calendars
- **Google Drive** - Search, read, create, and share files
- **Google Tasks** - Create, update, and manage task lists

**Question 2: Document Suite** (multiSelect)
- **Google Docs** - Create, read, and edit documents
- **Google Sheets** - Create, read, and update spreadsheets
- **Google Slides** - Create and update presentations
- **Google Forms** - Create forms and manage responses

**Question 3: Communication & Advanced** (multiSelect)
- **Google Chat** - Send messages in Google Chat spaces
- **Google Contacts** - Search and manage contacts via People API
- **Google Apps Script** - Execute and manage Apps Script projects
- **Custom Search** - Programmatic Google Search via Custom Search API

Store the user's selections. These determine:
1. Which APIs to enable in Google Cloud
2. Which `--tools` flags to pass to the MCP server
3. Which OAuth scopes are requested during authorization

### Service-to-API mapping

Reference this table throughout the skill:

| Service | Google Cloud API to Enable | `--tools` flag |
|---------|---------------------------|----------------|
| Gmail | Gmail API | `gmail` |
| Calendar | Google Calendar API | `calendar` |
| Drive | Google Drive API | `drive` |
| Tasks | Tasks API | `tasks` |
| Docs | Google Docs API | `docs` |
| Sheets | Google Sheets API | `sheets` |
| Slides | Google Slides API | `slides` |
| Forms | Google Forms API | `forms` |
| Chat | Google Chat API | `chat` |
| Contacts | People API | `contacts` |
| Apps Script | Apps Script API | `gappsscript` |
| Search | Custom Search JSON API | `search` |

---

## Phase 2: Google Cloud Project Setup

**USER ACTION REQUIRED**

Guide the user step by step. Wait for confirmation between steps.

### Step 1: Create or select a Google Cloud project

Tell the user:

> I need you to set up Google Cloud OAuth credentials for the Workspace integration. Let me walk you through it.
>
> 1. Open https://console.cloud.google.com in your browser
> 2. Click the project dropdown at the top of the page
> 3. Either select an existing project or click **New Project**
>    - If creating new: name it something like "NanoClaw" and click **Create**
> 4. Make sure your new/selected project is active (shown in the top bar)

Wait for confirmation.

### Step 2: Enable required APIs

Based on the services the user selected, tell them exactly which APIs to enable:

> Now enable the APIs for your selected services:
>
> 1. In the left sidebar, go to **APIs & Services > Library**
> 2. For each API below, search for it, click on it, then click **Enable**:

List only the APIs matching their selected services from the mapping table above.

> **Tip:** You can also enable APIs via the search bar at the top of the Cloud Console.

Wait for confirmation.

### Step 3: Configure OAuth consent screen

Tell the user:

> Before creating credentials, you need to configure the OAuth consent screen:
>
> 1. Go to **APIs & Services > OAuth consent screen** in the left sidebar
> 2. Select **External** as the user type (unless you have a Google Workspace org, then choose **Internal**)
> 3. Click **Create**
> 4. Fill in the required fields:
>    - **App name:** NanoClaw (or anything you like)
>    - **User support email:** Your email address
>    - **Developer contact:** Your email address
> 5. Click **Save and Continue** through the remaining steps (Scopes, Test Users, Summary)
>
> **Important:** If you chose External, your app will be in "Testing" mode. You'll need to add your Google account as a test user:
>
> 1. On the OAuth consent screen page, find **Test users**
> 2. Click **+ Add Users**
> 3. Enter the Google email address you'll use with NanoClaw
> 4. Click **Save**

Wait for confirmation.

### Step 4: Create OAuth credentials

Tell the user:

> Now create the OAuth client credentials:
>
> 1. Go to **APIs & Services > Credentials** in the left sidebar
> 2. Click **+ CREATE CREDENTIALS** at the top
> 3. Select **OAuth client ID**
> 4. For **Application type**, select **Desktop app**
> 5. Name it anything (e.g., "NanoClaw Workspace")
> 6. Click **Create**
> 7. You'll see a popup with your **Client ID** and **Client secret**
> 8. Copy both values — you'll need them in the next step
>
> **Alternative:** Click **DOWNLOAD JSON** to get a file with both values.

Wait for the user to provide the Client ID and Client secret.

### Step 5: Store credentials

Create the workspace MCP directory and save credentials:

```bash
mkdir -p ~/.workspace-mcp/credentials
```

Add the client ID and secret to the project's `.env` file. These are read by `readSecrets()` in `src/container-runner.ts` and passed to the container via stdin — they never appear as environment variables or mounted files:

```bash
# Append to .env (create if it doesn't exist)
echo 'GOOGLE_OAUTH_CLIENT_ID=<client-id-from-user>' >> .env
echo 'GOOGLE_OAUTH_CLIENT_SECRET=<client-secret-from-user>' >> .env
```

---

## Phase 3: OAuth Authorization

The workspace MCP needs an initial OAuth authorization to get refresh tokens.

### Clone the workspace MCP locally

Check if it's already available:

```bash
if [ -d ~/.workspace-mcp/google_workspace_mcp ]; then
  echo "Already cloned"
else
  git clone --depth 1 https://github.com/taylorwilsdon/google_workspace_mcp.git ~/.workspace-mcp/google_workspace_mcp
fi
```

Install uv (Python package manager) if not available, then install dependencies (requires Python 3.10+):

```bash
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
cd ~/.workspace-mcp/google_workspace_mcp && uv sync
```

Verify the available tool flags match the user's selections:

```bash
cd ~/.workspace-mcp/google_workspace_mcp && uv run main.py --help
```

### Run the authorization flow

Tell the user:

> I'm going to start the Google Workspace authorization. A browser window will open asking you to sign in to your Google account and grant access.
>
> **Important:** If you see a warning that the app isn't verified, click **Advanced** then **Go to NanoClaw (unsafe)**. This is normal for personal OAuth apps in testing mode.

Read the `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` values from the project's `.env` file, then run the auth flow with the selected services:

```bash
cd ~/.workspace-mcp/google_workspace_mcp
GOOGLE_OAUTH_CLIENT_ID="<client-id-value>" \
GOOGLE_OAUTH_CLIENT_SECRET="<client-secret-value>" \
WORKSPACE_MCP_CREDENTIALS_DIR="$HOME/.workspace-mcp/credentials" \
OAUTHLIB_INSECURE_TRANSPORT=1 \
uv run main.py --single-user --tools <selected-tools-space-separated>
```

`OAUTHLIB_INSECURE_TRANSPORT=1` is required because the local OAuth redirect uses `http://localhost` — this is safe for local authorization.

Tell the user:

> Complete the authorization in your browser. You'll be asked to grant access to the services you selected. After approving, the tokens are saved automatically. Let me know when you've completed it.

Verify tokens were saved:

```bash
ls -la ~/.workspace-mcp/credentials/
```

If credential files exist, authorization was successful. Stop the auth server (Ctrl+C).

---

## Phase 4: Code Changes

### Step 1: Add workspace MCP to the Dockerfile

Read `container/Dockerfile` and find the `apt-get install` block.

Add `python3 python3-pip python3-venv` to the package list if not already present. The `curl` and `git` packages should already be there.

Then add the workspace MCP installation. Insert these lines after the `apt-get` block and its `rm -rf` cleanup, before the Chromium `ENV` lines:

```dockerfile
# Install uv (Python package manager) and google_workspace_mcp
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
RUN git clone --depth 1 https://github.com/taylorwilsdon/google_workspace_mcp.git /opt/google_workspace_mcp \
    && cd /opt/google_workspace_mcp && uv sync
```

### Step 2: Add workspace MCP to the agent runner

Read `container/agent-runner/src/index.ts` and find the `mcpServers` object inside the `query()` call.

Add `workspace` to the `mcpServers` object alongside the existing entries:

```typescript
workspace: {
  command: '/opt/google_workspace_mcp/.venv/bin/python',
  args: [
    '/opt/google_workspace_mcp/main.py',
    '--single-user',
    '--tools', 'SELECTED', 'TOOLS', 'HERE',
  ],
  env: {
    GOOGLE_OAUTH_CLIENT_ID: (sdkEnv.GOOGLE_OAUTH_CLIENT_ID as string) || '',
    GOOGLE_OAUTH_CLIENT_SECRET: (sdkEnv.GOOGLE_OAUTH_CLIENT_SECRET as string) || '',
    WORKSPACE_MCP_CREDENTIALS_DIR: '/home/node/.workspace-mcp/credentials',
    OAUTHLIB_INSECURE_TRANSPORT: '1',
  },
},
```

Replace `'SELECTED', 'TOOLS', 'HERE'` with the actual services the user chose — each as a separate string in the args array. For example, if they selected gmail, calendar, drive, docs:

```typescript
'--tools', 'gmail', 'calendar', 'drive', 'docs',
```

Find the `allowedTools` array in the same `query()` call and add:

```typescript
'mcp__workspace__*',
```

### Step 3: Mount workspace credentials in container

Read `src/container-runner.ts`.

Ensure `os` is imported at the top of the file. If not already present, add:

```typescript
import os from 'os';
```

Find the `buildVolumeMounts` function and add this mount block before `return mounts`. If there's already a `homeDir` variable in scope, use it; otherwise use `os.homedir()` directly:

```typescript
// Google Workspace MCP credentials
const workspaceDir = path.join(os.homedir(), '.workspace-mcp');
if (fs.existsSync(workspaceDir)) {
  mounts.push({
    hostPath: workspaceDir,
    containerPath: '/home/node/.workspace-mcp',
    readonly: false, // Token refresh needs write access
  });
}
```

**Note:** This mounts workspace credentials into every group's container. If you have per-group tool restrictions via `containerConfig.allowedTools`, consider guarding this mount behind a check that the group's allowed tools include `mcp__workspace__*`.

Find the `readSecrets` function and add the Google OAuth keys to the array:

```typescript
'GOOGLE_OAUTH_CLIENT_ID',
'GOOGLE_OAUTH_CLIENT_SECRET',
```

### Step 4: Update group memory

Append a section to `groups/global/CLAUDE.md` (or `groups/main/CLAUDE.md` if no global exists) documenting the available workspace tools. Only include the services the user selected.

The available MCP tools follow the pattern `mcp__workspace__<action>`. The tool names below are examples — discover the actual names by checking the MCP server's output when it starts. Common tools by service:

**Gmail:** `gmail_send`, `gmail_search`, `gmail_read`, `gmail_draft`, `gmail_list_labels`, `gmail_modify_labels`, `gmail_delete`, `gmail_batch_delete`

**Calendar:** `calendar_list`, `calendar_get_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_find_free_time`

**Drive:** `drive_search_files`, `drive_read_file`, `drive_create_file`, `drive_update_file`, `drive_share_file`

**Docs:** `docs_create_document`, `docs_read_document`, `docs_update_document`

**Sheets:** `sheets_create_spreadsheet`, `sheets_read_spreadsheet`, `sheets_update_spreadsheet`

**Slides:** `slides_create_presentation`, `slides_update_presentation`, `slides_get_presentation`

**Forms:** `forms_create_form`, `forms_update_form`, `forms_get_responses`

**Tasks:** `tasks_list`, `tasks_create`, `tasks_update`, `tasks_delete`

**Contacts:** `contacts_search`, `contacts_get`, `contacts_create`

**Chat:** `chat_send_message`, `chat_list_spaces`, `chat_create_space`

**Apps Script:** `gappsscript_list_projects`, `gappsscript_run_function`, `gappsscript_create_project`

**Search:** `search_google`

Example CLAUDE.md section:

```markdown
## Google Workspace

You have access to Google Workspace via MCP tools (prefix: `mcp__workspace__`):
- **Calendar**: List events, create events, check free time
- **Drive**: Search and read files, create and share documents
- **Docs**: Create, read, and edit Google Docs

All workspace tools are available via the `mcp__workspace__` prefix.
```

---

## Phase 5: Build and Restart

### Rebuild the container

The Dockerfile changed, so a container rebuild is required:

```bash
./container/build.sh
```

Wait for the build to complete.

### Compile TypeScript

```bash
npm run build
```

### Restart the service

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:
```bash
systemctl --user restart nanoclaw
```

Verify it started:

```bash
sleep 2 && launchctl list | grep nanoclaw  # macOS
# Linux: systemctl --user status nanoclaw
```

---

## Phase 6: Verify

### Test the integration

Tell the user to test via their messaging channel. Suggest a test based on their selected services:

- **Calendar:** "What's on my calendar today?"
- **Gmail:** "Check my recent unread emails"
- **Drive:** "Search my Drive for recent files"
- **Tasks:** "Show my task lists"
- **Contacts:** "Search my contacts for John"
- **Docs:** "Create a new Google Doc titled Test"

### Check logs if there are issues

```bash
tail -50 logs/nanoclaw.log | grep -i -E "(workspace|workspace_mcp|google)"
```

Container-level logs:

```bash
ls -t groups/main/logs/container-*.log | head -1 | xargs cat | grep -i workspace
```

---

## Troubleshooting

### OAuth token expired or invalid

Re-run the authorization flow from the NanoClaw project root:

```bash
GOOGLE_OAUTH_CLIENT_ID="$(grep GOOGLE_OAUTH_CLIENT_ID .env | cut -d= -f2)" \
GOOGLE_OAUTH_CLIENT_SECRET="$(grep GOOGLE_OAUTH_CLIENT_SECRET .env | cut -d= -f2)" \
WORKSPACE_MCP_CREDENTIALS_DIR="$HOME/.workspace-mcp/credentials" \
OAUTHLIB_INSECURE_TRANSPORT=1 \
~/.workspace-mcp/google_workspace_mcp/.venv/bin/python \
~/.workspace-mcp/google_workspace_mcp/main.py --single-user --tools <selected-tools>
```

Authorize in the browser, then Ctrl+C and restart NanoClaw.

### "App not verified" warning in browser

This is normal for personal OAuth apps. Click **Advanced** > **Go to NanoClaw (unsafe)**.

### API not enabled errors

Check container logs for errors like `Google API Error: ... has not been used in project ... or it is disabled`. Enable the missing API in Google Cloud Console:

1. Go to https://console.cloud.google.com/apis/library
2. Search for the API mentioned in the error
3. Click **Enable**

### Container can't access workspace credentials

Verify the mount exists:

```bash
ls -la ~/.workspace-mcp/
ls -la ~/.workspace-mcp/credentials/
```

Check that `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are in `.env`:

```bash
grep GOOGLE_OAUTH .env
```

### Workspace MCP fails to start inside container

Check that the Dockerfile properly installed the MCP. Look at container logs for Python or import errors:

```bash
ls -t groups/main/logs/container-*.log | head -1 | xargs tail -50
```

If missing from the image, rebuild the container with a clean cache:

```bash
docker builder prune -f  # Clear stale build cache
./container/build.sh
```

### Adding more services later

To add a service you didn't select initially:

1. Enable the API in Google Cloud Console
2. Add the tool flag to the `--tools` argument in `container/agent-runner/src/index.ts`
3. Re-run the OAuth flow to get tokens with the new scopes
4. Rebuild the container: `cd container && ./build.sh`
5. Restart NanoClaw

### Removing a service

To remove a specific service:

1. Remove it from the `--tools` argument in `container/agent-runner/src/index.ts`
2. Rebuild: `./container/build.sh && npm run build`
3. Restart NanoClaw

---

## Removing Google Workspace Entirely

1. Remove from `container/Dockerfile`:
   - Delete the `python3 python3-pip python3-venv` packages from the `apt-get install` block (if nothing else needs them)
   - Delete the uv installation and `google_workspace_mcp` clone lines

2. Remove from `container/agent-runner/src/index.ts`:
   - Delete `mcp__workspace__*` from the `allowedTools` array
   - Delete the `workspace` entry from the `mcpServers` object

3. Remove from `src/container-runner.ts`:
   - Delete the `~/.workspace-mcp` mount block
   - Remove `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from `readSecrets`

4. Remove from `.env`:
   - Delete `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`

5. Remove workspace sections from `groups/*/CLAUDE.md`

6. Rebuild:
   ```bash
   ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

7. Optionally clean up local auth:
   ```bash
   rm -rf ~/.workspace-mcp/
   ```
