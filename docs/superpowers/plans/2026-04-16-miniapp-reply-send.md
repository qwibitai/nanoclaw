# Mini-App Reply/Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-tap reply approval (with 10s undo) to the nanoclaw email mini-app on top of the existing agent-drafted reply pipeline.

**Architecture:** A new `PendingSendRegistry` holds in-memory 10s timers per `draftId`. The mini-app exposes three JSON API routes (save / send / cancel) plus a render route (`GET /reply/:draftId`). The Gmail channel grows two methods: `getDraftReplyContext` (composite read of current body + incoming-message headers) and `sendDraft`. On send failure, a new event-bus type `email.draft.send_failed` routes a Telegram notification via the existing push-manager.

**Tech Stack:** TypeScript (Node), Express 4, googleapis (Gmail API v1), vitest, pino logger, better-sqlite3, Telegram grammY.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `src/mini-app/pending-send.ts` | `PendingSendRegistry` class (pure logic, no Express) |
| `src/mini-app/pending-send.test.ts` | Unit tests for the registry |
| `src/__tests__/mini-app-draft-send-routes.test.ts` | Route handler tests (save/send/cancel/reply) |
| `src/__tests__/mini-app-send-integration.test.ts` | End-to-end with mocked GmailOps |

### Modified files

| Path | Change |
|------|--------|
| `src/gmail-ops.ts` | Add `getDraftReplyContext` + `sendDraft` + `DraftReplyContext` type |
| `src/channels/gmail.ts` | Implement the two new GmailOpsProvider methods |
| `src/channels/gmail.test.ts` | Add tests for both new methods |
| `src/__tests__/gmail-channel-ops.test.ts` | Extend `GmailOpsRouter` routing tests |
| `src/events.ts` | Add `email.draft.send_failed` event type + interface |
| `src/mini-app/server.ts` | 4 new routes + `PendingSendRegistry` instance + event-bus emit |
| `src/mini-app/templates/email-full.ts` | Textarea + Send/Edit-in-Gmail/Archive buttons + undo banner + inline JS |
| `src/callback-router.ts` | "Full Email" callback picks `/reply/:draftId` when a draft exists |
| `src/index.ts` | Wire `pendingSendRegistry.shutdown()` into SIGTERM/SIGINT; subscribe to `email.draft.send_failed` and route via push-manager |

---

## Task 1: `PendingSendRegistry`

**Files:**
- Create: `src/mini-app/pending-send.ts`
- Test: `src/mini-app/pending-send.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/mini-app/pending-send.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingSendRegistry } from './pending-send.js';

describe('PendingSendRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onFire after delayMs', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    const { sendAt } = reg.schedule('draft1', 'personal', 1000, onFire);
    expect(sendAt).toBeGreaterThan(Date.now());
    expect(reg.has('draft1')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).toHaveBeenCalledOnce();
    expect(reg.has('draft1')).toBe(false);
  });

  it('schedule with same draftId replaces prior timer', async () => {
    const reg = new PendingSendRegistry();
    const onFire1 = vi.fn().mockResolvedValue(undefined);
    const onFire2 = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire1);
    reg.schedule('draft1', 'personal', 1000, onFire2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire1).not.toHaveBeenCalled();
    expect(onFire2).toHaveBeenCalledOnce();
  });

  it('cancel before fire returns true and prevents fire', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire);
    expect(reg.cancel('draft1')).toBe(true);
    expect(reg.has('draft1')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('cancel after fire returns false', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reg.cancel('draft1')).toBe(false);
  });

  it('cancel of unknown draftId returns false', () => {
    const reg = new PendingSendRegistry();
    expect(reg.cancel('never-scheduled')).toBe(false);
  });

  it('shutdown clears all timers without firing', async () => {
    const reg = new PendingSendRegistry();
    const onFire1 = vi.fn().mockResolvedValue(undefined);
    const onFire2 = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire1);
    reg.schedule('draft2', 'personal', 1000, onFire2);
    reg.shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire1).not.toHaveBeenCalled();
    expect(onFire2).not.toHaveBeenCalled();
    expect(reg.has('draft1')).toBe(false);
    expect(reg.has('draft2')).toBe(false);
  });

  it('onFire rejection is caught and does not crash', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockRejectedValue(new Error('gmail api down'));
    reg.schedule('draft1', 'personal', 1000, onFire);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).toHaveBeenCalledOnce();
    // no uncaught rejection; registry cleaned up
    expect(reg.has('draft1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mini-app/pending-send.test.ts`
Expected: FAIL — module `./pending-send.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/mini-app/pending-send.ts`:

```ts
import { logger } from '../logger.js';

export interface PendingSend {
  draftId: string;
  account: string;
  sendAt: number;
  timer: NodeJS.Timeout;
}

export type OnFire = (draftId: string, account: string) => Promise<void>;

export class PendingSendRegistry {
  private pending = new Map<string, PendingSend>();

  schedule(
    draftId: string,
    account: string,
    delayMs: number,
    onFire: OnFire,
  ): { sendAt: number } {
    // Replace any existing timer for this draftId
    this.cancel(draftId);

    const sendAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      // Remove from pending BEFORE firing so cancel() post-fire returns false.
      this.pending.delete(draftId);
      onFire(draftId, account).catch((err) => {
        logger.error(
          { draftId, account, err },
          'Pending send onFire rejected',
        );
      });
    }, delayMs);

    this.pending.set(draftId, { draftId, account, sendAt, timer });
    return { sendAt };
  }

  cancel(draftId: string): boolean {
    const entry = this.pending.get(draftId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(draftId);
    return true;
  }

  has(draftId: string): boolean {
    return this.pending.has(draftId);
  }

  shutdown(): void {
    const draftIds = Array.from(this.pending.keys());
    if (draftIds.length > 0) {
      logger.warn(
        { pendingCount: draftIds.length, draftIds },
        'Pending send dropped at shutdown',
      );
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mini-app/pending-send.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mini-app/pending-send.ts src/mini-app/pending-send.test.ts
git commit -m "feat(mini-app): add PendingSendRegistry for deferred draft sends"
```

