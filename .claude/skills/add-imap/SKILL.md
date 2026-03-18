---
name: add-imap
description: Add IMAP/SMTP email integration to NanoClaw. Connects a Hetzner (or any IMAP) mailbox directly — no Gmail forwarding needed. Supports channel mode (emails trigger the agent) or tool-only mode (agent has email tools).
---

# Add IMAP Integration

This skill adds IMAP email support to NanoClaw using imapflow and nodemailer — either as a full channel (inbox polling) or as a tool-only integration (agent can read/send/reply/archive/search emails on demand).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/imap.ts` exists:

```bash
ls src/channels/imap.ts 2>/dev/null && echo EXISTS || echo NOT_FOUND
```

**If it exists** — IMAP is already installed. Ask the user with `AskUserQuestion`:

> IMAP is already set up. What would you like to do?
>
> - **Add a global account** — accessible to all channels (e.g. a shared inbox)
> - **Add a local account** — scoped to one group/user only
> - **Troubleshoot** — something isn't working

For "add global account" or "add local account": skip directly to [Add an Account](#add-an-account) below.
For "troubleshoot": skip to the Troubleshooting section.

**If it doesn't exist** — continue with Phase 2 (fresh install).

### Ask the user (fresh install only)

Use `AskUserQuestion`:

> Should incoming emails trigger the agent automatically?
>
> - **Yes** — Channel mode: NanoClaw polls the inbox every 60s and delivers new emails as messages
> - **No** — Tool-only: The agent gets full email tools (read, send, reply, archive, search) but won't monitor the inbox

## Phase 2: Apply Code Changes

The code files are already part of the NanoClaw codebase. Verify they are present:

```bash
ls src/channels/imap.ts container/agent-runner/src/imap-mcp-stdio.ts
```

### Verify channel registration (channel mode only)

Check `src/channels/index.ts` — it should contain `import './imap.js'`. If not, add it after the `// imap` comment:

```typescript
// imap
import './imap.js';
```

### Add email handling instructions (channel mode only)

Append to `groups/main/CLAUDE.md`:

