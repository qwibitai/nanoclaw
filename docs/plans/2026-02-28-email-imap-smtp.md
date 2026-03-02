# IMAP/SMTP Email Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add generic IMAP/SMTP email support as a NanoClaw channel so Andy can poll inboxes, read/reply/forward/compose emails with attachments, and notify via Telegram using hybrid autonomy rules.

**Architecture:** New `EmailChannel` implements the `Channel` interface. Host-side polls IMAP every 15 min, delivers formatted emails to the main agent. Agent uses MCP tools (`email_send`, `email_reply`, `email_forward`, `email_search`, `email_list`, `email_read`) via IPC. Host-side IPC watcher handles outbound email actions through `nodemailer`. Attachments are stored temporarily in the group folder.

**Tech Stack:** `imapflow` (IMAP client), `nodemailer` (SMTP), `mailparser` (MIME parsing), existing NanoClaw Channel interface + IPC system.

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install npm packages**

Run:
```bash
npm install imapflow nodemailer mailparser
npm install -D @types/nodemailer @types/mailparser
```

**Step 2: Verify installation**

Run: `npm ls imapflow nodemailer mailparser`
Expected: All three packages listed without errors.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(email): add imapflow, nodemailer, mailparser deps"
```

---

### Task 2: Add email config to `src/config.ts`

**Files:**
- Modify: `src/config.ts:9-14` (envConfig keys), append after line 75

**Step 1: Write failing test**

Create `src/channels/email.test.ts` with a minimal test:

```typescript
import { describe, it, expect } from 'vitest';

describe('email config', () => {
  it('EMAIL_POLL_INTERVAL defaults to 900000', async () => {
    const { EMAIL_POLL_INTERVAL } = await import('../config.js');
    expect(EMAIL_POLL_INTERVAL).toBe(900000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/email.test.ts`
Expected: FAIL — `EMAIL_POLL_INTERVAL` is not exported.

**Step 3: Add config exports**

In `src/config.ts`, add to the `readEnvFile` array (line 9-14):
```
'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS',
'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
'EMAIL_POLL_INTERVAL', 'EMAIL_FROM_NAME',
```

Append after line 75:
```typescript
// Email (IMAP/SMTP) configuration
export const IMAP_HOST = process.env.IMAP_HOST || envConfig.IMAP_HOST || '';
export const IMAP_PORT = parseInt(process.env.IMAP_PORT || envConfig.IMAP_PORT || '993', 10);
export const IMAP_USER = process.env.IMAP_USER || envConfig.IMAP_USER || '';
export const IMAP_PASS = process.env.IMAP_PASS || envConfig.IMAP_PASS || '';
export const SMTP_HOST = process.env.SMTP_HOST || envConfig.SMTP_HOST || '';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || envConfig.SMTP_PORT || '587', 10);
export const SMTP_USER = process.env.SMTP_USER || envConfig.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || envConfig.SMTP_PASS || '';
export const EMAIL_POLL_INTERVAL = parseInt(
  process.env.EMAIL_POLL_INTERVAL || envConfig.EMAIL_POLL_INTERVAL || '900000', 10,
);
export const EMAIL_FROM_NAME =
  process.env.EMAIL_FROM_NAME || envConfig.EMAIL_FROM_NAME || ASSISTANT_NAME;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/channels/email.test.ts`
Expected: PASS

**Step 5: Update .env.example**

Append to `.env.example`:
```
# Email (IMAP/SMTP)
# IMAP_HOST=imap.example.com
# IMAP_PORT=993
# IMAP_USER=user@example.com
# IMAP_PASS=app-password
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user@example.com
# SMTP_PASS=app-password
# EMAIL_POLL_INTERVAL=900000
# EMAIL_FROM_NAME=Andy
```

**Step 6: Commit**

```bash
git add src/config.ts src/channels/email.test.ts .env.example
git commit -m "feat(email): add IMAP/SMTP config exports"
```

---

### Task 3: Implement EmailChannel — IMAP polling and inbound delivery

**Files:**
- Create: `src/channels/email.ts`
- Test: `src/channels/email.test.ts` (extend)

**Step 1: Write failing tests for EmailChannel connect/disconnect/ownsJid**

Add to `src/channels/email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock imapflow
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn().mockResolvedValue([]),
    fetchOne: vi.fn(),
    messageFlagsAdd: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn(), close: vi.fn() }) },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../config.js', () => ({
  IMAP_HOST: 'imap.test.com', IMAP_PORT: 993,
  IMAP_USER: 'test@test.com', IMAP_PASS: 'pass',
  SMTP_HOST: 'smtp.test.com', SMTP_PORT: 587,
  SMTP_USER: 'test@test.com', SMTP_PASS: 'pass',
  EMAIL_POLL_INTERVAL: 900000,
  EMAIL_FROM_NAME: 'Andy',
  ASSISTANT_NAME: 'Andy',
  MAIN_GROUP_FOLDER: 'main',
}));