---

## Task 2: New event type `email.draft.send_failed`

**Files:**
- Modify: `src/events.ts`

- [ ] **Step 1: Add the event interface**

Open `src/events.ts` and find the block of email-related event interfaces (near `EmailDraftCreatedEvent`). Add this interface after `EmailActionCompletedEvent`:

```ts
export interface EmailDraftSendFailedEvent {
  type: 'email.draft.send_failed';
  timestamp: number;
  source: string;
  draftId: string;
  account: string;
  subject?: string;
  threadId?: string;
  error: string;
}
```

- [ ] **Step 2: Register in EventMap**

In the same file, find the `EventMap` interface (currently around line 563). Add this line at the end of the email section (after `'email.action.completed'`):

```ts
  'email.draft.send_failed': EmailDraftSendFailedEvent;
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): add email.draft.send_failed event type"
```

---

## Task 3: Extend `GmailOps` / `GmailOpsProvider` interfaces

**Files:**
- Modify: `src/gmail-ops.ts`

- [ ] **Step 1: Add types and methods**

Replace the contents of `src/gmail-ops.ts` with:

```ts
import type { DraftInfo } from './draft-enrichment.js';

export interface DraftReplyContext {
  body: string;
  incoming: {
    from: string;
    to: string;
    subject: string;
    date: string;
    cc?: string;
  };
}

export interface GmailOps {
  archiveThread(account: string, threadId: string): Promise<void>;
  listRecentDrafts(account: string): Promise<DraftInfo[]>;
  updateDraft(account: string, draftId: string, newBody: string): Promise<void>;
  getMessageBody(account: string, messageId: string): Promise<string | null>;
  getDraftReplyContext(
    account: string,
    draftId: string,
  ): Promise<DraftReplyContext | null>;
  sendDraft(account: string, draftId: string): Promise<void>;
}

export interface GmailOpsProvider {
  archiveThread(threadId: string): Promise<void>;
  listRecentDrafts(): Promise<DraftInfo[]>;
  updateDraft(draftId: string, newBody: string): Promise<void>;
  getMessageBody(messageId: string): Promise<string | null>;
  getDraftReplyContext(draftId: string): Promise<DraftReplyContext | null>;
  sendDraft(draftId: string): Promise<void>;
}

export class GmailOpsRouter implements GmailOps {
  private channels = new Map<string, GmailOpsProvider>();

  register(alias: string, channel: GmailOpsProvider): void {
    this.channels.set(alias, channel);
  }

  private getChannel(account: string): GmailOpsProvider {
    const ch = this.channels.get(account);
    if (!ch)
      throw new Error(`No Gmail channel registered for account: ${account}`);
    return ch;
  }

  async archiveThread(account: string, threadId: string): Promise<void> {
    return this.getChannel(account).archiveThread(threadId);
  }

  async listRecentDrafts(account: string): Promise<DraftInfo[]> {
    return this.getChannel(account).listRecentDrafts();
  }

  async updateDraft(
    account: string,
    draftId: string,
    newBody: string,
  ): Promise<void> {
    return this.getChannel(account).updateDraft(draftId, newBody);
  }

  async getMessageBody(
    account: string,
    messageId: string,
  ): Promise<string | null> {
    return this.getChannel(account).getMessageBody(messageId);
  }

  async getDraftReplyContext(
    account: string,
    draftId: string,
  ): Promise<DraftReplyContext | null> {
    return this.getChannel(account).getDraftReplyContext(draftId);
  }

  async sendDraft(account: string, draftId: string): Promise<void> {
    return this.getChannel(account).sendDraft(draftId);
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: FAIL — `GmailChannel` in `src/channels/gmail.ts` does not yet implement `getDraftReplyContext` and `sendDraft`. That's expected; Task 4 adds them.

- [ ] **Step 3: Do NOT commit yet**

Leave this file modified; commit together with Task 4 once the Gmail channel implements the new methods. If committed alone, the repo will not build.

---

## Task 4: Gmail channel impl — `getDraftReplyContext` + `sendDraft`

**Files:**
- Modify: `src/channels/gmail.ts`
- Test: `src/channels/gmail.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `src/channels/gmail.test.ts`. Add this import at the top (if `describe` etc. are already imported, just add the channel import):

```ts
import { GmailChannel } from './gmail.js';
import { gmail_v1 } from 'googleapis';
```

Append these tests at the end of the existing `describe` block (or in a new describe):

```ts
describe('GmailChannel.getDraftReplyContext', () => {
  function makeChannel(gmailMock: Partial<gmail_v1.Gmail>): GmailChannel {
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = gmailMock as gmail_v1.Gmail;
    return ch;
  }

  it('returns composite body + incoming headers for a live draft', async () => {
    const draftsGet = vi.fn().mockResolvedValue({
      data: {
        message: {
          threadId: 'thread-abc',
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Agent draft body here').toString('base64url') },
            headers: [],
          },
        },
      },
    });
    const threadsGet = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: 'msg1',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'me@example.com' },
                { name: 'Subject', value: 'Ping' },
                { name: 'Date', value: 'Thu, 16 Apr 2026 18:00:00 -0700' },
              ],
            },
          },
          // The draft itself is also in the thread with label DRAFT; must be skipped
          {
            id: 'msg2',
            labelIds: ['DRAFT'],
            payload: { headers: [] },
          },
        ],
      },
    });

    const ch = makeChannel({
      users: {
        drafts: { get: draftsGet },
        threads: { get: threadsGet },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = await ch.getDraftReplyContext('draft-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.body).toBe('Agent draft body here');
    expect(ctx!.incoming.from).toBe('alice@example.com');
    expect(ctx!.incoming.subject).toBe('Ping');
    expect(ctx!.incoming.to).toBe('me@example.com');
    expect(draftsGet).toHaveBeenCalledWith({
      userId: 'me',
      id: 'draft-1',
      format: 'full',
    });
  });

  it('returns null when the draft is gone (404)', async () => {
    const draftsGet = vi.fn().mockRejectedValue({ code: 404 });
    const ch = makeChannel({
      users: { drafts: { get: draftsGet }, threads: { get: vi.fn() } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const ctx = await ch.getDraftReplyContext('missing');
    expect(ctx).toBeNull();
  });
});

describe('GmailChannel.sendDraft', () => {
  it('calls gmail.users.drafts.send with the draft id', async () => {
    const draftsSend = vi.fn().mockResolvedValue({
      data: { id: 'sent-msg-1', threadId: 'thread-abc' },
    });
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { drafts: { send: draftsSend } } } as any;

    await ch.sendDraft('draft-1');
    expect(draftsSend).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { id: 'draft-1' },
    });
  });

  it('propagates errors from Gmail API', async () => {
    const draftsSend = vi
      .fn()
      .mockRejectedValue(new Error('quota exceeded'));
    const ch = new GmailChannel(
      {
        onMessage: async () => {},
        onChatMetadata: async () => {},
        registeredGroups: () => ({}),
      },
      'personal',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).gmail = { users: { drafts: { send: draftsSend } } } as any;
    await expect(ch.sendDraft('draft-1')).rejects.toThrow('quota exceeded');
  });
});
```

