---
name: add-outlook
description: Add Outlook integration to NanoClaw. Gives container agents access to Microsoft 365 email, calendar, contacts, tasks, and Teams via outlook-mcp (75+ tools). Guides through Azure OAuth setup.
---

# Add Outlook Integration

This skill adds Microsoft 365 support to NanoClaw via `outlook-mcp` — email, calendar, contacts, tasks, and Teams tools available to container agents.

## Phase 1: Pre-flight

### Check if already applied

Check if `mcp__outlook__*` appears in `container/agent-runner/src/index.ts`:

```bash
grep -q 'mcp__outlook__' container/agent-runner/src/index.ts && echo "ALREADY_APPLIED" || echo "NOT_APPLIED"
```

If already applied, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Add Outlook credentials mount to container-runner

In `src/container-runner.ts`, inside the `buildVolumeMounts` function, after the Google Calendar mount block (the one mounting `~/.config/google-calendar-mcp`), add:

```typescript
  // Outlook credentials directory (for Outlook MCP inside the container)
  const outlookDir = path.join(homeDir, '.outlook-mcp');
  if (fs.existsSync(outlookDir)) {
    mounts.push({
      hostPath: outlookDir,
      containerPath: '/home/node/.outlook-mcp',
      readonly: true, // Credentials are read-only; tokens stored separately
    });
  }

  // Outlook MCP token file (needs read-write for token refresh)
  const outlookTokenFile = path.join(homeDir, '.outlook-mcp-tokens.json');
  if (fs.existsSync(outlookTokenFile)) {
    mounts.push({
      hostPath: outlookTokenFile,
      containerPath: '/home/node/.outlook-mcp-tokens.json',
      readonly: false, // MCP needs to refresh OAuth tokens
    });
  }
```

### Add Outlook MCP server to agent-runner

In `container/agent-runner/src/index.ts`:

1. Add `'mcp__outlook__*'` to the `allowedTools` array.

2. Add the outlook MCP server to the `mcpServers` object:

```typescript
        outlook: {
          command: 'npx',
          args: ['-y', 'outlook-mcp'],
          env: {
            MS_CLIENT_ID: process.env.MS_CLIENT_ID || '',
            MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET || '',
            HOME: '/home/node',
          },
        },
```

### Pass Outlook env vars to container

In `src/container-runner.ts`, inside the `buildContainerArgs` function, after the auth-mode env vars block, add:

```typescript
  // Outlook MCP credentials (client ID / secret for Microsoft Graph API)
  const outlookEnvPath = path.join(os.homedir(), '.outlook-mcp', '.env');
  if (fs.existsSync(outlookEnvPath)) {
    const envContent = fs.readFileSync(outlookEnvPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^(MS_CLIENT_ID|MS_CLIENT_SECRET)=(.+)$/);
      if (match) {
        args.push('-e', `${match[1]}=${match[2].trim()}`);
      }
    }
  }
```

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Check existing Outlook credentials

```bash
ls -la ~/.outlook-mcp/ 2>/dev/null || echo "No Outlook config found"
ls ~/.outlook-mcp-tokens.json 2>/dev/null || echo "No token file found"
```

### Create credentials .env file

Check if `~/.outlook-mcp/.env` exists with `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. If not, check the host Claude settings:

```bash
cat ~/.claude/settings.json | grep -A 5 '"outlook"'
```

If credentials are found in settings.json, extract and write them:

```bash
mkdir -p ~/.outlook-mcp
cat > ~/.outlook-mcp/.env << 'ENVEOF'
MS_CLIENT_ID=<client-id-from-settings>
MS_CLIENT_SECRET=<client-secret-from-settings>
ENVEOF
chmod 600 ~/.outlook-mcp/.env
```

If no credentials exist anywhere, tell the user:

> I need you to set up Azure OAuth credentials:
>
> 1. Go to https://portal.azure.com > **App registrations** > **New registration**
>    - Name: "NanoClaw Outlook"
>    - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
>    - Redirect URI: Web, `http://localhost:3333/auth/callback`
> 2. Copy the **Application (client) ID**
> 3. Go to **Certificates & secrets** > **New client secret** > Copy the **Value**
> 4. Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**
>    - Add: Mail.Read, Mail.ReadWrite, Mail.Send, User.Read, Calendars.Read, Calendars.ReadWrite, Contacts.Read, Contacts.ReadWrite, Tasks.Read, Tasks.ReadWrite, offline_access
> 5. Give me the Client ID and Client Secret

### Authenticate (if no token file exists)

If `~/.outlook-mcp-tokens.json` doesn't exist, the agent will need to authenticate on first use. Tell the user:

> Outlook is configured but needs initial authentication. The first time the agent uses an Outlook tool, it will call `authenticate` which opens a browser window. You can also trigger it manually:
>
> ```bash
> MS_CLIENT_ID=<id> MS_CLIENT_SECRET=<secret> npx outlook-mcp
> ```
> Then call the `authenticate` tool.

### Build and restart

Clear stale per-group agent-runner copies:

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

### Test tool access

Tell the user:

> Outlook is connected! Send this in your main channel:
>
> `@Andy list my Outlook calendar events for today`
> or `@Andy search my Outlook emails from this week`

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -iE "(outlook|mcp)"
```

## Troubleshooting

### Outlook MCP not responding in container

Test directly with the env vars:

```bash
MS_CLIENT_ID=<id> MS_CLIENT_SECRET=<secret> npx -y outlook-mcp
```

### Token expired / auth failed

Delete token file and re-authenticate:

```bash
rm ~/.outlook-mcp-tokens.json
MS_CLIENT_ID=<id> MS_CLIENT_SECRET=<secret> npx -y outlook-mcp
# Then call 'authenticate' tool
```

### Container can't access Outlook

- Verify `~/.outlook-mcp` is mounted: check `src/container-runner.ts`
- Verify env vars are passed: check `~/.outlook-mcp/.env` exists
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

## Removal

1. Remove `~/.outlook-mcp` mount and token file mount from `src/container-runner.ts`
2. Remove Outlook env var injection from `buildContainerArgs` in `src/container-runner.ts`
3. Remove `outlook` MCP server and `mcp__outlook__*` from `container/agent-runner/src/index.ts`
4. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
5. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