import { EmailChannel } from './email.js';

describe('EmailChannel', () => {
  it('has name "email"', () => {
    const ch = new EmailChannel({ onMessage: vi.fn(), onEmail: vi.fn() });
    expect(ch.name).toBe('email');
  });

  it('ownsJid returns true for email: prefix', () => {
    const ch = new EmailChannel({ onMessage: vi.fn(), onEmail: vi.fn() });
    expect(ch.ownsJid('email:abc123')).toBe(true);
    expect(ch.ownsJid('tg:123')).toBe(false);
  });

  it('connects and sets isConnected', async () => {
    const ch = new EmailChannel({ onMessage: vi.fn(), onEmail: vi.fn() });
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
  });

  it('disconnects cleanly', async () => {
    const ch = new EmailChannel({ onMessage: vi.fn(), onEmail: vi.fn() });
    await ch.connect();
    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/email.test.ts`
Expected: FAIL — `EmailChannel` doesn't exist yet.

**Step 3: Implement EmailChannel skeleton**

Create `src/channels/email.ts`:

```typescript
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import {
  IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  EMAIL_FROM_NAME,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';

export interface EmailChannelOpts {
  onMessage: (chatJid: string, message: NewMessage) => void;
  onEmail: (chatJid: string, metadata: EmailMetadata) => void;
}

export interface EmailMetadata {
  messageId: string;     // RFC2822 Message-ID
  from: string;          // sender email
  fromName: string;      // sender display name
  subject: string;       // email subject
  inReplyTo?: string;    // for threading
  references?: string;   // for threading
}

export class EmailChannel implements Channel {
  name = 'email';

  private imap: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processedIds = new Set<string>();
  private opts: EmailChannelOpts;

  // Thread metadata cache: email:msgId → EmailMetadata
  private threadCache = new Map<string, EmailMetadata>();

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: IMAP_PORT === 993,
      auth: { user: IMAP_USER, pass: IMAP_PASS },
      logger: false,
    });

    await this.imap.connect();

    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    this.connected = true;
    logger.info({ host: IMAP_HOST, user: IMAP_USER }, 'Email channel connected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Outbound email is handled via IPC email actions, not sendMessage.
    // This method is a no-op for the email channel since replies go through
    // the email_reply/email_send MCP tools -> IPC -> nodemailer.
    logger.debug({ jid }, 'EmailChannel.sendMessage called (no-op, use IPC email tools)');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.imap) {
      await this.imap.logout();
      this.imap = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    this.connected = false;
    logger.info('Email channel disconnected');
  }

  getThreadMetadata(jid: string): EmailMetadata | undefined {
    return this.threadCache.get(jid);
  }

  getTransporter(): Transporter | null {
    return this.transporter;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/email.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels/email.ts src/channels/email.test.ts
git commit -m "feat(email): add EmailChannel skeleton with IMAP/SMTP setup"
```

---

### Task 4: Implement IMAP polling loop

**Files:**
- Modify: `src/channels/email.ts`
- Test: `src/channels/email.test.ts` (extend)

**Step 1: Write failing test for poll**

Add test for `startPolling()` that verifies IMAP search and message delivery:

```typescript
describe('polling', () => {
  it('polls INBOX and delivers new messages', async () => {
    const onMessage = vi.fn();
    const onEmail = vi.fn();
    const ch = new EmailChannel({ onMessage, onEmail });
    await ch.connect();

    // Simulate a new email via the mock
    // (Mock imapflow to return a message UID, fetchOne to return parsed email)
    // ... (detailed mock setup for ImapFlow search + fetchOne)

    await ch.pollOnce(); // Expose for testing
    expect(onEmail).toHaveBeenCalled();
  });

  it('skips already processed message IDs', async () => {
    // ...
  });

  it('marks processed emails as read', async () => {
    // ...
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/email.test.ts`
Expected: FAIL — `pollOnce` doesn't exist.

**Step 3: Implement pollOnce()**

Add to `EmailChannel`:

```typescript
import { simpleParser } from 'mailparser';

async pollOnce(): Promise<void> {
  if (!this.imap) return;

  try {
    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      const uids = await this.imap.search({ seen: false }, { uid: true });

      for (const uid of uids) {
        const msg = await this.imap.fetchOne(String(uid), {
          source: true,
          uid: true,
        });

        if (!msg?.source) continue;

        const parsed = await simpleParser(msg.source);
        const msgId = parsed.messageId || `uid-${uid}`;

        if (this.processedIds.has(msgId)) continue;

        // Skip own emails
        const fromAddr = parsed.from?.value?.[0]?.address || '';
        if (fromAddr === IMAP_USER) continue;

        const fromName = parsed.from?.value?.[0]?.name || fromAddr;
        const subject = parsed.subject || '(kein Betreff)';
        const body = parsed.text || parsed.html || '';
        const chatJid = `email:${msgId}`;

        // Cache thread metadata for replies
        const metadata: EmailMetadata = {
          messageId: msgId,
          from: fromAddr,
          fromName,
          subject,
          inReplyTo: parsed.inReplyTo,
          references: Array.isArray(parsed.references)
            ? parsed.references.join(' ')
            : parsed.references || undefined,
        };
        this.threadCache.set(chatJid, metadata);

        // Handle attachments
        const attachmentInfo: string[] = [];
        if (parsed.attachments?.length) {
          const attachDir = path.join(process.cwd(), 'groups', 'main', 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          for (const att of parsed.attachments) {
            const safeName = `${Date.now()}-${att.filename || 'attachment'}`;
            const attPath = path.join(attachDir, safeName);
            fs.writeFileSync(attPath, att.content);
            attachmentInfo.push(`[Anhang: ${att.filename || 'datei'} (${attPath})]`);
          }
        }

        // Format as inbound message
        const content = [
          `[Email von ${fromName} <${fromAddr}>]`,
          `Betreff: ${subject}`,
          '',
          body.slice(0, 4000),
          ...attachmentInfo,
        ].join('\n');

        this.opts.onEmail(chatJid, metadata);
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: fromAddr,
          sender_name: fromName,
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        });

        // Mark as read
        await this.imap.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        this.processedIds.add(msgId);

        // Cap processed IDs at 5000
        if (this.processedIds.size > 5000) {
          const first = this.processedIds.values().next().value;
          if (first) this.processedIds.delete(first);
        }

        logger.info({ from: fromAddr, subject, chatJid }, 'Email received');
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, 'Email poll error');
  }
}

startPolling(intervalMs: number): void {
  // Immediate first poll
  this.pollOnce();
  this.pollTimer = setInterval(() => this.pollOnce(), intervalMs);
  logger.info({ intervalMs }, 'Email polling started');
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/email.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels/email.ts src/channels/email.test.ts
git commit -m "feat(email): implement IMAP polling with attachment support"
```

---

### Task 5: Add email MCP tools to container agent

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (append after line 281)

**Step 1: Add email_list tool**

```typescript
server.tool(
  'email_list',
  'List recent emails from the inbox. Returns subject, sender, date, and message ID for each.',
  {
    limit: z.number().default(10).describe('Max emails to return (default 10)'),
    search: z.string().optional().describe('IMAP search query (e.g., "FROM user@example.com", "SUBJECT invoice")'),
  },
  async (args) => {
    const data = {
      type: 'email_list',
      limit: args.limit,
      search: args.search,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Email list requested (limit: ${args.limit}). Results will appear shortly.` }] };
  },
);
```

**Step 2: Add email_read tool**

```typescript
server.tool(
  'email_read',
  'Read a specific email by its message ID. Returns full body and attachment info.',
  {
    message_id: z.string().describe('The email message ID (from email_list or from an incoming email notification)'),
  },
  async (args) => {
    const data = {
      type: 'email_read',
      messageId: args.message_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Email read requested.' }] };
  },
);
```

**Step 3: Add email_reply tool**

```typescript
server.tool(
  'email_reply',
  'Reply to an email. Threading headers (In-Reply-To, References) are set automatically.',
  {
    message_id: z.string().describe('The message ID of the email to reply to'),
    text: z.string().describe('The reply body text'),
    attachments: z.array(z.object({
      filename: z.string(),
      path: z.string().describe('Absolute path to file in container filesystem'),
    })).optional().describe('Optional file attachments'),
  },
  async (args) => {
    const data = {
      type: 'email_reply',
      messageId: args.message_id,
      text: args.text,
      attachments: args.attachments,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Email reply queued.' }] };
  },
);
```

**Step 4: Add email_forward tool**

```typescript
server.tool(
  'email_forward',
  'Forward an email to another recipient.',
  {
    message_id: z.string().describe('The message ID of the email to forward'),
    to: z.string().describe('Recipient email address'),
    comment: z.string().optional().describe('Optional comment to add above the forwarded message'),
  },
  async (args) => {
    const data = {
      type: 'email_forward',
      messageId: args.message_id,
      to: args.to,
      comment: args.comment,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Email forward to ${args.to} queued.` }] };
  },
);
```

**Step 5: Add email_send tool**

```typescript
server.tool(
  'email_send',
  'Compose and send a new email.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    text: z.string().describe('Email body text'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
    attachments: z.array(z.object({
      filename: z.string(),
      path: z.string().describe('Absolute path to file in container filesystem'),
    })).optional().describe('Optional file attachments'),
  },
  async (args) => {
    const data = {
      type: 'email_send',
      to: args.to,
      subject: args.subject,
      text: args.text,
      cc: args.cc,
      attachments: args.attachments,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Email to ${args.to} queued.` }] };
  },
);
```

**Step 6: Add email_search tool**

```typescript
server.tool(
  'email_search',
  'Search emails by criteria. Returns matching message IDs with subject and sender.',
  {
    from: z.string().optional().describe('Filter by sender email'),
    subject: z.string().optional().describe('Filter by subject (substring match)'),
    since: z.string().optional().describe('Only emails after this date (ISO format)'),
    limit: z.number().default(20).describe('Max results'),
  },
  async (args) => {
    const data = {
      type: 'email_search',
      from: args.from,
      subject: args.subject,
      since: args.since,
      limit: args.limit,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Email search requested.' }] };
  },
);
```

**Step 7: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(email): add email MCP tools (list, read, reply, forward, send, search)"
```

---

### Task 6: Handle email IPC actions in host

**Files:**
- Modify: `src/ipc.ts` — add email action handling in `processTaskIpc`
- Test: extend existing IPC tests or create `src/ipc-email.test.ts`

**Step 1: Write failing tests for email IPC handling**

Test that `processTaskIpc` handles `email_reply`, `email_send`, `email_forward` types by calling the email channel's transporter.

**Step 2: Run tests to verify they fail**

**Step 3: Implement email IPC handlers**

Add new cases to `processTaskIpc` switch in `src/ipc.ts`:

- `email_reply`: Look up thread metadata from EmailChannel, construct reply with correct `In-Reply-To` and `References` headers, send via nodemailer.
- `email_send`: Compose new email, send via nodemailer.
- `email_forward`: Fetch original email body, prepend comment, send to new recipient.
- `email_list`: Poll IMAP, format results, send back to agent via `deps.sendMessage`.
- `email_search`: IMAP search, format results, send back.
- `email_read`: Fetch full email, format, send back.

The `IpcDeps` interface needs an optional `emailChannel` property:
```typescript
emailChannel?: EmailChannel;
```

**Step 4: Run tests to verify they pass**

**Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-email.test.ts
git commit -m "feat(email): handle email IPC actions (reply, send, forward, list, search, read)"
```

---

### Task 7: Wire EmailChannel into main orchestrator

**Files:**
- Modify: `src/index.ts:482-493` (channel creation block)

**Step 1: Write integration test**

Verify that when `IMAP_HOST` is set, an `EmailChannel` is created and added to `channels`.

**Step 2: Run test to verify it fails**

**Step 3: Add EmailChannel to main()**

After the Telegram channel block (line 487), add:

```typescript
import { EmailChannel } from './channels/email.js';
import { IMAP_HOST, EMAIL_POLL_INTERVAL } from './config.js';

// In main():
if (IMAP_HOST) {
  const emailChannel = new EmailChannel({
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onEmail: (chatJid, metadata) => {
      // Store as chat metadata for discovery
      storeChatMetadata(chatJid, new Date().toISOString(), metadata.fromName, 'email', false);
    },
  });
  channels.push(emailChannel);
  await emailChannel.connect();
  emailChannel.startPolling(EMAIL_POLL_INTERVAL);
}
```

Also pass `emailChannel` to IPC watcher deps so email actions can access the transporter and thread cache.

**Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 5: Run build**

Run: `npm run build`
Expected: Clean build.

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(email): wire EmailChannel into main orchestrator"
```

---

### Task 8: Add email rules to CLAUDE.md

**Files:**
- Modify: `groups/main/CLAUDE.md`

**Step 1: Add email handling section**

Insert after the "Telegram Formatting" section:

```markdown
## E-Mail-Verarbeitung

Du hast Zugriff auf ein E-Mail-Postfach via IMAP/SMTP. Neue E-Mails werden dir automatisch alle 15 Minuten zugestellt.

### Hybrid-Regeln

Bewerte jede eingehende E-Mail und handle nach diesen Regeln:

**Autonom ignorieren (keine Antwort, kein Bericht):**
- Spam, Newsletter, Werbung
- Automatische Benachrichtigungen (Versand, Logins, etc.)

**In Telegram melden (nicht selbst antworten):**
- Persönliche E-Mails von echten Personen
- Rechnungen und Zahlungsaufforderungen
- Anfragen die eine Entscheidung erfordern
- Alles was du nicht sicher einordnen kannst

**Autonom beantworten (nach Telegram-Bericht):**
- Nur wenn der Nutzer dich explizit dazu auffordert

### E-Mail-Tools

- `email_list` — Postfach durchsuchen
- `email_read` — Einzelne Mail lesen
- `email_reply` — Auf eine Mail antworten (Thread-Headers automatisch)
- `email_forward` — Mail weiterleiten
- `email_send` — Neue Mail verfassen
- `email_search` — Mails nach Kriterien suchen

### Format für Telegram-Berichte

Wenn du neue E-Mails in Telegram meldest, nutze dieses Format:
- Absender, Betreff, kurze Zusammenfassung (2-3 Sätze)
- Frage ob du antworten/weiterleiten sollst
```

**Step 2: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat(email): add hybrid email rules to CLAUDE.md"
```

---

### Task 9: Rebuild container and restart

**Files:** None (operational step)

**Step 1: Rebuild container image**

Run: `./container/build.sh`
Expected: Build succeeds (needed because MCP tools changed in `ipc-mcp-stdio.ts`).

**Step 2: Sync env**

```bash
cp .env data/env/env
```

**Step 3: Restart service**

```bash
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Step 4: Verify**

Run: `tail -f logs/nanoclaw.log | grep -i email`
Expected: "Email channel connected" and "Email polling started" in logs.

---

### Task 10: End-to-end test

**Step 1: Send a test email to the configured IMAP account**

**Step 2: Wait for poll (or trigger manually via Telegram: "Check meine Mails")**

**Step 3: Verify Andy reports the email in Telegram**

**Step 4: Test reply via Telegram: "Antworte auf die Mail mit: Danke, erhalten."**

**Step 5: Verify reply arrives at sender**

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat(email): complete IMAP/SMTP integration"
```