(Ensure `vi` is imported at the top of the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/gmail.test.ts`
Expected: FAIL — methods `getDraftReplyContext` / `sendDraft` do not exist on `GmailChannel`.

- [ ] **Step 3: Implement the methods**

Open `src/channels/gmail.ts`. Add an import at the top (if not already present):

```ts
import type { DraftReplyContext } from '../gmail-ops.js';
```

Then, find the existing `getMessageBody` method (around line 451). Immediately AFTER it (but still inside the class), add:

```ts
async getDraftReplyContext(draftId: string): Promise<DraftReplyContext | null> {
  if (!this.gmail) throw new Error('Gmail not connected');
  try {
    const draft = await this.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'full',
    });
    const msg = draft.data.message;
    if (!msg) return null;
    const body = this.extractTextBody(msg.payload);
    const threadId = msg.threadId;
    if (!threadId) {
      return {
        body,
        incoming: { from: '', to: '', subject: '', date: '' },
      };
    }
    const thread = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
    });
    // Find the most recent non-draft message in the thread.
    const nonDraft = (thread.data.messages || [])
      .slice()
      .reverse()
      .find((m) => !(m.labelIds || []).includes('DRAFT'));
    const headers = nonDraft?.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';
    return {
      body,
      incoming: {
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        cc: getHeader('Cc') || undefined,
      },
    };
  } catch (err: unknown) {
    const maybe = err as { code?: number };
    if (maybe && maybe.code === 404) return null;
    logger.warn(
      { draftId, err, account: this.accountAlias },
      'Failed to fetch draft reply context',
    );
    throw err;
  }
}

async sendDraft(draftId: string): Promise<void> {
  if (!this.gmail) throw new Error('Gmail not connected');
  const started = Date.now();
  try {
    const res = await this.gmail.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });
    logger.info(
      {
        account: this.accountAlias,
        draftId,
        threadId: res.data.threadId,
        elapsedMs: Date.now() - started,
      },
      'Draft sent',
    );
  } catch (err) {
    logger.error(
      { account: this.accountAlias, draftId, err },
      'Draft send failed',
    );
    throw err;
  }
}
```

- [ ] **Step 4: Run full build + tests**

Run: `npm run build && npx vitest run src/channels/gmail.test.ts src/gmail-ops.ts`
Expected: PASS on both. Build should now be clean (Task 3's interface change is satisfied).

- [ ] **Step 5: Commit (with Task 3's changes)**

```bash
git add src/gmail-ops.ts src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): add getDraftReplyContext and sendDraft"
```

---

## Task 5: GmailOpsRouter routing tests

**Files:**
- Test: `src/__tests__/gmail-channel-ops.test.ts`

- [ ] **Step 1: Add failing routing tests**

Open `src/__tests__/gmail-channel-ops.test.ts`. Append inside the existing describe block:

```ts
it('routes getDraftReplyContext to the registered channel', async () => {
  const router = new GmailOpsRouter();
  const fake: GmailOpsProvider = {
    archiveThread: vi.fn(),
    listRecentDrafts: vi.fn(),
    updateDraft: vi.fn(),
    getMessageBody: vi.fn(),
    getDraftReplyContext: vi.fn().mockResolvedValue({
      body: 'hi',
      incoming: { from: 'a', to: 'b', subject: 's', date: 'd' },
    }),
    sendDraft: vi.fn(),
  };
  router.register('personal', fake);
  const ctx = await router.getDraftReplyContext('personal', 'draft-1');
  expect(ctx?.body).toBe('hi');
  expect(fake.getDraftReplyContext).toHaveBeenCalledWith('draft-1');
});

it('routes sendDraft to the registered channel', async () => {
  const router = new GmailOpsRouter();
  const fake: GmailOpsProvider = {
    archiveThread: vi.fn(),
    listRecentDrafts: vi.fn(),
    updateDraft: vi.fn(),
    getMessageBody: vi.fn(),
    getDraftReplyContext: vi.fn(),
    sendDraft: vi.fn().mockResolvedValue(undefined),
  };
  router.register('whoisxml', fake);
  await router.sendDraft('whoisxml', 'draft-2');
  expect(fake.sendDraft).toHaveBeenCalledWith('draft-2');
});

it('throws for unknown account on sendDraft', async () => {
  const router = new GmailOpsRouter();
  await expect(router.sendDraft('nope', 'd')).rejects.toThrow(
    'No Gmail channel registered for account: nope',
  );
});
```

(If `GmailOpsProvider` isn't imported already, add: `import { GmailOpsRouter, GmailOpsProvider } from '../gmail-ops.js';`)

- [ ] **Step 2: Run tests to verify pass**

Run: `npx vitest run src/__tests__/gmail-channel-ops.test.ts`
Expected: PASS (3 new + existing).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/gmail-channel-ops.test.ts
git commit -m "test(gmail-ops): cover getDraftReplyContext and sendDraft routing"
```

---

## Task 6: New routes in `src/mini-app/server.ts`

