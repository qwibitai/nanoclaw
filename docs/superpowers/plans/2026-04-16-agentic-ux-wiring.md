# Agentic UX Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Phase 1 agentic UX modules to real Gmail APIs and complete end-to-end flows for archive, email preview, and draft enrichment.

**Architecture:** Narrow `GmailOps` interface exposed by `GmailChannel`, routed by `GmailOpsRouter` (account alias → channel instance). Consumers (`ArchiveTracker`, `DraftEnrichmentWatcher`, callback router, email preview) depend only on the interface, not the full channel.

**Tech Stack:** TypeScript, googleapis (`gmail_v1`), Express 5, grammy (Telegram), better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-04-16-agentic-ux-wiring-design.md`

---

### File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/gmail-ops.ts` | Create | `GmailOps` interface + `GmailOpsRouter` class |
| `src/__tests__/gmail-ops.test.ts` | Create | Unit tests for GmailOpsRouter |
| `src/channels/gmail.ts` | Modify | Add 4 methods (`archiveThread`, `listRecentDrafts`, `updateDraft`, `getMessageBody`), make `extractTextBody` public |
| `src/__tests__/gmail-channel-ops.test.ts` | Create | Unit tests for new GmailChannel methods |
| `src/callback-router.ts` | Modify | Add async, expand with 6 new actions, add `gmailOps` + `draftWatcher` deps |
| `src/__tests__/callback-router.test.ts` | Modify | Tests for new callback actions |
| `src/router.ts` | Modify | Truncate email body + attach actions in `classifyAndFormat` |
| `src/router.test.ts` | Modify | Test email truncation in pipeline |
| `src/index.ts` | Modify | Wire `GmailOpsRouter`, draft watcher, archive event listener, "archive all" intercept |
| `src/__tests__/archive-flow.test.ts` | Create | End-to-end archive flow tests |
| `src/mini-app/server.ts` | Modify | Add `/email/:emailId`, `/draft-diff/:draftId`, `/api/draft/:draftId/revert` routes |
| `src/mini-app/templates/draft-diff.ts` | Create | Dark-themed diff view template |
| `src/__tests__/mini-app-routes.test.ts` | Create | Tests for new Mini App routes |

---

### Task 1: GmailOps Interface and Router

**Files:**
- Create: `src/gmail-ops.ts`
- Create: `src/__tests__/gmail-ops.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/gmail-ops.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GmailOpsRouter } from '../gmail-ops.js';
import type { DraftInfo } from '../draft-enrichment.js';

describe('GmailOpsRouter', () => {
  function makeMockChannel(alias: string) {
    return {
      name: `gmail-${alias}`,
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([] as DraftInfo[]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Hello world'),
    };
  }

  it('routes archiveThread to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    router.register('personal', channel as any);

    await router.archiveThread('personal', 'thread123');
    expect(channel.archiveThread).toHaveBeenCalledWith('thread123');
  });

  it('routes listRecentDrafts to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('dev');
    router.register('dev', channel as any);

    await router.listRecentDrafts('dev');
    expect(channel.listRecentDrafts).toHaveBeenCalled();
  });

  it('routes getMessageBody to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('personal');
    router.register('personal', channel as any);

    const body = await router.getMessageBody('personal', 'msg456');
    expect(body).toBe('Hello world');
    expect(channel.getMessageBody).toHaveBeenCalledWith('msg456');
  });

  it('throws for unknown account', async () => {
    const router = new GmailOpsRouter();
    await expect(router.archiveThread('unknown', 'thread1')).rejects.toThrow(
      'No Gmail channel registered for account: unknown',
    );
  });

  it('routes updateDraft to the correct channel', async () => {
    const router = new GmailOpsRouter();
    const channel = makeMockChannel('attaxion');
    router.register('attaxion', channel as any);

    await router.updateDraft('attaxion', 'draft789', 'new body');
    expect(channel.updateDraft).toHaveBeenCalledWith('draft789', 'new body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gmail-ops.test.ts`
Expected: FAIL — `gmail-ops.js` does not exist

- [ ] **Step 3: Write the GmailOps interface and GmailOpsRouter**

```typescript
// src/gmail-ops.ts
import type { DraftInfo } from './draft-enrichment.js';

/**
 * Narrow interface for Gmail API operations.
 * Decouples consumers from the full GmailChannel.
 */
export interface GmailOps {
  archiveThread(account: string, threadId: string): Promise<void>;
  listRecentDrafts(account: string): Promise<DraftInfo[]>;
  updateDraft(
    account: string,
    draftId: string,
    newBody: string,
  ): Promise<void>;
  getMessageBody(
    account: string,
    messageId: string,
  ): Promise<string | null>;
}

/**
 * Each registered channel must implement these methods.
 * This is the contract GmailChannel will satisfy.
 */
export interface GmailOpsProvider {
  archiveThread(threadId: string): Promise<void>;
  listRecentDrafts(): Promise<DraftInfo[]>;
  updateDraft(draftId: string, newBody: string): Promise<void>;
  getMessageBody(messageId: string): Promise<string | null>;
}

/**
 * Routes GmailOps calls to the correct GmailChannel by account alias.
 */
export class GmailOpsRouter implements GmailOps {
  private channels = new Map<string, GmailOpsProvider>();

  register(alias: string, channel: GmailOpsProvider): void {
    this.channels.set(alias, channel);
  }

  private getChannel(account: string): GmailOpsProvider {
    const ch = this.channels.get(account);
    if (!ch)
      throw new Error(
        `No Gmail channel registered for account: ${account}`,
      );
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gmail-ops.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/gmail-ops.ts src/__tests__/gmail-ops.test.ts
git commit -m "feat(ux): add GmailOps interface and GmailOpsRouter"
```

