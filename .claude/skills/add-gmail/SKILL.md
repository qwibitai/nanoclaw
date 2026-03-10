---
name: add-gmail
description: Add Gmail integration to NanoClaw. Can be configured as a tool (agent reads/sends emails when triggered from WhatsApp) or as a full channel (emails can trigger the agent, schedule tasks, and receive replies). Guides through GCP OAuth setup and implements the integration.
---

# Add Gmail Integration

This skill adds Gmail support to NanoClaw — either as a tool (read, send, search, draft) or as a full channel that polls the inbox.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/gmail.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Should incoming emails be able to trigger the agent?

- **Yes** — Full channel mode: the agent listens on Gmail and responds to incoming emails automatically
- **No** — Tool-only: the agent gets full Gmail tools (read, send, search, draft) but won't monitor the inbox. No channel code is added.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `gmail` is missing, add it:

```bash
git remote add gmail https://github.com/qwibitai/nanoclaw-gmail.git
```

### Merge the skill branch

```bash
git fetch gmail main
git merge gmail/main
```

This merges in:
- `src/channels/gmail.ts` (GmailChannel class with self-registration via `registerChannel`)
- `src/channels/gmail.test.ts` (unit tests)
- `import './gmail.js'` appended to the channel barrel file `src/channels/index.ts`
- Gmail credentials mount (`~/.gmail-mcp`) in `src/container-runner.ts`
- Gmail MCP server (`@gongrzhe/server-gmail-autoauth-mcp`) and `mcp__gmail__*` allowed tool in `container/agent-runner/src/index.ts`
- `googleapis` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Add email handling instructions (Channel mode only)

If the user chose channel mode, append the following to `groups/main/CLAUDE.md` (before the formatting section):

```markdown
## Email Notifications

When you receive an email notification (messages starting with `[Email from ...`), inform the user about it but do NOT reply to the email unless specifically asked. You have Gmail tools available — use them only when the user explicitly asks you to reply, forward, or take action on an email.
```

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/gmail.test.ts
```

All tests must pass (including the new Gmail tests) and build must be clean before proceeding.

## Phase 3: Setup

### Check existing Gmail credentials

```bash
ls -la ~/.gmail-mcp/ 2>/dev/null || echo "No Gmail config found"
```

If `credentials.json` already exists, skip to "Build and restart" below.

### GCP Project Setup

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, search "Gmail API", click **Enable**
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "External", fill in app name and email, save
>    - Application type: **Desktop app**, name: anything (e.g., "NanoClaw Gmail")
> 4. Click **DOWNLOAD JSON** and save as `gcp-oauth.keys.json`
>
> Where did you save the file? (Give me the full path, or paste the file contents here)

If user provides a path, copy it:

```bash
mkdir -p ~/.gmail-mcp
cp "/path/user/provided/gcp-oauth.keys.json" ~/.gmail-mcp/gcp-oauth.keys.json
```

If user pastes JSON content, write it to `~/.gmail-mcp/gcp-oauth.keys.json`.

### OAuth Authorization

Tell the user:

> I'm going to run Gmail authorization. A browser window will open — sign in and grant access. If you see an "app isn't verified" warning, click "Advanced" then "Go to [app name] (unsafe)" — this is normal for personal OAuth apps.

Run the authorization:

```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

If that fails (some versions don't have an auth subcommand), try `timeout 60 npx -y @gongrzhe/server-gmail-autoauth-mcp || true`. Verify with `ls ~/.gmail-mcp/credentials.json`.

### Build and restart

Clear stale per-group agent-runner copies (they only get re-created if missing, so existing copies won't pick up the new Gmail server):

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

Rebuild the container (agent-runner changed):

```bash
cd container && ./build.sh
```

Then compile and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test tool access (both modes)

Tell the user:

> Gmail is connected! Send this in your main channel:
>
> `@Andy check my recent emails` or `@Andy list my Gmail labels`

### Test channel mode (Channel mode only)

Tell the user to send themselves a test email. The agent should pick it up within a minute. Monitor: `tail -f logs/nanoclaw.log | grep -iE "(gmail|email)"`.

Once verified, offer filter customization via `AskUserQuestion` — by default, only emails in the Primary inbox trigger the agent (Promotions, Social, Updates, and Forums are excluded). The user can keep this default or narrow further by sender, label, or keywords. No code changes needed for filters.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Gmail connection not responding

Test directly:

```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp
```

### OAuth token expired

Re-authorize:

```bash
rm ~/.gmail-mcp/credentials.json
npx -y @gongrzhe/server-gmail-autoauth-mcp
```

### Container can't access Gmail

- Verify `~/.gmail-mcp` is mounted: check `src/container-runner.ts` for the `.gmail-mcp` mount
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

### Emails not being detected (Channel mode only)

- By default, the channel polls unread Primary inbox emails (`is:unread category:primary`)
- Check logs for Gmail polling errors

## Removal

### Tool-only mode

1. Remove `~/.gmail-mcp` mount from `src/container-runner.ts`
2. Remove `gmail` MCP server and `mcp__gmail__*` from `container/agent-runner/src/index.ts`
3. Rebuild and restart
4. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
5. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)

### Channel mode

1. Delete `src/channels/gmail.ts` and `src/channels/gmail.test.ts`
2. Remove `import './gmail.js'` from `src/channels/index.ts`
3. Remove `~/.gmail-mcp` mount from `src/container-runner.ts`
4. Remove `gmail` MCP server and `mcp__gmail__*` from `container/agent-runner/src/index.ts`
5. Uninstall: `npm uninstall googleapis`
6. Rebuild and restart
7. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
8. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