```markdown
## Email Notifications

When you receive an email notification (messages starting with `[Email from ...`), inform the user about it but do NOT reply to the email unless specifically asked. You have IMAP tools available — use them only when the user explicitly asks you to take action on an email.
```

### Install dependencies

```bash
npm install
cd container/agent-runner && npm install && cd ../..
```

### Build

```bash
npm run build
```

Build must succeed with no TypeScript errors before proceeding.

## Phase 3: Credentials Setup

### Account types

NanoClaw supports two types of IMAP accounts:

- **Global** (`~/.imap-mcp/config.json`) — mounted into every container. Use for shared inboxes. In channel mode, global accounts are polled for inbound messages.
- **Local** (`~/.imap-mcp-{group-folder}/config.json`) — mounted only into that group's container. Use for personal or per-channel accounts. Local accounts are tool-only (not polled).

Both use the same format: `{ "accounts": { "<name>": { imap, smtp, from } } }`. The MCP server merges global + local so the agent sees all accounts.

### Check for existing config

```bash
ls -la ~/.imap-mcp/config.json 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"
```

If it exists and the user wants to keep it, skip to Phase 4.

### Gather credentials

Ask the user with `AskUserQuestion`:

> Please provide your IMAP/SMTP credentials:
>
> 1. **Account name** — a short identifier (e.g. `work`, `personal`)
> 2. **IMAP host and port** (usually port `993` with SSL)
> 3. **SMTP host and port** (usually port `465` with SSL or `587` with STARTTLS)
> 4. **Email address and password**
> 5. **Display name** for outgoing emails (e.g. `Alice <alice@example.com>`)
> 6. **Global or local?** — shared inbox accessible to all channels, or scoped to one group?

### Write config

For a **global** account:

```bash
mkdir -p ~/.imap-mcp
```

`~/.imap-mcp/config.json`:

```json
{
  "accounts": {
    "work": {
      "imap": { "host": "imap.example.com", "port": 993, "secure": true, "auth": { "user": "you@example.com", "pass": "secret" } },
      "smtp": { "host": "smtp.example.com", "port": 465, "secure": true, "auth": { "user": "you@example.com", "pass": "secret" } },
      "from": "You <you@example.com>",
      "archiveFolder": "Archive",
      "pollFolders": ["INBOX"]
    }
  }
}
```

```bash
chmod 600 ~/.imap-mcp/config.json
```

For a **local** account scoped to one group, use the same format at `~/.imap-mcp-{group-folder}/config.json`.

### Test the connection

```bash
node --input-type=module << 'EOF'
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'fs';
import { homedir } from 'os';
const cfg = JSON.parse(readFileSync(homedir() + '/.imap-mcp/config.json', 'utf-8'));
const account = Object.values(cfg.accounts)[0];
const client = new ImapFlow({ ...account.imap, logger: false });
await client.connect();
const status = await client.status('INBOX', { messages: true, unseen: true });
console.log('Connected! messages:', status.messages, 'unseen:', status.unseen);
await client.logout();
EOF
```

## Phase 4: Build & Restart

### Clear stale agent-runner copies

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

### Rebuild container

```bash
cd container && ./build.sh && cd ..
```

### Compile and restart

```bash
npm run build
```

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Tell the user:

> IMAP is connected! Try asking in your main channel:
>
> `list my recent emails` — the agent should use `mcp__imap__list_emails`

### Channel mode

In channel mode, the IMAP channel uses JID `imap:{accountName}` (e.g. `imap:work`). Register it with `mcp__nanoclaw__register_group`:
- `jid`: `imap:work`
- `name`: `Email Inbox`
- `folder`: `imap_work`
- `trigger`: your trigger word

Ask the user to send a test email. It should be picked up within 60 seconds. Monitor:

```bash
tail -f logs/nanoclaw.log | grep -iE "(imap|email)"
```

## Add an Account

Use this when IMAP is already installed and you want to add another account (e.g. a new user's personal inbox, or a second shared mailbox).

### Gather details

Ask with `AskUserQuestion`:

> Is this a **global** account (shared across all channels) or a **local** account (scoped to one group)?
>
> For a local account: which group folder should it belong to? (Check `groups/` or `data/sessions/` for folder names.)
>
> Then provide:
> 1. **Account name** — short identifier (e.g. `work`, `alice`)
> 2. **IMAP host and port**
> 3. **SMTP host and port**
> 4. **Email address and password**
> 5. **Display name** (e.g. `Alice <alice@example.com>`)

### Update the config file

Read the existing config, merge in the new account, and write it back.

For **global**: `~/.imap-mcp/config.json`
For **local**: `~/.imap-mcp-{group-folder}/config.json` (create dir if needed)

Add the new account under `accounts`:

```json
{
  "accounts": {
    "existing-account": { "...": "..." },
    "new-account-name": {
      "imap": { "host": "imap.example.com", "port": 993, "secure": true, "auth": { "user": "user@example.com", "pass": "secret" } },
      "smtp": { "host": "smtp.example.com", "port": 465, "secure": true, "auth": { "user": "user@example.com", "pass": "secret" } },
      "from": "Name <user@example.com>",
      "archiveFolder": "Archive"
    }
  }
}
```

```bash
chmod 600 ~/.imap-mcp/config.json  # or the local path
```

### Restart (global accounts only)

Local accounts are picked up automatically on the next container spawn — no restart needed.

For global accounts in channel mode, restart to start polling the new inbox:

```bash
systemctl --user restart nanoclaw   # Linux
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

---

## Troubleshooting

### Connection refused / auth failure

- Verify host, port, and credentials in the config file
- For port 587 (STARTTLS), set `"secure": false`
- Check that IMAP access is enabled in your mailbox settings

### Container can't access email

- Verify the config directory is mounted: check `src/container-runner.ts` for the `.imap-mcp` mount
- Check container logs: `cat groups/main/logs/container-*.log | tail -100`

### Emails not being detected (channel mode)

- Check logs: `tail -50 logs/nanoclaw.log | grep -i imap`
- Verify the IMAP group is registered: check the `groups/` directory
- The channel only delivers to registered groups

## Removal

1. Remove `import './imap.js'` from `src/channels/index.ts`
2. Remove the `.imap-mcp` mounts from `src/container-runner.ts`
3. Remove the `imap` MCP server block from `container/agent-runner/src/index.ts`
4. Remove `mcp__imap__*` from the `allowedTools` array in `container/agent-runner/src/index.ts`
5. Delete `src/channels/imap.ts` and `container/agent-runner/src/imap-mcp-stdio.ts`
6. Uninstall deps: `npm uninstall imapflow nodemailer && cd container/agent-runner && npm uninstall imapflow nodemailer && cd ../..`
7. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
8. Rebuild: `cd container && ./build.sh && cd .. && npm run build`
9. Restart the service