---

### Task 2: GmailChannel — Add GmailOps Methods

**Files:**
- Modify: `src/channels/gmail.ts` (add 4 methods, make `extractTextBody` public)
- Create: `src/__tests__/gmail-channel-ops.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/gmail-channel-ops.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the methods by constructing a GmailChannel with a mocked gmail client.
// Since GmailChannel requires OAuth setup in connect(), we test the methods
// by directly setting the private gmail field via Object.assign.

describe('GmailChannel Gmail Ops methods', () => {
  // Mock gmail_v1.Gmail
  function makeMockGmail() {
    return {
      users: {
        threads: {
          modify: vi.fn().mockResolvedValue({}),
        },
        drafts: {
          list: vi.fn().mockResolvedValue({
            data: {
              drafts: [{ id: 'draft1', message: { threadId: 'thread1' } }],
            },
          }),
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'draft1',
              message: {
                threadId: 'thread1',
                internalDate: String(Date.now()),
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Test Subject' },
                    { name: 'To', value: 'user@example.com' },
                    { name: 'From', value: 'me@example.com' },
                  ],
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Draft body text').toString('base64'),
                  },
                },
              },
            },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              payload: {
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Full message body').toString('base64'),
                },
              },
            },
          }),
          modify: vi.fn().mockResolvedValue({}),
        },
      },
    };
  }

  it('archiveThread calls threads.modify with removeLabelIds INBOX', async () => {
    // Dynamic import to avoid module-level issues
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      'personal',
    );
    const mockGmail = makeMockGmail();
    // Inject mock gmail client
    (channel as any).gmail = mockGmail;

    await channel.archiveThread('thread123');
    expect(mockGmail.users.threads.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'thread123',
      requestBody: { removeLabelIds: ['INBOX'] },
    });
  });

  it('listRecentDrafts returns DraftInfo array', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      'dev',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;
    (channel as any).accountAlias = 'dev';

    const drafts = await channel.listRecentDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      draftId: 'draft1',
      threadId: 'thread1',
      account: 'dev',
      subject: 'Test Subject',
      body: 'Draft body text',
    });
  });

  it('getMessageBody returns extracted text body', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      'personal',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;

    const body = await channel.getMessageBody('msg123');
    expect(body).toBe('Full message body');
    expect(mockGmail.users.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg123',
      format: 'full',
    });
  });

  it('updateDraft calls drafts.update with re-encoded body', async () => {
    const { GmailChannel } = await import('../channels/gmail.js');
    const channel = new GmailChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      'personal',
    );
    const mockGmail = makeMockGmail();
    (channel as any).gmail = mockGmail;

    await channel.updateDraft('draft1', 'New enriched body');
    expect(mockGmail.users.drafts.update).toHaveBeenCalled();
    const callArgs = mockGmail.users.drafts.update.mock.calls[0][0];
    expect(callArgs.userId).toBe('me');
    expect(callArgs.id).toBe('draft1');
    // The raw message should be base64url encoded
    expect(callArgs.requestBody.message.raw).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gmail-channel-ops.test.ts`
Expected: FAIL — `archiveThread` is not a function

- [ ] **Step 3: Add methods to GmailChannel**

In `src/channels/gmail.ts`, make `extractTextBody` public (change `private extractTextBody` to `extractTextBody` — remove the `private` keyword at line 349). Then add these 4 methods before the `extractTextBody` method (insert after line 348, before `extractTextBody`):

```typescript
  // --- GmailOps methods (satisfy GmailOpsProvider interface) ---

  async archiveThread(threadId: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');
    await this.gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    logger.info({ threadId, account: this.accountAlias }, 'Thread archived');
  }

  async listRecentDrafts(): Promise<import('../draft-enrichment.js').DraftInfo[]> {
    if (!this.gmail) throw new Error('Gmail not connected');
    const res = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults: 10,
    });
    const stubs = res.data.drafts || [];
    const drafts: import('../draft-enrichment.js').DraftInfo[] = [];

    for (const stub of stubs) {
      if (!stub.id) continue;
      try {
        const full = await this.gmail.users.drafts.get({
          userId: 'me',
          id: stub.id,
        });
        const msg = full.data.message;
        if (!msg) continue;

        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || '';

        drafts.push({
          draftId: stub.id,
          threadId: msg.threadId || '',
          account: this.accountAlias,
          subject: getHeader('Subject'),
          body: this.extractTextBody(msg.payload),
          createdAt: new Date(
            parseInt(msg.internalDate || '0', 10),
          ).toISOString(),
        });
      } catch (err) {
        logger.warn({ draftId: stub.id, err }, 'Failed to fetch draft details');
      }
    }
    return drafts;
  }

  async updateDraft(draftId: string, newBody: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');

    // Fetch existing draft to preserve headers
    const existing = await this.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
    });
    const msg = existing.data.message;
    const headers = msg?.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const rawMessage = [
      `To: ${getHeader('To')}`,
      `From: ${getHeader('From')}`,
      `Subject: ${getHeader('Subject')}`,
      getHeader('In-Reply-To')
        ? `In-Reply-To: ${getHeader('In-Reply-To')}`
        : '',
      getHeader('References')
        ? `References: ${getHeader('References')}`
        : '',
      'Content-Type: text/plain; charset=utf-8',
      '',
      newBody,
    ]
      .filter(Boolean)
      .join('\r\n');

    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await this.gmail.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: {
        message: { raw: encoded, threadId: msg?.threadId || undefined },
      },
    });
    logger.info(
      { draftId, account: this.accountAlias },
      'Draft updated with enriched body',
    );
  }

  async getMessageBody(messageId: string): Promise<string | null> {
    if (!this.gmail) return null;
    try {
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const body = this.extractTextBody(msg.data.payload);
      return body || null;
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to fetch message body');
      return null;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gmail-channel-ops.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/__tests__/gmail-channel-ops.test.ts
git commit -m "feat(ux): add GmailOps methods to GmailChannel"
```

