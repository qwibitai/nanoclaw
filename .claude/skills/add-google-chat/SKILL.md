---
name: add-google-chat
description: Add Google Chat as a multi-space channel to NanoClaw. Automatically discovers all DMs and rooms the authenticated user belongs to. DMs route directly, rooms require @mention trigger.
---

# Add Google Chat Channel

This skill adds Google Chat as a messaging channel with multi-space support. The bot automatically discovers all spaces (DMs and rooms) the authenticated user belongs to. DM messages are delivered directly; room messages require an @mention trigger. Replies are sent back to the originating space.

> **Note:** The Google Chat API historically required a Google Workspace account. Personal @gmail.com accounts may now work — if space discovery returns zero results, a Workspace account may still be needed.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `google-chat` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-google-chat
```

This deterministically:

- Adds `src/channels/googlechat.ts` (GoogleChatChannel class implementing Channel interface)
- Adds `src/channels/googlechat.test.ts` (unit tests)
- Three-way merges Google Chat channel wiring into `src/index.ts` (GoogleChatChannel creation with `onSpaceDiscovered` callback)
- Three-way merges Google Chat credentials mount into `src/container-runner.ts` (~/.google-chat-mcp -> /home/node/.google-chat-mcp)
- Three-way merges Google Chat JID tests into `src/routing.test.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:

- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts

### Add Chat message handling instructions

Append the following to `groups/main/CLAUDE.md` (before the formatting section):

```markdown
## Google Chat Messages

When you receive a Google Chat message (messages starting with `[Google Chat from ...`), respond to the user. The reply will be sent back to the Chat space automatically.
```

### Validate

```bash
npm test
npm run build
```

All tests must pass (including the new googlechat tests) and build must be clean before proceeding.

## Phase 3: Setup

### Check existing Google Chat credentials

```bash
ls -la ~/.google-chat-mcp/ 2>/dev/null || echo "No Google Chat config found"
```

If `credentials.json` already exists, skip to "Build and restart" below.

### GCP Project Setup

Tell the user:

> I need you to set up Google Cloud OAuth credentials for Google Chat:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Google Chat API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "Internal" (for Workspace), fill in app name and email, save
>    - Application type: **Desktop app**, name: anything (e.g., "NanoClaw Chat")
> 4. Click **DOWNLOAD JSON** and save as `gcp-oauth.keys.json`
>
> Where did you save the file? (Give me the full path, or paste the file contents here)

If user provides a path, copy it:

```bash
mkdir -p ~/.google-chat-mcp
cp "/path/user/provided/gcp-oauth.keys.json" ~/.google-chat-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.google-chat-mcp/gcp-oauth.keys.json`.

### OAuth Authorization

There is no third-party auth tool for Google Chat (unlike Gmail). Run a Node.js inline script to complete the OAuth flow:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const credDir = path.join(require('os').homedir(), '.google-chat-mcp');
const keys = JSON.parse(fs.readFileSync(path.join(credDir, 'gcp-oauth.keys.json'), 'utf-8'));
const config = keys.installed || keys.web || keys;

const oauth2Client = new google.auth.OAuth2(
  config.client_id,
  config.client_secret,
  'http://localhost:3000/oauth2callback'
);

const scopes = [
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
];

const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
console.log('Open this URL in your browser:\n\n' + authUrl + '\n');

const server = http.createServer(async (req, res) => {
  const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
  const code = qs.get('code');
  if (code) {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify(tokens, null, 2));
    res.end('Authorization complete! You can close this tab.');
    console.log('Credentials saved to ~/.google-chat-mcp/credentials.json');
    server.close();
  }
}).listen(3000);
"
```

Tell the user:

> A URL will be printed. Open it in your browser, sign in with your Google Workspace account, and grant access. If you see an "app isn't verified" warning, click "Advanced" then "Go to [app name] (unsafe)".

Verify credentials were saved:

```bash
ls ~/.google-chat-mcp/credentials.json
```

### Build and restart

Spaces are discovered automatically — all DMs and rooms the authenticated user belongs to will be found. If you want to limit the bot to a single space, set `GOOGLE_CHAT_SPACE_ID=<space-id>` in `.env` (optional).

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Tell the user:

> Google Chat is connected! The bot automatically discovers all your DMs and rooms:
> - **DMs**: Send a message directly — no trigger needed
> - **Rooms**: @mention the bot to trigger a response
>
> Messages should appear within ~15 seconds.

Monitor:

```bash
tail -f logs/nanoclaw.log | grep -iE "(google.chat|gchat|discover)"
```

## Troubleshooting

### Google Chat connection not responding

- Verify credentials exist: `ls ~/.google-chat-mcp/`
- Check logs: `grep -i "google chat" logs/nanoclaw.log | tail -20`
- If using a personal @gmail.com account and it doesn't work, try a Google Workspace account

### OAuth token expired

Re-authorize by running the OAuth flow from Phase 3 again:

```bash
rm ~/.google-chat-mcp/credentials.json
# Re-run the OAuth authorization script above
```

### Messages not being detected

- Ensure the authenticated user can see messages in the space
- The channel polls every 15 seconds by default
- Last poll timestamps are persisted across restarts — old messages won't replay

### No spaces discovered

- If using a personal Gmail account, try a Workspace account — some API features may still require it
- Check that the Chat API is enabled in your GCP project
- Verify the OAuth scopes include `chat.spaces.readonly`

## Removal

1. Delete `src/channels/googlechat.ts` and `src/channels/googlechat.test.ts`
2. Remove `GoogleChatChannel` import and creation from `src/index.ts`
3. Remove `~/.google-chat-mcp` mount from `src/container-runner.ts`
4. Remove Google Chat JID tests from `src/routing.test.ts`
5. Remove `google-chat` from `.nanoclaw/state.yaml`
6. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
