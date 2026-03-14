# Add Google Workspace Integration

This skill adds Google Workspace support to NanoClaw using the official Google Workspace CLI (gws). Access Gmail, Drive, Calendar, Docs, Sheets, Chat, and more through a single integration.

**Why gws over add-gmail?**
- Official Google tool (not third-party)
- Supports all Google Workspace services (not just Gmail)
- Released March 2026 with native MCP support
- 4,900+ GitHub stars in 3 days
- Enterprise-grade security (AES-256-GCM encrypted credentials)

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `google-workspace` or `gws` is in `applied_skills`, skip to Phase 3 (Setup).

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Which Google Workspace services do you want to enable?

- **Gmail only** — Email access (read, search, send)
- **Gmail + Drive** — Email and file storage
- **Gmail + Drive + Calendar** — Email, files, and calendar (recommended)
- **Full Workspace** — All services (Gmail, Drive, Calendar, Docs, Sheets, Chat, Meet, etc.)

## Phase 2: Apply Code Changes

### Path: Tool-only (recommended)

Google Workspace tools are available on-demand. No polling, no background processes.

#### 1. Mount gws config directory

Apply changes to `src/container-runner.ts`:

Import `os` at the top:
```typescript
import os from 'os';
```

Add after Claude sessions mount (around line 151):
```typescript
// Google Workspace CLI credentials (shared across all groups)
const gwsConfigDir = path.join(os.homedir(), '.config', 'gws');
if (fs.existsSync(gwsConfigDir)) {
  mounts.push({
    hostPath: gwsConfigDir,
    containerPath: '/home/node/.config/gws',
    readonly: false,
  });
}
```

#### 2. Add gws MCP server to agent runner

Apply changes to `container/agent-runner/src/index.ts`:

Add `'mcp__gws__*'` to `allowedTools` array (around line 435):
```typescript
allowedTools: [
  // ... existing tools ...
  'mcp__nanoclaw__*',
  'mcp__gws__*'  // Add this line
],
```

Add gws MCP server to `mcpServers` object (around line 451):
```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: { ... },
  },
  gws: {
    command: 'gws',
    args: ['mcp', '-s', '<services>'],  // Replace <services> based on user choice
  },
},
```

Service options:
- Gmail only: `'gmail'`
- Gmail + Drive: `'gmail,drive'`
- Gmail + Drive + Calendar: `'gmail,drive,calendar'`
- Full Workspace: `'gmail,drive,calendar,docs,sheets,chat,meet'`

#### 3. Record in state

Add to `.nanoclaw/state.yaml`:
```yaml
applied_skills:
  - name: google-workspace
    version: 1.0.0
    applied_at: '<timestamp>'
    mode: tool-only
    services: '<user-selected-services>'
```

#### 4. Validate

```bash
npm run build
```

Build must succeed before proceeding.

## Phase 3: Setup

### Install Google Workspace CLI

```bash
npm install -g @googleworkspace/cli
gws --version  # Should show: gws 0.8.x
```

### Check existing credentials

```bash
gws auth status
```

If already authenticated, ask user:
> You're already authenticated as [email]. Use this account or re-authenticate?

If re-authenticating, run `gws auth logout` first.

### GCP OAuth Setup

Tell the user:

> I need you to set up Google Cloud OAuth credentials:
>
> 1. Open https://console.cloud.google.com — create a new project or select existing
> 2. Go to **APIs & Services > Library**, enable these APIs:
>    - Gmail API
>    - Google Drive API (if selected)
>    - Google Calendar API (if selected)
>    - [Others based on user selection]
> 3. Go to **APIs & Services > Credentials**, click **+ CREATE CREDENTIALS > OAuth client ID**
>    - If prompted for consent screen: choose "External", fill in app name and email
>    - Application type: **Desktop app**
>    - Name: "NanoClaw Google Workspace"
> 4. Click **DOWNLOAD JSON** and save the file
>
> Where did you save the file? (Provide the full path)