---

### Task 3: Callback Router — Archive Two-Step and Email Expand/Collapse

**Files:**
- Modify: `src/callback-router.ts`
- Modify: `src/__tests__/callback-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/callback-router.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCallback } from '../callback-router.js';
import type { CallbackRouterDeps } from '../callback-router.js';

function makeDeps(): CallbackRouterDeps {
  return {
    archiveTracker: {
      markArchived: vi.fn(),
      getUnarchived: vi.fn().mockReturnValue([
        {
          email_id: 'email1',
          thread_id: 'thread1',
          account: 'personal',
          action_taken: 'replied',
          acted_at: new Date().toISOString(),
          archived_at: null,
        },
      ]),
      recordAction: vi.fn(),
    } as any,
    autoApproval: { cancel: vi.fn() } as any,
    statusBar: { removePendingItem: vi.fn() } as any,
    findChannel: vi.fn().mockReturnValue({
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
    }),
    gmailOps: {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Full email body here'),
    } as any,
    draftWatcher: {
      revert: vi.fn().mockResolvedValue(true),
    } as any,
  };
}

function makeQuery(data: string, messageId = 100) {
  return {
    id: 'q1',
    chatJid: 'telegram:123',
    messageId,
    data,
    senderName: 'User',
  };
}

describe('handleCallback (expanded)', () => {
  it('archive shows confirm/cancel buttons', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('archive:email1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({ callbackData: 'confirm_archive:email1' }),
        expect.objectContaining({ callbackData: 'cancel_archive:email1' }),
      ]),
    );
  });

  it('confirm_archive calls gmailOps.archiveThread and marks archived', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('confirm_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
    );
    expect(deps.archiveTracker.markArchived).toHaveBeenCalledWith(
      'email1',
      'replied',
    );
  });

  it('cancel_archive reverts buttons (no archive call)', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('cancel_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).not.toHaveBeenCalled();
  });

  it('expand fetches body and edits message with preview', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('expand:msg1:personal'), deps);
    expect(deps.gmailOps!.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg1',
    );
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('collapse edits message back to summary', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('collapse:msg1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('revert calls draftWatcher.revert and edits message', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('revert:draft1'), deps);
    expect(deps.draftWatcher!.revert).toHaveBeenCalledWith('draft1');
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('keep removes buttons', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('keep:draft1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      [],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: FAIL — `gmailOps` not in deps type, `handleCallback` not async, new actions not handled

- [ ] **Step 3: Rewrite callback-router.ts**

Replace the entire contents of `src/callback-router.ts`:

```typescript
import type { CallbackQuery, Channel, Action } from './types.js';
import type { ArchiveTracker } from './archive-tracker.js';
import type { AutoApprovalTimer } from './auto-approval.js';
import type { StatusBarManager } from './status-bar.js';
import type { GmailOps } from './gmail-ops.js';
import type { DraftEnrichmentWatcher } from './draft-enrichment.js';
import {
  truncatePreview,
  getCachedEmailBody,
  cacheEmailBody,
} from './email-preview.js';
import { logger } from './logger.js';

export interface CallbackRouterDeps {
  archiveTracker: ArchiveTracker;
  autoApproval: AutoApprovalTimer;
  statusBar: StatusBarManager;
  gmailOps?: GmailOps;
  draftWatcher?: DraftEnrichmentWatcher;
  findChannel: (jid: string) => (Channel & Record<string, any>) | undefined;
}

/**
 * Route callback queries from inline buttons to the appropriate handler.
 * Callback data format: "action:entityId" or "action:entityId:extra"
 */
