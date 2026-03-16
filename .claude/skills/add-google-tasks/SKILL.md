---
name: add-google-tasks
description: Add Google Tasks integration to NanoClaw. Installs a local gtasks-mcp server, wires it into the agent container, sets up GCP OAuth, and creates a daily 7am morning reminder with overdue and due-today tasks. Triggers on "add google tasks", "google tasks", "setup google tasks", or "tasks integration".
---

# Add Google Tasks Integration

This skill wires Google Tasks into the NanoClaw agent container as a fully accessible MCP tool, and creates a daily 07:00 cron task that sends a morning summary of overdue and due-today tasks to the main WhatsApp group.

## Phase 1 — Pre-flight

### Check if already applied

Read src/container-runner.ts and search for "google-tasks-mcp". If found, the mount is already present — skip to Phase 4 (OAuth setup).

### Check if MCP server is already installed

Run: ls ~/Development/tools/google-tasks-mcp 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"

If it shows EXISTS, skip Phase 2 (MCP server is already installed) and continue with Phase 3.

## Phase 2 — Install MCP server

Clone and build the gtasks-mcp server locally:

    git clone https://github.com/zcaceres/gtasks-mcp ~/Development/tools/google-tasks-mcp
    cd ~/Development/tools/google-tasks-mcp && npm install && npm run build

Verify the build succeeded:

    ls ~/Development/tools/google-tasks-mcp/dist/index.js && echo "BUILD OK" || echo "BUILD FAILED"

If BUILD FAILED, check ~/Development/tools/google-tasks-mcp/package.json for the correct build script and run it.

## Phase 3 — Apply code changes

### 1. Edit src/container-runner.ts — add mount

In src/container-runner.ts, inside buildVolumeMounts(), add the following block after the IPC directory mount (after the mounts.push for groupIpcDir) and before the agent-runner source copy block:

    // Google Tasks MCP server
    const googleTasksMcpPath = path.join(os.homedir(), 'Development', 'tools', 'google-tasks-mcp');
    if (fs.existsSync(googleTasksMcpPath)) {
      mounts.push({
        hostPath: googleTasksMcpPath,
        containerPath: '/home/node/google-tasks-mcp',
        readonly: true,
      });
    }

Add "import os from 'os'" at the top of src/container-runner.ts alongside the other Node.js built-in imports (fs, path). This import is not present in the file by default and must be added — without it the TypeScript build will fail.

IMPORTANT — token refresh: After Phase 5 verification, check if credentials.json was modified. If gtasks-mcp refreshes tokens in-place, change readonly: true to readonly: false, then rebuild and restart.

### 2. Edit container/agent-runner/src/index.ts — register MCP server

Find the allowedTools array in the query() call options and add mcp__gtasks__* :

    allowedTools: [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*',
      'mcp__gtasks__*',
    ],

Find the mcpServers object in the same query() call and add the gtasks entry alongside the existing nanoclaw entry:

    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
      gtasks: {
        command: 'node',
        args: ['/home/node/google-tasks-mcp/dist/index.js'],
      },
    },

The key name "gtasks" determines the tool prefix: tools will be called mcp__gtasks__<toolname>.

### 3. Append Google Tasks section to groups/main/CLAUDE.md

Read groups/main/CLAUDE.md then append at the end:

    ## Google Tasks

    You have full access to Google Tasks via the mcp__gtasks__* tools. Use them when the user asks to manage tasks, lists, or reminders.

    - To create a task: ask which list if not specified, default to the first available list
    - To mark complete: find the task by title if no ID is given
    - For the daily morning summary (triggered automatically at 07:00): list overdue tasks and tasks due today across ALL lists; format clearly with list name, task title, and due date
    - Do NOT proactively check tasks unless the user asks or the scheduled morning prompt fires

### 4. Build NanoClaw host

    npm run build

All TypeScript errors must be resolved before continuing.