If user provides a path:
```bash
mkdir -p ~/.config/gws
cp "/path/to/client_secret_*.json" ~/.config/gws/client_secret.json
```

### OAuth Authorization

Tell the user:

> I'm starting the authorization flow. Your browser will open to sign in with Google. If you see an "app isn't verified" warning:
>
> 1. Click "Advanced"
> 2. Click "Go to [app name] (unsafe)"
> 3. This is normal for personal OAuth apps

Run authorization (services based on user selection):
```bash
gws auth login -s gmail,drive,calendar  # Adjust based on user choice
```

Wait for completion. On success, you'll see:
```json
{
  "account": "user@gmail.com",
  "status": "success",
  "message": "Authentication successful. Encrypted credentials saved."
}
```

### Build and restart

Clear stale agent-runner copies:
```bash
rm -rf data/sessions/*/agent-runner-src
```

Rebuild container:
```bash
cd container && ./build.sh && cd ..
```

Compile and restart:
```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test tool access

Tell the user:

> Google Workspace is connected! Test it in your main channel:
>
> **Gmail:**
> - `@Andy check my recent emails`
> - `@Andy search for emails from [sender]`
>
> **Drive:** (if enabled)
> - `@Andy list my recent Google Drive files`
>
> **Calendar:** (if enabled)
> - `@Andy check my calendar for today`

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i gws
```

Look for container logs mentioning gws MCP server initialization.

### Test gws directly (optional)

```bash
gws gmail users messages list --params '{"userId": "me", "maxResults": 5}' --format json
```

Should return recent emails.

## Troubleshooting

### gws command not found in container

The container needs gws installed globally. Update Dockerfile:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli
```

Rebuild: `cd container && ./build.sh`

### OAuth token expired

Re-authorize:
```bash
gws auth logout
gws auth login -s <services>
```

### Container can't access gws config

- Verify `~/.config/gws` mount in `src/container-runner.ts`
- Check `ls ~/.config/gws/` shows `client_secret.json` and `credentials.enc`
- Restart service after code changes

### API quota exceeded

Google Workspace APIs have quotas. Check:
- https://console.cloud.google.com/apis/dashboard
- Increase quotas or wait for reset (usually daily)

## Advanced: Channel Mode (Future Enhancement)

Channel mode would poll Gmail inbox and trigger agent on new emails. Not implemented in initial version.

To add channel mode:
1. Create `src/channels/google-workspace.ts` (similar to `gmail.ts`)
2. Poll using `gws gmail users messages list`
3. Register channel in `src/index.ts`

## Removal

To remove Google Workspace integration:

1. Remove gws config mount from `src/container-runner.ts`
2. Remove gws MCP server and `mcp__gws__*` from `container/agent-runner/src/index.ts`
3. Remove from `.nanoclaw/state.yaml`
4. Clear agent-runner copies: `rm -rf data/sessions/*/agent-runner-src`
5. (Optional) Uninstall CLI: `npm uninstall -g @googleworkspace/cli`
6. (Optional) Revoke access: `gws auth logout`, delete `~/.config/gws/`
7. Rebuild: `cd container && ./build.sh && cd .. && npm run build`
8. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)

## Resources

- Official repo: https://github.com/googleworkspace/cli
- Documentation: https://github.com/googleworkspace/cli/tree/main/docs
- API reference: Dynamically generated from Google Discovery Service

## Comparison: gws vs add-gmail

| Feature | add-gmail | add-google-workspace |
|---------|-----------|---------------------|
| Gmail | ✅ | ✅ |
| Drive | ❌ | ✅ |
| Calendar | ❌ | ✅ |
| Docs/Sheets | ❌ | ✅ |
| Chat/Meet | ❌ | ✅ |
| Backend | Third-party MCP | Official Google CLI |
| Release date | Earlier | March 2026 (latest) |
| Maintenance | Community | Google official |
| Stars | - | 4,900+ (trending) |
| Security | Good | Enterprise-grade |

**Recommendation:** Use `add-google-workspace` for new installations. Existing `add-gmail` users can migrate by uninstalling `add-gmail` first.