export async function handleCallback(
  query: CallbackQuery,
  deps: CallbackRouterDeps,
): Promise<void> {
  const parts = query.data.split(':');
  const action = parts[0];
  const entityId = parts[1] || '';
  const extra = parts[2] || '';

  logger.debug(
    { action, entityId, extra, chatJid: query.chatJid },
    'Callback query received',
  );

  const channel = deps.findChannel(query.chatJid);

  try {
    switch (action) {
      case 'archive': {
        // Two-step: show confirm/cancel buttons
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '✅ Confirm Archive',
              callbackData: `confirm_archive:${entityId}`,
              style: 'destructive-safe',
            },
            {
              label: '❌ Cancel',
              callbackData: `cancel_archive:${entityId}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'confirm_archive': {
        // Look up email details from tracker
        const unarchived = deps.archiveTracker.getUnarchived();
        const email = unarchived.find((e) => e.email_id === entityId);
        if (email && deps.gmailOps) {
          await deps.gmailOps.archiveThread(email.account, email.thread_id);
          deps.archiveTracker.markArchived(entityId, email.action_taken);
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              '✅ Archived',
              [],
            );
          }
        }
        break;
      }

      case 'cancel_archive': {
        // Revert to original archive button
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, [
            {
              label: '🗄 Archive',
              callbackData: `archive:${entityId}`,
              style: 'secondary',
            },
          ]);
        }
        break;
      }

      case 'expand': {
        // entityId = messageId, extra = account
        const account = extra;
        let body = getCachedEmailBody(entityId);
        if (!body && deps.gmailOps && account) {
          body = await deps.gmailOps.getMessageBody(account, entityId);
          if (body) cacheEmailBody(entityId, body);
        }
        if (body && channel?.editMessageTextAndButtons) {
          const preview = truncatePreview(body, 800);
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            preview,
            [
              {
                label: '📧 Collapse',
                callbackData: `collapse:${entityId}`,
                style: 'secondary',
              },
              {
                label: '🌐 Full Email',
                callbackData: `noop:${entityId}`,
                webAppUrl: `/email/${entityId}?account=${account}`,
                style: 'secondary',
              },
              {
                label: '🗄 Archive',
                callbackData: `archive:${entityId}`,
                style: 'secondary',
              },
            ],
          );
        }
        break;
      }

      case 'collapse': {
        const body = getCachedEmailBody(entityId);
        if (body && channel?.editMessageTextAndButtons) {
          const summary = truncatePreview(body, 300);
          await channel.editMessageTextAndButtons(
            query.chatJid,
            query.messageId,
            summary,
            [
              {
                label: '📧 Expand',
                callbackData: `expand:${entityId}`,
                style: 'secondary',
              },
              {
                label: '🌐 Full Email',
                callbackData: `noop:${entityId}`,
                webAppUrl: `/email/${entityId}`,
                style: 'secondary',
              },
              {
                label: '🗄 Archive',
                callbackData: `archive:${entityId}`,
                style: 'secondary',
              },
            ],
          );
        }
        break;
      }

      case 'revert': {
        if (deps.draftWatcher) {
          const reverted = await deps.draftWatcher.revert(entityId);
          if (channel?.editMessageTextAndButtons) {
            await channel.editMessageTextAndButtons(
              query.chatJid,
              query.messageId,
              reverted ? '↩ Reverted to original' : '⚠️ Could not revert — original not found',
              [],
            );
          }
        }
        break;
      }

      case 'keep': {
        // Just remove buttons
        if (channel?.editMessageButtons) {
          await channel.editMessageButtons(query.chatJid, query.messageId, []);
        }
        break;
      }

      case 'answer': {
        const questionId = entityId;
        const answer = extra;
        if (answer === 'defer') {
          logger.info({ questionId }, 'Answer deferred');
        } else {
          deps.statusBar.removePendingItem(questionId);
        }
        break;
      }

      case 'stop':
        deps.autoApproval.cancel(entityId);
        break;

      case 'dismiss':
        deps.statusBar.removePendingItem(entityId);
        break;

      default:
        logger.warn({ action, data: query.data }, 'Unknown callback action');
    }
  } catch (err) {
    logger.error({ err, action, entityId }, 'Callback handler failed');
    if (channel?.editMessageTextAndButtons) {
      await channel.editMessageTextAndButtons(
        query.chatJid,
        query.messageId,
        `⚠️ ${action} failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        [],
      ).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/callback-router.test.ts`
Expected: All tests PASS (both old and new)

- [ ] **Step 5: Commit**

```bash
git add src/callback-router.ts src/__tests__/callback-router.test.ts
git commit -m "feat(ux): expand callback router with archive, expand/collapse, revert, keep actions"
```

---

### Task 4: Router Pipeline — Email Truncation and Action Attachment

**Files:**
- Modify: `src/router.ts` (update `classifyAndFormat`)
- Modify: `src/router.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyAndFormat } from './router.js';

describe('classifyAndFormat email truncation', () => {
  it('truncates email body to 300 chars and attaches expand/full/archive actions', () => {
    const longBody = 'A'.repeat(500);
    const emailText = `[Email [personal] from Alice <alice@example.com>]\nSubject: Test\n\n${longBody}`;

    const result = classifyAndFormat(emailText);
    expect(result.meta.category).toBe('email');
    // Body should be truncated
    expect(result.text.length).toBeLessThan(emailText.length);
    // Should have expand, full email, and archive actions
    const labels = result.meta.actions.map((a) => a.label);
    expect(labels).toContain('📧 Expand');
    expect(labels).toContain('🗄 Archive');
  });

  it('does not truncate short email bodies', () => {
    const emailText = `[Email from Bob <bob@test.com>]\nSubject: Short\n\nHi there`;
    const result = classifyAndFormat(emailText);
    expect(result.meta.category).toBe('email');
    // No truncation needed — no expand button
    const labels = result.meta.actions.map((a) => a.label);
    expect(labels).not.toContain('📧 Expand');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/router.test.ts`
Expected: FAIL — email actions not attached, text not truncated

- [ ] **Step 3: Update classifyAndFormat in router.ts**

In `src/router.ts`, add import for `truncatePreview` and update `classifyAndFormat`:

```typescript
import { Channel, NewMessage, MessageMeta } from './types.js';
import { formatLocalTime } from './timezone.js';
import { classifyMessage } from './message-classifier.js';
import { formatWithMeta } from './message-formatter.js';
import { detectQuestion } from './question-detector.js';
import { truncatePreview } from './email-preview.js';
```

Replace the `classifyAndFormat` function body (lines 125-150):

```typescript
export function classifyAndFormat(rawText: string): ClassifiedMessage {
  const text = stripInternalTags(rawText);
  if (!text)
    return {
      text: '',
      meta: {
        category: 'auto-handled',
        urgency: 'info',
        actions: [],
        batchable: true,
      },
    };

  const meta = classifyMessage(text);

  // Detect questions and attach buttons
  const question = detectQuestion(text);
  if (question) {
    meta.questionType = question.type;
    meta.questionId = question.questionId;
    meta.actions = [...meta.actions, ...question.actions];
  }

  let displayText = text;

  // Email preview: truncate body and attach expand/full/archive actions
  if (meta.category === 'email') {
    // Extract email ID from the text if available (format: message ID from Gmail)
    const emailIdMatch = text.match(/\[Email(?:\s*\[(\w+)\])?\s+from\s/);
    const account = emailIdMatch?.[1] || '';

    // Only truncate if body exceeds 300 chars
    // Find the body start (after the double newline following Subject:)
    const bodyStart = text.indexOf('\n\n');
    if (bodyStart !== -1 && text.length - bodyStart > 300) {
      const header = text.slice(0, bodyStart + 2);
      const body = text.slice(bodyStart + 2);
      displayText = header + truncatePreview(body, 300);

      // Store emailId on meta for downstream use
      if (meta.emailId) {
        meta.actions = [
          ...meta.actions,
          {
            label: '📧 Expand',
            callbackData: `expand:${meta.emailId}:${account}`,
            style: 'secondary' as const,
          },
          {
            label: '🗄 Archive',
            callbackData: `archive:${meta.emailId}`,
            style: 'secondary' as const,
          },
        ];
      }
    }
  }

  const formatted = formatWithMeta(displayText, meta);
  return { text: formatted, meta };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/router.test.ts
git commit -m "feat(ux): truncate email body and attach expand/archive actions in router pipeline"
```

---

### Task 5: Mini App — Email Route + Draft Diff + Revert API

**Files:**
- Modify: `src/mini-app/server.ts`
- Create: `src/mini-app/templates/draft-diff.ts`
- Create: `src/__tests__/mini-app-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/mini-app-routes.test.ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createMiniAppServer } from '../mini-app/server.js';

describe('Mini App extended routes', () => {
  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE task_detail_state (
        task_id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        steps_json TEXT DEFAULT '[]',
        log_json TEXT DEFAULT '[]',
        started_at TEXT
      );
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY,
        account TEXT,
        original_body TEXT,
        enriched_at TEXT,
        expires_at TEXT
      );
    `);

    const mockGmailOps = {
      getMessageBody: vi.fn().mockResolvedValue('Full email body for test'),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };

    const mockDraftWatcher = {
      revert: vi.fn().mockResolvedValue(true),
    };

    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockGmailOps as any,
      draftWatcher: mockDraftWatcher as any,
    });

    return { app, db, mockGmailOps, mockDraftWatcher };
  }

  it('GET /email/:emailId returns HTML with fetched body', async () => {
    const { app, mockGmailOps } = setup();
    const res = await request(app).get('/email/msg123?account=personal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Full email body for test');
    expect(mockGmailOps.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg123',
    );
  });

  it('GET /draft-diff/:draftId shows diff view', async () => {
    const { app, db } = setup();
    db.prepare(
      `INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('d1', 'personal', 'Original draft text', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());

    const res = await request(app).get('/draft-diff/d1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Original draft text');
  });

  it('POST /api/draft/:draftId/revert calls draftWatcher.revert', async () => {
    const { app, mockDraftWatcher } = setup();
    const res = await request(app).post('/api/draft/d1/revert');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDraftWatcher.revert).toHaveBeenCalledWith('d1');
  });

  it('GET /draft-diff/:draftId returns 404 if not found', async () => {
    const { app } = setup();
    const res = await request(app).get('/draft-diff/nonexistent');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: FAIL — routes don't exist, `supertest` may need installing

- [ ] **Step 3: Install supertest if missing**

Run: `npm install --save-dev supertest @types/supertest`

- [ ] **Step 4: Create draft-diff template**

```typescript
// src/mini-app/templates/draft-diff.ts

export interface DraftDiffData {
  draftId: string;
  account: string;
  originalBody: string;
  enrichedBody: string | null;
  enrichedAt: string;
}

export function renderDraftDiff(data: DraftDiffData): string {
  const escHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Draft Diff — ${escHtml(data.draftId)}</title>
  <style>
    body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, sans-serif; margin: 0; padding: 16px; }
    h2 { color: #a78bfa; margin-bottom: 4px; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 16px; }
    .diff-container { display: flex; gap: 12px; flex-wrap: wrap; }
    .diff-panel { flex: 1; min-width: 280px; background: #16213e; border-radius: 8px; padding: 12px; }
    .diff-panel h3 { margin-top: 0; font-size: 0.9rem; }
    .original h3 { color: #f87171; }
    .enriched h3 { color: #34d399; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; line-height: 1.5; }
    .btn { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #f87171; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; text-decoration: none; }
    .btn:hover { background: #ef4444; }
  </style>
</head>
<body>
  <h2>Draft Diff</h2>
  <div class="meta">${escHtml(data.account)} · enriched ${escHtml(data.enrichedAt)}</div>

  <div class="diff-container">
    <div class="diff-panel original">
      <h3>Original</h3>
      <pre>${escHtml(data.originalBody)}</pre>
    </div>
    <div class="diff-panel enriched">
      <h3>Enriched</h3>
      <pre>${data.enrichedBody ? escHtml(data.enrichedBody) : '<em>Could not load current draft</em>'}</pre>
    </div>
  </div>

  <button class="btn" onclick="revertDraft()">↩ Revert to Original</button>

  <script>
    async function revertDraft() {
      const res = await fetch('/api/draft/${data.draftId}/revert', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        document.querySelector('.btn').textContent = '✅ Reverted';
        document.querySelector('.btn').disabled = true;
      } else {
        alert('Failed to revert: ' + (json.error || 'unknown'));
      }
    }
  </script>
</body>
</html>`;
}
```

- [ ] **Step 5: Update Mini App server with new routes**

Replace `src/mini-app/server.ts`:

```typescript
import express from 'express';
import type Database from 'better-sqlite3';
import { renderTaskDetail } from './templates/task-detail.js';
import { renderEmailFull } from './templates/email-full.js';
import { renderDraftDiff } from './templates/draft-diff.js';
import { logger } from '../logger.js';
import { getCachedEmailBody, cacheEmailBody } from '../email-preview.js';
import type { GmailOps } from '../gmail-ops.js';
import type { DraftEnrichmentWatcher } from '../draft-enrichment.js';
import type { TaskStep, TaskLog } from './templates/task-detail.js';

export interface MiniAppServerOpts {
  port: number;
  db: Database.Database;
  gmailOps?: GmailOps;
  draftWatcher?: DraftEnrichmentWatcher;
}

export function createMiniAppServer(opts: MiniAppServerOpts): express.Express {
  const app = express();
  app.use(express.json());

  // --- Task detail routes (existing) ---

  app.get('/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId) as Record<string, string> | undefined;

    if (!row) {
      res.status(404).send('Task not found');
      return;
    }

    const html = renderTaskDetail({
      taskId: row.task_id,
      title: row.title,
      status: row.status as 'active' | 'blocked' | 'complete',
      steps: JSON.parse(row.steps_json) as TaskStep[],
      logs: JSON.parse(row.log_json) as TaskLog[],
      startedAt: row.started_at,
    });

    res.type('html').send(html);
  });

  // SSE endpoint for live task updates
  app.get('/api/task/:taskId/stream', (req, res) => {
    const { taskId } = req.params;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);
    if (row) {
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    }

    const intervalId = setInterval(() => {
      const current = opts.db
        .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
        .get(taskId) as Record<string, string> | undefined;
      if (current) {
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        if (current.status === 'complete') {
          res.write('event: complete\ndata: {}\n\n');
          clearInterval(intervalId);
          res.end();
        }
      }
    }, 2000);

    req.on('close', () => {
      clearInterval(intervalId);
    });
  });

  app.get('/api/task/:taskId/state', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);

    if (!row) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json(row);
  });

  // --- Email full view ---

  app.get('/email/:emailId', async (req, res) => {
    const { emailId } = req.params;
    const account = (req.query.account as string) || '';

    let body = getCachedEmailBody(emailId);
    if (!body && opts.gmailOps && account) {
      try {
        body = await opts.gmailOps.getMessageBody(account, emailId);
        if (body) cacheEmailBody(emailId, body);
      } catch (err) {
        logger.warn({ emailId, err }, 'Failed to fetch email body for Mini App');
      }
    }

    const html = renderEmailFull({
      emailId,
      subject: `Email ${emailId}`,
      from: '',
      to: '',
      date: '',
      body: body || 'Email body could not be loaded.',
      attachments: [],
    });

    res.type('html').send(html);
  });

  // --- Draft diff view ---

  app.get('/draft-diff/:draftId', (req, res) => {
    const { draftId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as
      | { account: string; original_body: string; enriched_at: string }
      | undefined;

    if (!row) {
      res.status(404).send('Draft not found');
      return;
    }

    const html = renderDraftDiff({
      draftId,
      account: row.account,
      originalBody: row.original_body,
      enrichedBody: null, // Current version is in Gmail — client can fetch if needed
      enrichedAt: row.enriched_at,
    });

    res.type('html').send(html);
  });

  // --- Draft revert API ---

  app.post('/api/draft/:draftId/revert', async (req, res) => {
    const { draftId } = req.params;
    if (!opts.draftWatcher) {
      res.status(503).json({ success: false, error: 'Draft watcher not configured' });
      return;
    }
    try {
      const success = await opts.draftWatcher.revert(draftId);
      res.json({ success });
    } catch (err) {
      logger.error({ draftId, err }, 'Draft revert failed');
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  return app;
}

export function startMiniAppServer(opts: MiniAppServerOpts): void {
  const app = createMiniAppServer(opts);
  app.listen(opts.port, () => {
    logger.info({ port: opts.port }, 'Mini App server started');
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/mini-app-routes.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/mini-app/server.ts src/mini-app/templates/draft-diff.ts src/__tests__/mini-app-routes.test.ts
git commit -m "feat(ux): add email view, draft diff, and revert API to Mini App"
```

---

### Task 6: Wire GmailOpsRouter + DraftEnrichmentWatcher in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports at top of index.ts**

After the existing imports (around line 1-50), add:

```typescript
import { GmailOpsRouter } from './gmail-ops.js';
import type { GmailOpsProvider } from './gmail-ops.js';
```

- [ ] **Step 2: Create GmailOpsRouter after channels connect**

In `src/index.ts`, after the channel connection loop (after line 1263 `if (channels.length === 0) { ... }`), before the `// --- Agentic UX initialization ---` comment at line 1269, add:

```typescript
  // --- GmailOps router: expose Gmail API operations to UX modules ---
  const gmailOpsRouter = new GmailOpsRouter();
  for (const ch of channels) {
    // Gmail channels have names like 'gmail', 'gmail-personal', 'gmail-dev'
    if (ch.name.startsWith('gmail')) {
      const alias = ch.name === 'gmail' ? 'default' : ch.name.replace('gmail-', '');
      // Only register if the channel implements GmailOps methods
      if ('archiveThread' in ch && 'listRecentDrafts' in ch) {
        gmailOpsRouter.register(alias, ch as unknown as GmailOpsProvider);
        logger.info({ alias }, 'Registered Gmail channel with GmailOpsRouter');
      }
    }
  }
```

- [ ] **Step 3: Wire DraftEnrichmentWatcher with real callbacks**

After the `archiveTracker` initialization (after line 1271), add:

```typescript
  // --- Draft enrichment watcher ---
  const enrichmentAccounts = channels
    .filter((ch) => ch.name.startsWith('gmail') && 'listRecentDrafts' in ch)
    .map((ch) => ch.name === 'gmail' ? 'default' : ch.name.replace('gmail-', ''));

  let draftWatcher: import('./draft-enrichment.js').DraftEnrichmentWatcher | undefined;
  if (enrichmentAccounts.length > 0) {
    const { DraftEnrichmentWatcher } = await import('./draft-enrichment.js');
    draftWatcher = new DraftEnrichmentWatcher(eventBus, getDb(), {
      accounts: enrichmentAccounts,
      listRecentDrafts: (account) => gmailOpsRouter.listRecentDrafts(account),
      updateDraft: (account, draftId, newBody) =>
        gmailOpsRouter.updateDraft(account, draftId, newBody),
      evaluateEnrichment: async (draft) => {
        // Heuristic: only enrich short stubs (likely auto-replies)
        if (draft.body.length > 200) return null;
        // Skip old drafts (>30 min) — user may be editing
        const ageMs = Date.now() - new Date(draft.createdAt).getTime();
        if (ageMs > 30 * 60 * 1000) return null;
        // For now, return null (no enrichment) until executor pool integration
        // TODO: Submit to executor pool with enrichment prompt
        logger.debug({ draftId: draft.draftId }, 'Draft eligible for enrichment (not yet wired to executor)');
        return null;
      },
    });
    draftWatcher.start();
    logger.info({ accounts: enrichmentAccounts }, 'Draft enrichment watcher started');
  }
```

- [ ] **Step 4: Wire email.action.completed listener**

After the draft watcher setup, add:

```typescript
  // --- Archive flow: record email actions for later cleanup ---
  eventBus.on('email.action.completed', (event) => {
    archiveTracker.recordAction(
      event.payload.emailId,
      event.payload.threadId,
      event.payload.account,
      event.payload.action,
    );
  });
```

- [ ] **Step 5: Wire gmailOps and draftWatcher into callback router deps**

Update the callback handler registration (around line 1328) to include the new deps:

Replace:
```typescript
      handleCallback(query, {
        archiveTracker,
        autoApproval,
        statusBar,
        findChannel: (jid) => findChannel(channels, jid),
      });
```

With:
```typescript
      handleCallback(query, {
        archiveTracker,
        autoApproval,
        statusBar,
        gmailOps: gmailOpsRouter,
        draftWatcher,
        findChannel: (jid) => findChannel(channels, jid),
      });
```

- [ ] **Step 6: Wire gmailOps and draftWatcher into Mini App server**

Update the `startMiniAppServer` call (around line 1338) to include new deps:

Replace:
```typescript
  startMiniAppServer({
    port: Number(process.env.MINI_APP_PORT) || 3847,
    db: getDb(),
  });
```

With:
```typescript
  startMiniAppServer({
    port: Number(process.env.MINI_APP_PORT) || 3847,
    db: getDb(),
    gmailOps: gmailOpsRouter,
    draftWatcher,
  });
```

- [ ] **Step 7: Add draft enrichment notification listener**

After the draft watcher start, add a listener for enriched drafts:

```typescript
  // --- Notify on draft enrichment ---
  eventBus.on('email.draft.enriched', (event) => {
    if (!mainGroupEntry) return;
    const [mainJid] = mainGroupEntry;
    const channel = findChannel(channels, mainJid);
    const text = `✏️ Draft enriched: "${event.payload.changes}"`;
    const actions = [
      { label: '↩ Revert', callbackData: `revert:${event.payload.draftId}`, style: 'secondary' as const },
      { label: '✅ Keep', callbackData: `keep:${event.payload.draftId}`, style: 'primary' as const },
    ];
    channel?.sendMessageWithActions?.(mainJid, text, actions).catch(() => {});
  });
```

- [ ] **Step 8: Run build to verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat(ux): wire GmailOpsRouter, draft enrichment, and archive events into startup"
```

---

### Task 7: "Archive All" Text Command Intercept

**Files:**
- Modify: `src/index.ts`
- Create: `src/__tests__/archive-flow.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/archive-flow.test.ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ArchiveTracker } from '../archive-tracker.js';

describe('Archive all flow', () => {
  it('archiveTracker.getUnarchived returns unarchived emails', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY,
        thread_id TEXT,
        account TEXT,
        action_taken TEXT,
        acted_at TEXT,
        archived_at TEXT
      )
    `);
    const tracker = new ArchiveTracker(db);

    tracker.recordAction('e1', 't1', 'personal', 'replied');
    tracker.recordAction('e2', 't2', 'dev', 'delegated');
    tracker.markArchived('e1', 'replied');

    const unarchived = tracker.getUnarchived();
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].email_id).toBe('e2');
  });

  it('batch archive iterates unarchived and marks each', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY,
        thread_id TEXT,
        account TEXT,
        action_taken TEXT,
        acted_at TEXT,
        archived_at TEXT
      )
    `);
    const tracker = new ArchiveTracker(db);
    tracker.recordAction('e1', 't1', 'personal', 'replied');
    tracker.recordAction('e2', 't2', 'dev', 'delegated');

    const mockArchive = vi.fn().mockResolvedValue(undefined);

    const unarchived = tracker.getUnarchived();
    let archived = 0;
    for (const email of unarchived) {
      await mockArchive(email.account, email.thread_id);
      tracker.markArchived(email.email_id, email.action_taken);
      archived++;
    }

    expect(archived).toBe(2);
    expect(mockArchive).toHaveBeenCalledTimes(2);
    expect(tracker.getUnarchived()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (these test existing functionality)

Run: `npx vitest run src/__tests__/archive-flow.test.ts`
Expected: PASS — validates archive tracker logic is correct

- [ ] **Step 3: Add "archive all" intercept in index.ts**

Find the inbound message handler in `index.ts`. The message processing happens in the `onMessage` callback passed to channel opts. Look for where `channelOpts` is defined (search for `onMessage:` in the file). Inside the `onMessage` handler, before messages are queued for the agent, add:

```typescript
    // "Archive all" command — intercept before agent dispatch
    if (
      msgs.length === 1 &&
      msgs[0].content.trim().toLowerCase() === 'archive all'
    ) {
      const unarchived = archiveTracker.getUnarchived();
      if (unarchived.length === 0) {
        const channel = findChannel(channels, chatJid);
        await channel?.sendMessage(chatJid, '✅ No emails to archive');
        return;
      }
      let archived = 0;
      for (const email of unarchived) {
        try {
          await gmailOpsRouter.archiveThread(email.account, email.thread_id);
          archiveTracker.markArchived(email.email_id, email.action_taken);
          archived++;
        } catch (err) {
          logger.error(
            { err, emailId: email.email_id },
            'Failed to archive email',
          );
        }
      }
      const channel = findChannel(channels, chatJid);
      await channel?.sendMessage(
        chatJid,
        `✅ Archived ${archived}/${unarchived.length} threads`,
      );
      return;
    }
```

Note: The exact insertion point depends on how the message handler is structured. The key is this check must happen BEFORE the agent is invoked. Look for the section where `onMessage` processes new messages and insert this right after the trigger check but before `queue.enqueue`.

- [ ] **Step 4: Run build to verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/__tests__/archive-flow.test.ts
git commit -m "feat(ux): add 'archive all' text command intercept for batch email archiving"
```

---

### Task 8: Integration Test — End-to-End Wiring Verification

**Files:**
- Create: `src/__tests__/agentic-ux-wiring-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// src/__tests__/agentic-ux-wiring-integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GmailOpsRouter } from '../gmail-ops.js';
import { ArchiveTracker } from '../archive-tracker.js';
import { handleCallback } from '../callback-router.js';
import { classifyAndFormat } from '../router.js';
import { createMiniAppServer } from '../mini-app/server.js';

describe('Agentic UX wiring integration', () => {
  it('full archive flow: classify email → callback archive → confirm → Gmail API', async () => {
    // 1. Classify an email message
    const emailText = `[Email [personal] from Alice <alice@test.com>]\nSubject: Invoice\n\n${'Payment details '.repeat(30)}`;
    const classified = classifyAndFormat(emailText);
    expect(classified.meta.category).toBe('email');

    // 2. Set up archive tracker
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY, thread_id TEXT, account TEXT,
        action_taken TEXT, acted_at TEXT, archived_at TEXT
      );
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY, account TEXT, original_body TEXT,
        enriched_at TEXT, expires_at TEXT
      );
      CREATE TABLE task_detail_state (
        task_id TEXT PRIMARY KEY, title TEXT, status TEXT,
        steps_json TEXT DEFAULT '[]', log_json TEXT DEFAULT '[]', started_at TEXT
      );
    `);
    const tracker = new ArchiveTracker(db);
    tracker.recordAction('msg1', 'thread1', 'personal', 'replied');

    // 3. Mock Gmail ops
    const mockGmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Full body'),
    };

    // 4. Simulate confirm_archive callback
    const mockChannel = {
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
    };

    await handleCallback(
      {
        id: 'q1',
        chatJid: 'telegram:123',
        messageId: 42,
        data: 'confirm_archive:msg1',
        senderName: 'User',
      },
      {
        archiveTracker: tracker,
        autoApproval: { cancel: vi.fn() } as any,
        statusBar: { removePendingItem: vi.fn() } as any,
        gmailOps: mockGmailOps,
        findChannel: () => mockChannel as any,
      },
    );

    // 5. Verify Gmail API was called and DB updated
    expect(mockGmailOps.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
    );
    expect(tracker.getUnarchived()).toHaveLength(0);
  });

  it('GmailOpsRouter dispatches to correct channel', async () => {
    const router = new GmailOpsRouter();
    const personalChannel = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('body'),
    };
    const devChannel = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('dev body'),
    };

    router.register('personal', personalChannel);
    router.register('dev', devChannel);

    await router.archiveThread('personal', 't1');
    await router.archiveThread('dev', 't2');

    expect(personalChannel.archiveThread).toHaveBeenCalledWith('t1');
    expect(devChannel.archiveThread).toHaveBeenCalledWith('t2');
    expect(personalChannel.archiveThread).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/__tests__/agentic-ux-wiring-integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (except the 4 pre-existing `mcp-bridge` failures)

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Clean build, zero errors

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/agentic-ux-wiring-integration.test.ts
git commit -m "test(ux): add end-to-end integration tests for agentic UX wiring"
```

---

### Summary

| Task | What it does |
|------|-------------|
| 1 | `GmailOps` interface + `GmailOpsRouter` — account-aware Gmail API routing |
| 2 | `GmailChannel` gets 4 new methods — `archiveThread`, `listRecentDrafts`, `updateDraft`, `getMessageBody` |
| 3 | Callback router expansion — archive 2-step, expand/collapse, revert/keep |
| 4 | Router pipeline — email body truncation + action attachment |
| 5 | Mini App — email view, draft diff, revert API |
| 6 | `index.ts` wiring — GmailOpsRouter, draft watcher, archive events, enrichment notifications |
| 7 | "Archive all" text command intercept |
| 8 | Integration tests — end-to-end verification |
