---
name: add-imap-email
description: Add IMAP/SMTP email integration to NanoClaw. Allows the agent to read, search, and send emails using standard mail protocols (IMAP/SMTP). Guides through code patching, dependency installation, and configuration.
---

# Add IMAP/SMTP Integration

This skill adds standard email support to NanoClaw as a tool. Agents can list, read, search, and send emails from their group context.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/imap-service.ts` exists:

```bash
ls src/imap-service.ts 2>/dev/null && echo "IMAP service exists" || echo "No IMAP service"
```

If it exists, skip to Phase 3 (Setup).

### Ask the user

AskUserQuestion: What is your IMAP/SMTP host? (e.g., mail.example.com)

AskUserQuestion: What is your email username? (e.g., me@example.com)

AskUserQuestion: Which folders should the agent be allowed to access? (Default: INBOX)

## Phase 2: Apply Code Changes

### Add npm dependencies

```bash
npm install --save imapflow nodemailer mailparser
npm install --save-dev @types/nodemailer @types/mailparser
```

### Patch `src/types.ts`

Add `ImapConfig` and update `ContainerConfig`. Run this node script:

```bash
node --input-type=module << 'EOF'
import fs from 'fs';
const file = 'src/types.ts';
let src = fs.readFileSync(file, 'utf-8');

const imapConfig = `
export interface ImapConfig {
  host: string;
  port?: number;             // Default: 993 (IMAPS)
  smtpPort?: number;         // Default: 465 (SMTPS)
  username: string;
  allowedFolders?: string[];    // Default: ['INBOX']
  allowedOperations?: string[]; // Default: all. Values: 'list','read','search','send','delete'
}
`;

if (!src.includes('interface ImapConfig')) {
  src += imapConfig;
}

if (!src.includes('imap?: ImapConfig;')) {
  src = src.replace(
    /(export interface ContainerConfig \{[^}]+)\}/,
    '$1  imap?: ImapConfig;\n}'
  );
}

fs.writeFileSync(file, src);
EOF
```

### Create `src/imap-service.ts`

Create the host-side service file. (Implementation should handle `imapflow` and `nodemailer` calls).

### Patch `src/ipc.ts`

Add the `imap` command handler to `src/ipc.ts` to route requests to `ImapService`.

### Patch `container/agent-runner/src/ipc-mcp-stdio.ts`

Add the `imap` MCP tool to allow agents to use email.

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Set Environment Variables

Tell the user:

> I need your IMAP/SMTP password. This should be an "App Password" if you use 2FA.
> 
> Where should I save it?
> - **.env file** (Recommended for local dev)
> - **launchd plist** (For macOS background service)

If `.env`:
```bash
echo "IMAP_PASSWORD=user_provided_password" >> .env
```

If `launchd`:
Add to `EnvironmentVariables` in `~/Library/LaunchAgents/com.nanoclaw.plist`.

### Enable for a Group

Ask the user for their main group JID (or look it up in `store/messages.db`).

Run the SQL to enable the tool:

```bash
node -e "
import { db } from './dist/db.js';
const jid = 'USER_PROVIDED_JID';
const config = {
  host: 'USER_PROVIDED_HOST',
  username: 'USER_PROVIDED_USERNAME',
  allowedFolders: ['INBOX']
};
db.prepare(\"UPDATE groups SET container_config = json_set(COALESCE(container_config, '{}'), '$.imap', json(?)) WHERE jid = ?\").run(JSON.stringify(config), jid);
"
```

### Build and restart

```bash
npm run build
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
# systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test tool access

Tell the user:

> IMAP integration is active! Try asking the assistant:
> 
> `@Andy check my recent emails`

### Check logs

```bash
tail -f logs/nanoclaw.log | grep imap
```

## Removal

1. Delete `src/imap-service.ts`.
2. Revert patches in `src/types.ts`, `src/ipc.ts`, and `container/agent-runner/src/ipc-mcp-stdio.ts`.
3. Uninstall dependencies: `npm uninstall imapflow nodemailer mailparser @types/nodemailer @types/mailparser`.
4. Remove `IMAP_PASSWORD` from environment.
5. `UPDATE groups SET container_config = json_remove(container_config, '$.imap') WHERE jid = '...';`
6. Rebuild and restart.
