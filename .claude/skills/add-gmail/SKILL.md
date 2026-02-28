---
name: add-gmail
description: Add Gmail integration to NanoClaw. Can be configured as a tool (agent reads/sends emails when triggered from WhatsApp) or as a full channel (emails can trigger the agent, schedule tasks, and receive replies). Guides through GCP OAuth setup and implements the integration.
---

# Add Gmail Integration

This skill adds Gmail support to NanoClaw — either as a tool (read, send, search, draft) or as a full channel that polls the inbox.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `gmail` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Should incoming emails be able to trigger the agent?

- **Yes** — Full channel mode: the agent listens on Gmail and responds to incoming emails automatically
- **No** — Tool-only: the agent gets full Gmail tools (read, send, search, draft) but won't monitor the inbox. No channel code is added.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Path A: Tool-only (user chose "No")

Do NOT run the full apply script. Only two source files need changes. This avoids adding dead code (`gmail.ts`, `gmail.test.ts`, index.ts channel logic, routing tests, `googleapis` dependency).

#### 1. Mount Gmail credentials in container

Apply the changes described in `modify/src/container-runner.ts.intent.md` to `src/container-runner.ts`: import `os`, add a conditional read-write mount of `~/.gmail-mcp` to `/home/node/.gmail-mcp` in `buildVolumeMounts()` after the session mounts.

#### 2. Add Gmail MCP server to agent runner

Apply the changes described in `modify/container/agent-runner/src/index.ts.intent.md` to `container/agent-runner/src/index.ts`: add `gmail` MCP server (`npx -y @gongrzhe/server-gmail-autoauth-mcp`) and `'mcp__gmail__*'` to `allowedTools`.

#### 3. Record in state

Add `gmail` to `.nanoclaw/state.yaml` under `applied_skills` with `mode: tool-only`.

#### 4. Validate

```bash
npm run build
```

Build must be clean before proceeding. Skip to Phase 3.

### Path B: Channel mode (user chose "Yes")

Run the full skills engine to apply all code changes:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-gmail
```

This deterministically:

- Adds `src/channels/gmail.ts` (GmailChannel class implementing Channel interface)
- Adds `src/channels/gmail.test.ts` (unit tests)
- Three-way merges Gmail channel wiring into `src/index.ts` (GmailChannel creation)
- Three-way merges Gmail credentials mount into `src/container-runner.ts` (~/.gmail-mcp -> /home/node/.gmail-mcp)
- Three-way merges Gmail MCP server into `container/agent-runner/src/index.ts` (@gongrzhe/server-gmail-autoauth-mcp)
- Three-way merges Gmail JID tests into `src/routing.test.ts`
- Installs the `googleapis` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:

- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts
- `modify/container/agent-runner/src/index.ts.intent.md` — what changed for agent-runner

#### Add email handling instructions

Append the following to `groups/main/CLAUDE.md` (before the formatting section):

```markdown
## Email Notifications

When you receive an email notification (messages starting with `[Email from ...`), inform the user about it but do NOT reply to the email unless specifically asked. You have Gmail tools available — use them only when the user explicitly asks you to reply, forward, or take action on an email.
```

#### Validate

```bash
npm test
npm run build
```

All tests must pass (including the new gmail tests) and build must be clean before proceeding.

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
3. Remove `gmail` from `.nanoclaw/state.yaml`
4. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
5. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)

### Channel mode

1. Delete `src/channels/gmail.ts` and `src/channels/gmail.test.ts`
2. Remove `GmailChannel` import and creation from `src/index.ts`
3. Remove `~/.gmail-mcp` mount from `src/container-runner.ts`
4. Remove `gmail` MCP server and `mcp__gmail__*` from `container/agent-runner/src/index.ts`
5. Remove Gmail JID tests from `src/routing.test.ts`
6. Uninstall: `npm uninstall googleapis`
7. Remove `gmail` from `.nanoclaw/state.yaml`
8. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
9. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