**Files:**
- Modify: `src/mini-app/server.ts`
- Test: `src/__tests__/mini-app-draft-send-routes.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `src/__tests__/mini-app-draft-send-routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { _initTestDatabase, getDb } from '../db.js';
import { EventBus } from '../event-bus.js';
import type { GmailOps } from '../gmail-ops.js';
import { startMiniAppServer } from '../mini-app/server.js';

function seedDraft(draftId: string, account: string, body = 'orig') {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS draft_originals (
    draft_id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    original_body TEXT NOT NULL,
    enriched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    draftId,
    account,
    body,
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
}

function makeGmailOpsMock(overrides: Partial<GmailOps> = {}): GmailOps {
  return {
    archiveThread: vi.fn().mockResolvedValue(undefined),
    listRecentDrafts: vi.fn().mockResolvedValue([]),
    updateDraft: vi.fn().mockResolvedValue(undefined),
    getMessageBody: vi.fn().mockResolvedValue(''),
    getDraftReplyContext: vi.fn().mockResolvedValue({
      body: 'current enriched body',
      incoming: {
        from: 'alice@example.com',
        to: 'me@example.com',
        subject: 'Ping',
        date: 'Thu, 16 Apr 2026 18:00:00 -0700',
      },
    }),
    sendDraft: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('mini-app draft send routes', () => {
  let app: express.Express;
  let gmailOps: GmailOps;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();
    gmailOps = makeGmailOpsMock();
    eventBus = new EventBus();
    app = startMiniAppServer({
      port: 0,
      gmailOps,
      eventBus,
      returnAppOnly: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as express.Express;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET /reply/:draftId', () => {
    it('renders HTML with incoming headers and textarea body', async () => {
      seedDraft('d1', 'personal');
      const res = await request(app).get('/reply/d1?account=personal');
      expect(res.status).toBe(200);
      expect(res.text).toContain('alice@example.com');
      expect(res.text).toContain('current enriched body');
      expect(res.text).toContain('<textarea');
    });

    it('renders stub when draft row is missing', async () => {
      const res = await request(app).get('/reply/missing?account=personal');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Draft no longer exists');
    });
  });

  describe('PATCH /api/draft/:draftId/save', () => {
    it('saves body via updateDraft', async () => {
      seedDraft('d1', 'personal');
      const res = await request(app)
        .patch('/api/draft/d1/save')
        .send({ body: 'new body' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(gmailOps.updateDraft).toHaveBeenCalledWith(
        'personal',
        'd1',
        'new body',
      );
    });

    it('returns 404 with DRAFT_NOT_FOUND when missing', async () => {
      const res = await request(app)
        .patch('/api/draft/missing/save')
        .send({ body: 'x' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        ok: false,
        error: expect.any(String),
        code: 'DRAFT_NOT_FOUND',
      });
    });
  });

  describe('POST /api/draft/:draftId/send and /send/cancel', () => {
    it('schedules send and returns sendAt', async () => {
      seedDraft('d1', 'personal');
      const res = await request(app).post('/api/draft/d1/send').send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.sendAt).toBe('number');
      expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    });

    it('cancels a pending send', async () => {
      seedDraft('d1', 'personal');
      await request(app).post('/api/draft/d1/send').send({});
      const res = await request(app).post('/api/draft/d1/send/cancel').send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, cancelled: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    });

    it('reports cancelled=false if not pending', async () => {
      seedDraft('d1', 'personal');
      const res = await request(app).post('/api/draft/d1/send/cancel').send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, cancelled: false });
    });

    it('fires sendDraft after 10 seconds', async () => {
      seedDraft('d1', 'personal');
      await request(app).post('/api/draft/d1/send').send({});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gmailOps.sendDraft).toHaveBeenCalledWith('personal', 'd1');
    });
  });
});
```

Add `supertest` to devDependencies if not already present:

Run: `npm ls supertest 2>/dev/null | head -3`
If missing: `npm install --save-dev supertest @types/supertest`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/mini-app-draft-send-routes.test.ts`
Expected: FAIL — routes and `returnAppOnly` option don't exist yet.

- [ ] **Step 3: Modify `src/mini-app/server.ts`**

Read the current `src/mini-app/server.ts` to understand the existing startup pattern and `Opts` shape. Then:

1. Add imports at the top:

```ts
import { PendingSendRegistry } from './pending-send.js';
import { renderEmailFull } from './templates/email-full.js';
import type { EventBus } from '../event-bus.js';
```

2. Extend the `Opts` interface (or equivalent) to include:

```ts
eventBus?: EventBus;
returnAppOnly?: boolean; // for testing: return the Express app instead of starting a listener
pendingSendRegistry?: PendingSendRegistry; // injectable; defaults to new one
```

3. Inside `startMiniAppServer`, instantiate the registry:

```ts
const registry = opts.pendingSendRegistry ?? new PendingSendRegistry();
```

4. Add a helper at the top of the file:

```ts
function lookupDraftAccount(draftId: string): string | null {
  const row = getDb()
    .prepare('SELECT account FROM draft_originals WHERE draft_id = ?')
    .get(draftId) as { account: string } | undefined;
  return row?.account ?? null;
}
```

5. Add the four routes immediately AFTER the existing `/draft-diff/:draftId` route (but BEFORE `app.listen`):

```ts
// --- Reply view (render) ---
app.get('/reply/:draftId', async (req, res) => {
  const { draftId } = req.params;
  const account = lookupDraftAccount(draftId);
  if (!account) {
    res
      .type('html')
      .send(
        '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
      );
    return;
  }
  if (!opts.gmailOps) {
    res.status(500).type('html').send('Gmail ops not configured');
    return;
  }
  try {
    const ctx = await opts.gmailOps.getDraftReplyContext(account, draftId);
    if (!ctx) {
      res
        .type('html')
        .send(
          '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
        );
      return;
    }
    const html = renderEmailFull({
      mode: 'reply',
      draftId,
      account,
      subject: ctx.incoming.subject,
      from: ctx.incoming.from,
      to: ctx.incoming.to,
      cc: ctx.incoming.cc,
      date: ctx.incoming.date,
      body: ctx.body,
      attachments: [],
    });
    res.type('html').send(html);
  } catch (err) {
    logger.error({ draftId, err }, 'Failed to render /reply');
    res.status(500).type('html').send('Failed to load draft');
  }
});

// --- Save draft body ---
app.patch('/api/draft/:draftId/save', async (req, res) => {
  const { draftId } = req.params;
  const body = req.body?.body;
  if (typeof body !== 'string') {
    res.status(400).json({
      ok: false,
      error: 'body field must be a string',
      code: 'INVALID_BODY',
    });
    return;
  }
  const account = lookupDraftAccount(draftId);
  if (!account) {
    res.status(404).json({
      ok: false,
      error: 'Draft not found',
      code: 'DRAFT_NOT_FOUND',
    });
    return;
  }
  if (!opts.gmailOps) {
    res
      .status(500)
      .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
    return;
  }
  try {
    await opts.gmailOps.updateDraft(account, draftId, body);
    logger.info(
      { account, draftId, bodyLen: body.length, component: 'mini-app' },
      'Draft save via mini-app',
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error(
      { account, draftId, err, component: 'mini-app' },
      'Draft save failed from mini-app',
    );
    res.status(500).json({
      ok: false,
      error: 'Gmail API error',
      code: 'GMAIL_API_ERROR',
    });
  }
});

// --- Schedule send with 10s undo window ---
app.post('/api/draft/:draftId/send', async (req, res) => {
  const { draftId } = req.params;
  const account = lookupDraftAccount(draftId);
  if (!account) {
    res.status(404).json({
      ok: false,
      error: 'Draft not found',
      code: 'DRAFT_NOT_FOUND',
    });
    return;
  }
  if (!opts.gmailOps) {
    res
      .status(500)
      .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
    return;
  }
  const delayMs = 10_000;
  const { sendAt } = registry.schedule(
    draftId,
    account,
    delayMs,
    async (id, acct) => {
      try {
        await opts.gmailOps!.sendDraft(acct, id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { account: acct, draftId: id, err, component: 'mini-app' },
          'Draft send failed',
        );
        opts.eventBus?.emit('email.draft.send_failed', {
          type: 'email.draft.send_failed',
          timestamp: Date.now(),
          source: 'mini-app',
          draftId: id,
          account: acct,
          error: message,
        });
      }
    },
  );
  logger.info(
    { account, draftId, sendAt, delayMs, component: 'mini-app' },
    'Draft send scheduled',
  );
  res.json({ ok: true, sendAt });
});

// --- Cancel pending send ---
app.post('/api/draft/:draftId/send/cancel', (req, res) => {
  const { draftId } = req.params;
  const cancelled = registry.cancel(draftId);
  if (cancelled) {
    logger.info(
      { draftId, component: 'mini-app' },
      'Draft send cancelled',
    );
  }
  res.json({ ok: true, cancelled });
});
```

6. Update the return value: if `opts.returnAppOnly`, return the Express `app` instead of starting the listener. Also expose the registry on the returned object for cleanup.

```ts
if (opts.returnAppOnly) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app as any;
}
const server = app.listen(opts.port, () => {
  logger.info({ port: opts.port }, 'Mini App server listening');
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
return { server, registry } as any;
```

7. Also update `email-full.ts` prop types used here — they'll be added in Task 7. For now, cast to `any` if the compiler complains; Task 7 will fix types.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/mini-app-draft-send-routes.test.ts`
Expected: PASS (7 tests).

Run: `npm run build`
Expected: clean compile (the template prop additions happen in Task 7; if this task compiles with `as any` casts, that's acceptable — clean up in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/mini-app/server.ts src/__tests__/mini-app-draft-send-routes.test.ts package.json package-lock.json
git commit -m "feat(mini-app): add reply render + save/send/cancel routes"
```

---

## Task 7: Template update — `email-full.ts`

**Files:**
- Modify: `src/mini-app/templates/email-full.ts`

- [ ] **Step 1: Replace the template**

Replace the entire contents of `src/mini-app/templates/email-full.ts` with:

```ts
export interface EmailFullData {
  mode?: 'view' | 'reply'; // default: 'view' (backward compatible)
  draftId?: string; // required when mode === 'reply'
  account?: string; // required when mode === 'reply'
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: Array<{ name: string; size: string }>;
  cc?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEmailFull(data: EmailFullData): string {
  const mode = data.mode ?? 'view';
  const attachmentsHtml =
    data.attachments.length > 0
      ? `<div style="border-top:1px solid #21262d;padding-top:12px;margin-top:12px;"><div style="font-size:11px;color:#484f58;margin-bottom:8px;">ATTACHMENTS</div>${data.attachments.map((a) => `<div style="font-size:13px;color:#58a6ff;">📎 ${escapeHtml(a.name)} (${escapeHtml(a.size)})</div>`).join('')}</div>`
      : '';

  const replyControls =
    mode === 'reply' && data.draftId && data.account
      ? renderReplyControls(data.draftId, data.account, data.body)
      : `<div class="body">${data.body}</div>${attachmentsHtml}<div class="actions"><button class="btn" style="background:#276749;color:#c6f6d5;">Archive</button><button class="btn">Open in Gmail</button></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.subject)}</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
    .header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 16px; }
    .subject { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .meta { font-size: 12px; color: #8b949e; line-height: 1.6; }
    .body { font-size: 14px; line-height: 1.6; }
    .actions { border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { background: #21262d; color: #c9d1d9; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; cursor: pointer; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .compose { width: 100%; box-sizing: border-box; background: #0d1117; color: #c9d1d9; border: 1px solid #21262d; border-radius: 6px; padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 180px; }
    .undo-banner { display: none; border-top: 1px solid #21262d; padding-top: 12px; margin-top: 16px; color: #c9d1d9; font-size: 14px; }
    .undo-banner .countdown { color: #58a6ff; font-weight: 600; }
    .err { color: #f85149; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="subject">${escapeHtml(data.subject)}</div>
    <div class="meta">
      <div><b>From:</b> ${escapeHtml(data.from)}</div>
      <div><b>To:</b> ${escapeHtml(data.to)}</div>
      ${data.cc ? `<div><b>CC:</b> ${escapeHtml(data.cc)}</div>` : ''}
      <div><b>Date:</b> ${escapeHtml(data.date)}</div>
    </div>
  </div>
  ${replyControls}
</body>
</html>`;
}

function renderReplyControls(
  draftId: string,
  account: string,
  draftBody: string,
): string {
  return `
  <textarea id="compose" class="compose" placeholder="Agent's draft — edit before sending">${escapeHtml(draftBody)}</textarea>
  <div class="err" id="err" style="display:none"></div>
  <div class="actions" id="actions">
    <button class="btn" id="send-btn" style="background:#1f6feb;color:#fff;">Send</button>
    <button class="btn" id="edit-gmail-btn">Edit in Gmail</button>
    <button class="btn" id="archive-btn" style="background:#276749;color:#c6f6d5;">Archive</button>
  </div>
  <div class="undo-banner" id="undo-banner">
    Sending in <span class="countdown" id="countdown">10</span>s —
    <button class="btn" id="undo-btn" style="background:#f85149;color:#fff;margin-left:8px;">Undo</button>
  </div>
  <script>
    (function(){
      const draftId = ${JSON.stringify(draftId)};
      const account = ${JSON.stringify(account)};
      const compose = document.getElementById('compose');
      const sendBtn = document.getElementById('send-btn');
      const editBtn = document.getElementById('edit-gmail-btn');
      const archiveBtn = document.getElementById('archive-btn');
      const actions = document.getElementById('actions');
      const banner = document.getElementById('undo-banner');
      const undoBtn = document.getElementById('undo-btn');
      const countdown = document.getElementById('countdown');
      const err = document.getElementById('err');
      let countdownTimer = null;

      function showError(msg){ err.textContent = msg; err.style.display = 'block'; }
      function clearError(){ err.style.display = 'none'; }
      async function saveBody(){
        clearError();
        const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/save', {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ body: compose.value }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'Save failed');
      }

      sendBtn.addEventListener('click', async () => {
        try {
          sendBtn.disabled = true;
          await saveBody();
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}',
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || 'Send failed');
          actions.style.display = 'none';
          banner.style.display = 'block';
          let remaining = 10;
          countdown.textContent = remaining;
          countdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(countdownTimer);
              banner.innerHTML = '<span style="color:#6ca368;">Sent.</span>';
              setTimeout(() => { banner.style.display = 'none'; }, 3000);
            } else {
              countdown.textContent = remaining;
            }
          }, 1000);
        } catch (e) {
          sendBtn.disabled = false;
          showError(String(e.message || e));
        }
      });

      undoBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/draft/' + encodeURIComponent(draftId) + '/send/cancel', {
            method: 'POST',
          });
          const j = await res.json();
          if (countdownTimer) clearInterval(countdownTimer);
          if (j.cancelled) {
            banner.style.display = 'none';
            actions.style.display = 'flex';
            sendBtn.disabled = false;
          } else {
            banner.innerHTML = '<span style="color:#f85149;">Too late — already sent.</span>';
          }
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      editBtn.addEventListener('click', async () => {
        try {
          await saveBody();
          const url = 'https://mail.google.com/mail/u/' + encodeURIComponent(account) + '/#drafts?compose=' + encodeURIComponent(draftId);
          window.open(url, '_blank');
        } catch (e) {
          showError(String(e.message || e));
        }
      });

      archiveBtn.addEventListener('click', () => {
        // Existing archive pathway: Telegram callback handles it; close mini-app.
        window.close();
      });
    })();
  </script>
  `;
}
```

- [ ] **Step 2: Remove any remaining `as any` casts in `src/mini-app/server.ts`**

In the `/reply/:draftId` route you added in Task 6, the `renderEmailFull` call should now type-check cleanly. Remove any temporary `as any` casts introduced in Task 6.

- [ ] **Step 3: Update existing template test**

Open `src/__tests__/mini-app-server.test.ts`. The existing test calls `renderEmailFull(...)` without `mode` — this should still work (default is `'view'`). Confirm by running:

Run: `npx vitest run src/__tests__/mini-app-server.test.ts`
Expected: PASS (no changes needed to that file).

- [ ] **Step 4: Run full build + related tests**

Run: `npm run build && npx vitest run src/mini-app/ src/__tests__/mini-app-draft-send-routes.test.ts src/__tests__/mini-app-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mini-app/templates/email-full.ts src/mini-app/server.ts
git commit -m "feat(mini-app): add reply mode with textarea, Send, Undo, Edit-in-Gmail"
```

---

## Task 8: Callback-router picks `/reply` when a draft exists

**Files:**
- Modify: `src/callback-router.ts`
- Test: `src/__tests__/callback-router.test.ts`

- [ ] **Step 1: Explore the existing callback**

Run: `grep -n "Full Email\|email-full\|/email/\|/reply/" src/callback-router.ts`

Identify the handler that currently builds the "Full Email" URL (likely uses the MINI_APP_URL constant + `/email/:emailId`).

- [ ] **Step 2: Write the failing test**

Open `src/__tests__/callback-router.test.ts`. Append a test that verifies the URL selection:

```ts
it('uses /reply/:draftId URL when a draft exists for the email', () => {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS draft_originals (
    draft_id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    original_body TEXT NOT NULL,
    enriched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  // Seed a mapping: draft-for-email-X
  db.prepare(
    `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'draft-for-email-X',
    'personal',
    '',
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
  // The router needs a way to find "draft associated with thread/email". Use the function you expose.
  // Replace `resolveFullEmailUrl` below with whatever the router exports for URL selection.
  const url = resolveFullEmailUrl({
    emailId: 'email-X',
    threadId: 'thread-X',
    account: 'personal',
    draftIdForThread: 'draft-for-email-X', // resolved upstream; router just picks
  });
  expect(url).toMatch(/\/reply\/draft-for-email-X\?account=personal/);
});

it('uses /email/:emailId URL when no draft exists', () => {
  const url = resolveFullEmailUrl({
    emailId: 'email-Y',
    threadId: 'thread-Y',
    account: 'personal',
    draftIdForThread: null,
  });
  expect(url).toMatch(/\/email\/email-Y\?account=personal/);
});
```

(Imports at top: `import { resolveFullEmailUrl } from '../callback-router.js'; import { getDb } from '../db.js';`)

- [ ] **Step 3: Run test to confirm it fails**

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: FAIL — `resolveFullEmailUrl` is not exported.

- [ ] **Step 4: Implement `resolveFullEmailUrl`**

In `src/callback-router.ts`, add at the top (after existing imports):

```ts
import { MINI_APP_URL } from './config.js';

export interface FullEmailUrlInput {
  emailId: string;
  threadId: string;
  account: string;
  draftIdForThread: string | null;
}

export function resolveFullEmailUrl(input: FullEmailUrlInput): string {
  const base = (MINI_APP_URL || '').replace(/\/$/, '');
  if (input.draftIdForThread) {
    return `${base}/reply/${encodeURIComponent(input.draftIdForThread)}?account=${encodeURIComponent(input.account)}`;
  }
  return `${base}/email/${encodeURIComponent(input.emailId)}?account=${encodeURIComponent(input.account)}`;
}
```

Then in the existing "Full Email" callback handler, replace the inline URL construction with a call to `resolveFullEmailUrl(...)`. The caller needs to query `draft_originals` by threadId to find any associated draft:

```ts
const draftRow = getDb()
  .prepare(
    'SELECT draft_id FROM draft_originals WHERE account = ? AND draft_id IN (SELECT draft_id FROM drafts_by_thread WHERE thread_id = ?)',
  )
  .get(account, threadId) as { draft_id: string } | undefined;
// If there's no drafts_by_thread table, query drafts directly:
// const draftRow = getDb()
//   .prepare('SELECT draft_id FROM draft_originals WHERE account = ? LIMIT 1')
//   .get(account) as { draft_id: string } | undefined;
const draftIdForThread = draftRow?.draft_id ?? null;
const url = resolveFullEmailUrl({ emailId, threadId, account, draftIdForThread });
```

**Note:** `draft_originals` is keyed by `draft_id` only. If there is no existing `thread_id → draft_id` mapping in the schema, use the `draft-enrichment` store's API instead — specifically the `getDraftIdForThread(threadId, account)` helper if it exists. If it does not, add a minimal helper in `src/draft-enrichment.ts` that SELECTs by the draft's stored threadId after extending the `draft_originals` table with a `thread_id` column (backward-compatible ALTER + COALESCE lookup). If this is too invasive, fall back to calling `gmailOps.listRecentDrafts(account)` and filtering by threadId on each callback — acceptable since this is human-initiated and infrequent.

**Decision gate:** Before writing code, run `grep -n "thread_id\|threadId" src/draft-enrichment.ts src/db.ts` and pick the least-invasive option. Document the choice in the commit message.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/__tests__/callback-router.test.ts && npm run build`
Expected: PASS + clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/callback-router.ts src/__tests__/callback-router.test.ts src/draft-enrichment.ts src/db.ts
git commit -m "feat(callback-router): route Full Email to /reply/:draftId when a draft exists"
```

---

## Task 9: SIGTERM/SIGINT handler + send_failed subscriber in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add registry shutdown wiring**

Open `src/index.ts`. Find where `startMiniAppServer(...)` is called. Change it to capture the returned object (which now includes `registry`):

```ts
const miniApp = startMiniAppServer({
  port: MINI_APP_PORT,
  gmailOps,
  eventBus,
});
// miniApp now: { server: http.Server, registry: PendingSendRegistry }
```

Find the existing SIGTERM / SIGINT handlers (there should already be shutdown handlers). Inside each, BEFORE any other cleanup, add:

```ts
try {
  miniApp.registry.shutdown();
} catch (err) {
  logger.warn({ err }, 'Failed to shutdown pending-send registry');
}
```

If there are NO existing signal handlers (unlikely but possible), add minimal ones:

```ts
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info({ signal: sig }, 'Shutdown signal received');
    try {
      miniApp.registry.shutdown();
    } catch (err) {
      logger.warn({ err }, 'Failed to shutdown pending-send registry');
    }
    process.exit(0);
  });
}
```

- [ ] **Step 2: Subscribe to `email.draft.send_failed`**

In the same file, after `eventBus` is created and after `pushManager` (or equivalent Telegram notifier) is initialized, add:

```ts
eventBus.on('email.draft.send_failed', async (event) => {
  const msg =
    '❌ Couldn\'t send reply' +
    (event.subject ? ` to *${event.subject}*` : '') +
    ` — ${event.error}`;
  try {
    // Replace with whatever the project's Telegram notifier API is.
    // Example: await pushManager.pushToMain(msg);
    await pushManager.pushToMain(msg);
  } catch (err) {
    logger.error({ err, event }, 'Failed to push send_failed notification');
  }
});
```

**Decision gate:** if `pushManager.pushToMain` is not the real API, use whatever function sends text to the user's main Telegram group. Search with: `grep -rn "pushManager\.\|pushToMain\|sendToMain\|main group" src/ | head -10`.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 4: Smoke run**

Run: `npx tsx -e "import('./src/mini-app/pending-send.js').then(m => { const r = new m.PendingSendRegistry(); r.schedule('d1','acct',100, async () => console.log('fired')); r.shutdown(); console.log('done'); });"`
Expected: output `done` with NO `fired` line (shutdown prevented fire). If `fired` appears, shutdown logic is broken.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(mini-app): wire pending-send shutdown + send_failed notification"
```

---

## Task 10: Integration test — full save/send/cancel flow

**Files:**
- Test: `src/__tests__/mini-app-send-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/__tests__/mini-app-send-integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { _initTestDatabase, getDb } from '../db.js';
import { EventBus } from '../event-bus.js';
import type { GmailOps } from '../gmail-ops.js';
import { startMiniAppServer } from '../mini-app/server.js';

function seedDraft(draftId: string, account: string) {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS draft_originals (
    draft_id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    original_body TEXT NOT NULL,
    enriched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    draftId,
    account,
    '',
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
}

describe('mini-app send flow (integration)', () => {
  let app: express.Express;
  let gmailOps: GmailOps;
  let eventBus: EventBus;
  let capturedEvents: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();
    capturedEvents = [];
    gmailOps = {
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue(''),
      getDraftReplyContext: vi.fn().mockResolvedValue({
        body: 'body',
        incoming: {
          from: 'a@x.com',
          to: 'me@x.com',
          subject: 's',
          date: 'd',
        },
      }),
      sendDraft: vi.fn().mockResolvedValue(undefined),
    };
    eventBus = new EventBus();
    eventBus.on('email.draft.send_failed', (e) => capturedEvents.push(e));
    app = startMiniAppServer({
      port: 0,
      gmailOps,
      eventBus,
      returnAppOnly: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as express.Express;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('save → send → cancel within window: sendDraft never called', async () => {
    seedDraft('d1', 'personal');
    await request(app).patch('/api/draft/d1/save').send({ body: 'edited' });
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(9000);
    const cancel = await request(app).post('/api/draft/d1/send/cancel').send();
    expect(cancel.body.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    expect(gmailOps.updateDraft).toHaveBeenCalledWith(
      'personal',
      'd1',
      'edited',
    );
  });

  it('save → send → 10s elapses: sendDraft called once', async () => {
    seedDraft('d1', 'personal');
    await request(app).patch('/api/draft/d1/save').send({ body: 'edited' });
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gmailOps.sendDraft).toHaveBeenCalledTimes(1);
    expect(gmailOps.sendDraft).toHaveBeenCalledWith('personal', 'd1');
  });

  it('sendDraft failure emits email.draft.send_failed event', async () => {
    seedDraft('d1', 'personal');
    (gmailOps.sendDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('gmail down'),
    );
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(10_000);
    // Allow the microtask chain inside the registry's onFire catch to run.
    await vi.advanceTimersByTimeAsync(0);
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({
      type: 'email.draft.send_failed',
      draftId: 'd1',
      account: 'personal',
      error: 'gmail down',
    });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/mini-app-send-integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/mini-app-send-integration.test.ts
git commit -m "test(mini-app): add integration test for save/send/cancel flow"
```

---

## Task 11: Full test suite + build

**Files:** none

- [ ] **Step 1: Run full type-check**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all new tests pass. Pre-existing failures in `src/llm/mcp-bridge.test.ts` (missing package) are unrelated to this work; leave them alone.

- [ ] **Step 3: Manual smoke checklist (for the human operator)**

Document this for whoever deploys. Do not attempt from inside the subagent.

1. Start dev server: `npm run dev`.
2. Send yourself a test email. Wait for the agent to draft a reply (visible in Telegram as an "Email · FYI" card with a draft).
3. Tap "Full Email" in Telegram → confirm the mini-app opens at a URL containing `/reply/<draftId>` (not `/email/<emailId>`).
4. Confirm the page shows an editable textarea prefilled with the agent's draft body.
5. Make a small edit. Tap Send → Undo within 5 seconds → confirm the banner clears and no new entry appears in the Gmail Sent folder.
6. Tap Send → wait 10 seconds → confirm the email appears in the Gmail Sent folder and the banner shows "Sent."
7. Tap "Edit in Gmail" → confirm Gmail opens a compose tab with the edited body.
8. Kill nanoclaw mid-10s window → restart → confirm no send occurred.

- [ ] **Step 4: No commit needed — this is verification only.**

---

## Self-Review

Checking this plan against the spec at `docs/superpowers/specs/2026-04-16-miniapp-reply-send-design.md`:

**Spec coverage:**

| Spec requirement | Task |
|------------------|------|
| `PendingSendRegistry` class with schedule/cancel/has/shutdown | Task 1 |
| `onFire` rejection caught, logged, event emitted | Task 1 + Task 6 + Task 10 |
| `email.draft.send_failed` event type | Task 2 |
| `getDraftReplyContext` + `sendDraft` on interfaces | Task 3 |
| Gmail channel impl of both | Task 4 |
| `GmailOpsRouter` routing | Task 5 |
| `GET /reply/:draftId` render route | Task 6 |
| `PATCH /api/draft/:draftId/save` | Task 6 |
| `POST /api/draft/:draftId/send` (10s delay) | Task 6 |
| `POST /api/draft/:draftId/send/cancel` | Task 6 |
| Error response shape `{ ok, error, code }` | Task 6 |
| Structured pino logs with fields | Task 6 |
| Template: textarea + Send/Edit-in-Gmail/Archive + undo banner + inline JS | Task 7 |
| Callback-router picks /reply vs /email | Task 8 |
| SIGTERM/SIGINT → `registry.shutdown()` | Task 9 |
| Event-bus subscriber → Telegram push | Task 9 |
| Integration tests for save/send/cancel | Task 10 |
| Manual smoke checklist | Task 11 |

**Coverage gaps:** none material. The spec's "Draft deleted in Gmail between save and send" edge case is covered by Task 4's 404 handling in `getDraftReplyContext` (null return) and Task 9's `send_failed` notification when `sendDraft` itself fails with 404.

**Placeholder scan:** The plan has two decision gates (Task 8 step 4, Task 9 step 2) where the implementer must search the codebase for the right helper/API. Both include the exact grep command to run — not a placeholder, a bounded investigation.

**Type consistency:** Checked — `PendingSendRegistry.schedule(draftId, account, delayMs, onFire)` matches across Tasks 1, 6, 10. `getDraftReplyContext(account, draftId)` and `sendDraft(account, draftId)` match across Tasks 3, 4, 5, 6. `DraftReplyContext` shape matches everywhere. Event type `email.draft.send_failed` with fields `{ draftId, account, subject?, threadId?, error }` matches Tasks 2, 6, 9, 10.

---

## Execution Handoff

Plan complete. Save location: `docs/superpowers/plans/2026-04-16-miniapp-reply-send.md`.

Recommended: subagent-driven execution, one task per subagent with spec + quality review between tasks.
