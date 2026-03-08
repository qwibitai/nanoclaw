# Add Google Drive

Gives the agent full Google Drive access as a tool: search files, read
documents (Docs → Markdown, Sheets → CSV, Slides → text), upload files,
and manage sharing — all via Anthropic's official
`@modelcontextprotocol/server-gdrive` MCP server.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `google-drive` is in `applied_skills`,
skip to Phase 3 (Configure). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` does not exist:

```bash
npx tsx -e "import { initNanoclawDir } from './skills-engine/init.ts'; initNanoclawDir(); console.log('initialized');"
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-google-drive
```

This deterministically:
- Merges `import os from 'os'` into `src/container-runner.ts`
- Adds conditional `~/.gdrive-mcp/` volume mount to `buildVolumeMounts()`
- Adds `'mcp__gdrive__*'` to `allowedTools` in `container/agent-runner/src/index.ts`
- Registers the `gdrive` MCP server with OAuth path env vars

If the apply reports merge conflicts, read the intent files:
- `modify/src/container-runner.ts.intent.md`
- `modify/container/agent-runner/src/index.ts.intent.md`

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set up GCP OAuth credentials

1. Go to https://console.cloud.google.com/
2. Create a new project (or select an existing one)
3. Enable the **Google Drive API**:
   - APIs & Services → Library → search "Google Drive API" → Enable
4. Create OAuth credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Name it anything (e.g. "NanoClaw Drive")
   - Click Create → Download JSON
5. Create the credentials directory and copy the file:

```bash
mkdir -p ~/.gdrive-mcp
cp ~/Downloads/client_secret_*.json ~/.gdrive-mcp/gcp-oauth.keys.json
```

### Authorise

Run the MCP server once to complete the OAuth browser flow:

```bash
GDRIVE_OAUTH_PATH=~/.gdrive-mcp/gcp-oauth.keys.json \
GDRIVE_CREDENTIALS_PATH=~/.gdrive-mcp/credentials.json \
npx -y @modelcontextprotocol/server-gdrive
```

A browser window will open. Sign in with your Google account and grant
Drive access. The server will save tokens to
`~/.gdrive-mcp/credentials.json` and start listening. Press Ctrl+C once
you see it running — the tokens are saved.

### Restart NanoClaw

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Tell the user:

> Ask the agent: "List the 5 most recent files in my Google Drive"

The agent should respond with a list of your recent files. If it
reports Drive tools are unavailable, check the troubleshooting section.

## Troubleshooting

### "Drive tools are unavailable" or MCP server fails to start

1. Verify credentials exist:
   ```bash
   ls -la ~/.gdrive-mcp/
   # Should show: gcp-oauth.keys.json  credentials.json
   ```
2. If `credentials.json` is missing, re-run the authorise step above.
3. Check the NanoClaw log for MCP startup errors:
   ```bash
   tail -50 logs/nanoclaw.log | grep -i gdrive
   ```

### OAuth consent screen shows "App not verified"

This is expected for personal OAuth apps. Click **Advanced** →
**Go to [app name] (unsafe)** to proceed. Since you created the app
yourself in your own GCP project, this is safe.

### Token expired after long period

Google refresh tokens occasionally expire. Re-run the authorise step:

```bash
rm ~/.gdrive-mcp/credentials.json
GDRIVE_OAUTH_PATH=~/.gdrive-mcp/gcp-oauth.keys.json \
GDRIVE_CREDENTIALS_PATH=~/.gdrive-mcp/credentials.json \
npx -y @modelcontextprotocol/server-gdrive
```

### Agent can see Drive but not a specific file

The `drive.file` scope only grants access to files the OAuth app has
opened. If you need broader access, recreate the OAuth credentials and
select the `https://www.googleapis.com/auth/drive` scope during consent.