### 5. Clear stale agent-runner copies

    rm -r data/sessions/*/agent-runner-src 2>/dev/null || true

These copies are created once and not auto-synced — must clear so the container picks up the updated agent-runner.

### 6. Rebuild container

    cd container && ./build.sh

Wait for the build to complete.

## Phase 4 — OAuth setup

### Check for existing credentials

    ls ~/Development/tools/google-tasks-mcp/gcp-oauth.keys.json 2>/dev/null && echo "FOUND" || echo "NOT FOUND"

If FOUND, skip to "Run authorization" below.

### GCP Project Setup

Tell the user:

  I need you to set up Google Cloud OAuth credentials for Google Tasks:

  1. Open https://console.cloud.google.com — create a new project or select an existing one
  2. Go to APIs & Services > Library, search "Google Tasks API", click Enable
  3. Go to APIs & Services > Credentials, click + CREATE CREDENTIALS > OAuth client ID
     - If prompted for consent screen: choose "External", fill in app name and your email, save.
       Under "Scopes", add: https://www.googleapis.com/auth/tasks
     - Application type: Desktop app, name: anything (e.g. "NanoClaw Tasks")
  4. Click DOWNLOAD JSON and save the file

  What's the full path to the downloaded file? (Or paste its contents here)

If the user provides a path, copy it:

    cp "/path/from/user" ~/Development/tools/google-tasks-mcp/gcp-oauth.keys.json

If the user pastes JSON content, write it to ~/Development/tools/google-tasks-mcp/gcp-oauth.keys.json.

### Run authorization

Tell the user:

  I'm going to run Google Tasks authorization. A browser window will open — sign in and grant
  access. If you see "app isn't verified", click Advanced then "Go to [app name] (unsafe)" —
  this is normal for personal OAuth apps.

Run:

    cd ~/Development/tools/google-tasks-mcp && node dist/index.js auth

If that fails (no auth subcommand), try:

    cd ~/Development/tools/google-tasks-mcp && timeout 60 node dist/index.js || true

Verify credentials were saved:

    ls ~/Development/tools/google-tasks-mcp/credentials.json && echo "AUTH OK" || echo "AUTH FAILED"

If AUTH FAILED, check the README: cat ~/Development/tools/google-tasks-mcp/README.md | head -60

## Phase 5 — Create cron task

First check if the cron task already exists (idempotency guard):

    sqlite3 store/messages.db "SELECT id FROM scheduled_tasks WHERE schedule_value = '0 7 * * *' AND group_folder = 'main';"

If a row is returned, the task already exists — skip to Phase 6.

Note: NanoClaw must have been started at least once before running this step — the database migration that adds the context_mode column runs at startup.

Otherwise, create it using a Node.js script (uses execFileSync, not shell exec, to avoid injection):

    node --input-type=module << 'EOF'
    import { execFileSync } from 'child_process';
    import { randomUUID } from 'crypto';

    const mainJid = execFileSync('sqlite3', [
      'store/messages.db',
      "SELECT jid FROM registered_groups WHERE folder = 'main';"
    ], { encoding: 'utf8' }).trim();

    if (!mainJid) {
      console.error('ERROR: Main group not found. Register your main WhatsApp group first.');
      process.exit(1);
    }

    const id = randomUUID();
    const now = new Date();
    const next7am = new Date();
    next7am.setHours(7, 0, 0, 0);
    if (next7am <= now) next7am.setDate(next7am.getDate() + 1);

    const prompt = 'Check Google Tasks. List all overdue tasks and tasks due today across all task lists. Send a formatted morning summary to the user.';
    const row = [id, 'main', mainJid, prompt, 'cron', '0 7 * * *', 'active', 'group', next7am.toISOString(), now.toISOString()];
    const placeholders = row.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(', ');
    const sql = `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, context_mode, next_run, created_at) VALUES (${placeholders});`;

    execFileSync('sqlite3', ['store/messages.db', sql]);
    console.log('Cron task created. ID:', id, '| Next run:', next7am.toISOString());
    EOF

Verify:

    sqlite3 store/messages.db "SELECT id, schedule_value, next_run, status FROM scheduled_tasks WHERE group_folder = 'main' AND schedule_value = '0 7 * * *';"

Expected: one row with status=active.

If the main group is not found, tell the user to register it first by sending a message in that group that matches the trigger pattern.

## Phase 6 — Restart and verify

### Restart NanoClaw

    launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
    # Linux: systemctl --user restart nanoclaw

### Test tool access

Tell the user:

  Google Tasks is connected! Send this in your main WhatsApp group:

    @Andy quais minhas listas do Google Tasks?

  The agent should respond with your task lists within a few seconds.

### Check token refresh behavior

After the first successful tool call, run:

    ls -la ~/Development/tools/google-tasks-mcp/credentials.json

If the modification timestamp is recent (just updated during the call), gtasks-mcp refreshes tokens in-place.
In that case, update src/container-runner.ts to change readonly: true to readonly: false for the google-tasks-mcp mount, then rebuild and restart.

### Check logs if needed

    tail -f logs/nanoclaw.log
    cat groups/main/logs/container-*.log 2>/dev/null | tail -50

## Troubleshooting

### MCP server not responding

Verify host path exists: ls ~/Development/tools/google-tasks-mcp/dist/index.js
Verify stale copies were cleared (re-run Phase 3 step 5 and restart).

### OAuth token expired

    rm ~/Development/tools/google-tasks-mcp/credentials.json
    cd ~/Development/tools/google-tasks-mcp && node dist/index.js auth

### Cron task not firing

    sqlite3 store/messages.db "SELECT id, status, next_run, last_run FROM scheduled_tasks WHERE schedule_value = '0 7 * * *';"

If status is not active:

    sqlite3 store/messages.db "UPDATE scheduled_tasks SET status='active' WHERE schedule_value='0 7 * * *' AND group_folder='main';"

### Build fails (Node version)

    node --version
    # Requires Node 18+

## Removal

1. Remove the google-tasks-mcp mount block from buildVolumeMounts() in src/container-runner.ts
2. Remove 'mcp__gtasks__*' from allowedTools in container/agent-runner/src/index.ts
3. Remove the gtasks entry from mcpServers in container/agent-runner/src/index.ts
4. Remove the Google Tasks section from groups/main/CLAUDE.md
5. Delete cron task:
       sqlite3 store/messages.db "DELETE FROM scheduled_tasks WHERE schedule_value='0 7 * * *' AND group_folder='main';"
6. Clear stale copies: rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
7. Rebuild and restart:
       npm run build && cd container && ./build.sh && cd ..
       launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
       # Linux: systemctl --user restart nanoclaw
8. Optional: rm -rf ~/Development/tools/google-tasks-mcp
